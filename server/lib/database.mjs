import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { randomToken, safeEqualHex, sha256 } from './security.mjs';

function isoNow() {
  return new Date().toISOString();
}

export class PublisherDatabase {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_login_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        label TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        redeemed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS web_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS composio_sessions (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        duration_seconds REAL NOT NULL,
        sha256 TEXT NOT NULL,
        local_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, sha256)
      );
      CREATE TABLE IF NOT EXISTS publish_intents (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        upload_id TEXT NOT NULL REFERENCES uploads(id),
        caption TEXT NOT NULL,
        privacy_level TEXT NOT NULL,
        disable_comment INTEGER NOT NULL,
        disable_duet INTEGER NOT NULL,
        disable_stitch INTEGER NOT NULL,
        is_aigc INTEGER NOT NULL,
        brand_content_toggle INTEGER NOT NULL,
        brand_organic_toggle INTEGER NOT NULL,
        accepted_rights INTEGER NOT NULL,
        status TEXT NOT NULL,
        tiktok_username TEXT,
        publish_id TEXT,
        error_code TEXT,
        error_message TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, idempotency_key),
        UNIQUE(user_id, upload_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_hash ON web_sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_intents_publish_id ON publish_intents(publish_id);
    `);
    const uploadColumns = this.db.prepare('PRAGMA table_info(uploads)').all();
    if (!uploadColumns.some(column => column.name === 'duration_seconds')) {
      this.db.exec('ALTER TABLE uploads ADD COLUMN duration_seconds REAL;');
    }
  }

  createInvite({ email, label, expiresAt }) {
    const token = randomToken(24);
    const now = isoNow();
    this.db.prepare(`
      INSERT INTO invites (id, email, label, token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), email, label, sha256(token), now, expiresAt);
    return token;
  }

  redeemInvite({ email, token, sessionTtlDays }) {
    const now = isoNow();
    const candidateHash = sha256(token);
    const invite = this.db.prepare(`
      SELECT * FROM invites WHERE email = ? AND redeemed_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1
    `).get(email, now);
    if (!invite || !safeEqualHex(invite.token_hash, candidateHash)) return null;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      let user = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!user) {
        const userId = `usr_${crypto.randomUUID()}`;
        this.db.prepare(`
          INSERT INTO users (id, email, label, created_at, last_login_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(userId, email, invite.label, now, now);
        user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      } else {
        this.db.prepare('UPDATE users SET label = ?, last_login_at = ? WHERE id = ?').run(invite.label, now, user.id);
        user = { ...user, label: invite.label, last_login_at: now };
      }
      this.db.prepare('UPDATE invites SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL').run(now, invite.id);
      const sessionToken = randomToken(32);
      const expiresAt = new Date(Date.now() + sessionTtlDays * 86_400_000).toISOString();
      this.db.prepare(`
        INSERT INTO web_sessions (id, user_id, token_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), user.id, sha256(sessionToken), now, expiresAt);
      this.db.exec('COMMIT');
      return { user, sessionToken, expiresAt };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  userFromSessionToken(token) {
    if (!token) return null;
    return this.db.prepare(`
      SELECT users.id, users.email, users.label, web_sessions.expires_at
      FROM web_sessions JOIN users ON users.id = web_sessions.user_id
      WHERE web_sessions.token_hash = ? AND web_sessions.expires_at > ?
    `).get(sha256(token), isoNow()) || null;
  }

  revokeSession(token) {
    if (token) this.db.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(sha256(token));
  }

  getComposioSession(userId) {
    return this.db.prepare('SELECT session_id FROM composio_sessions WHERE user_id = ?').get(userId)?.session_id || null;
  }

  saveComposioSession(userId, sessionId) {
    const now = isoNow();
    this.db.prepare(`
      INSERT INTO composio_sessions (user_id, session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
    `).run(userId, sessionId, now, now);
  }

  findUploadByHash(userId, contentHash) {
    return this.db.prepare('SELECT * FROM uploads WHERE user_id = ? AND sha256 = ?').get(userId, contentHash) || null;
  }

  createUpload(record) {
    const id = `upl_${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO uploads (id, user_id, original_name, mime_type, size_bytes, duration_seconds, sha256, local_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, record.userId, record.originalName, record.mimeType, record.sizeBytes, record.durationSeconds, record.sha256, record.localPath, isoNow());
    return this.getUpload(record.userId, id);
  }

  setUploadDurationIfMissing(userId, uploadId, durationSeconds) {
    this.db.prepare(`
      UPDATE uploads SET duration_seconds = ?
      WHERE user_id = ? AND id = ? AND duration_seconds IS NULL
    `).run(durationSeconds, userId, uploadId);
    return this.getUpload(userId, uploadId);
  }

  getUpload(userId, uploadId) {
    return this.db.prepare('SELECT * FROM uploads WHERE user_id = ? AND id = ?').get(userId, uploadId) || null;
  }

  createOrGetIntent(record) {
    const existing = this.db.prepare(`
      SELECT * FROM publish_intents WHERE user_id = ? AND (idempotency_key = ? OR upload_id = ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(record.userId, record.idempotencyKey, record.uploadId);
    if (existing) return { intent: existing, created: false };
    const now = isoNow();
    const id = `pub_${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO publish_intents (
        id, user_id, idempotency_key, upload_id, caption, privacy_level,
        disable_comment, disable_duet, disable_stitch, is_aigc,
        brand_content_toggle, brand_organic_toggle, accepted_rights,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, record.userId, record.idempotencyKey, record.uploadId, record.caption, record.privacyLevel,
      Number(record.disableComment), Number(record.disableDuet), Number(record.disableStitch), Number(record.isAigc),
      Number(record.brandContentToggle), Number(record.brandOrganicToggle), Number(record.acceptedRights),
      'VALIDATING', now, now
    );
    return { intent: this.getIntent(record.userId, id), created: true };
  }

  getIntent(userId, intentId) {
    return this.db.prepare(`
      SELECT publish_intents.*, uploads.original_name, uploads.size_bytes, uploads.duration_seconds, uploads.sha256 AS asset_sha256
      FROM publish_intents JOIN uploads ON uploads.id = publish_intents.upload_id
      WHERE publish_intents.user_id = ? AND publish_intents.id = ?
    `).get(userId, intentId) || null;
  }

  updateIntent(userId, intentId, fields) {
    const allowed = new Set(['status', 'tiktok_username', 'publish_id', 'error_code', 'error_message', 'result_json']);
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    if (!entries.length) return this.getIntent(userId, intentId);
    const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
    const values = entries.map(([, value]) => value);
    values.push(isoNow(), userId, intentId);
    this.db.prepare(`UPDATE publish_intents SET ${assignments}, updated_at = ? WHERE user_id = ? AND id = ?`).run(...values);
    return this.getIntent(userId, intentId);
  }

  listIntents(userId, limit = 20) {
    return this.db.prepare(`
      SELECT publish_intents.id, publish_intents.caption, publish_intents.privacy_level,
             publish_intents.status, publish_intents.tiktok_username, publish_intents.publish_id,
             publish_intents.error_code, publish_intents.error_message, publish_intents.created_at,
             publish_intents.updated_at, uploads.original_name, uploads.size_bytes, uploads.duration_seconds, uploads.sha256 AS asset_sha256
      FROM publish_intents JOIN uploads ON uploads.id = publish_intents.upload_id
      WHERE publish_intents.user_id = ? ORDER BY publish_intents.created_at DESC LIMIT ?
    `).all(userId, limit);
  }

  purgeExpiredSessions() {
    this.db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(isoNow());
  }

  close() {
    this.db.close();
  }
}
