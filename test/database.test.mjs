import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublisherDatabase } from '../server/lib/database.mjs';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kdn-publisher-test-'));
  const database = new PublisherDatabase(path.join(directory, 'test.sqlite3'));
  return { directory, database };
}

test('invite can be redeemed once and produces a working session', () => {
  const { directory, database } = fixture();
  try {
    const token = database.createInvite({
      email: 'creator@example.com',
      label: 'Test Creator',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const first = database.redeemInvite({ email: 'creator@example.com', token, sessionTtlDays: 1 });
    assert.ok(first?.sessionToken);
    assert.equal(database.userFromSessionToken(first.sessionToken).email, 'creator@example.com');
    assert.equal(database.redeemInvite({ email: 'creator@example.com', token, sessionTtlDays: 1 }), null);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('identical asset and idempotency key cannot initialize twice', () => {
  const { directory, database } = fixture();
  try {
    const token = database.createInvite({
      email: 'creator@example.com',
      label: 'Test Creator',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const { user } = database.redeemInvite({ email: 'creator@example.com', token, sessionTtlDays: 1 });
    const upload = database.createUpload({
      userId: user.id,
      originalName: 'video.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10,
      durationSeconds: 12.5,
      sha256: 'A'.repeat(64),
      localPath: path.join(directory, 'video.mp4')
    });
    assert.equal(upload.duration_seconds, 12.5);
    const record = {
      userId: user.id,
      idempotencyKey: 'key-12345678901234567890',
      uploadId: upload.id,
      caption: 'Ein eigener Retro-Test',
      privacyLevel: 'SELF_ONLY',
      disableComment: false,
      disableDuet: false,
      disableStitch: false,
      isAigc: false,
      brandContentToggle: false,
      brandOrganicToggle: false,
      acceptedRights: true
    };
    const first = database.createOrGetIntent(record);
    const second = database.createOrGetIntent(record);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.intent.id, second.intent.id);

    const secondKey = database.createOrGetIntent({ ...record, idempotencyKey: 'key-09876543210987654321' });
    assert.equal(secondKey.created, false);
    assert.equal(secondKey.intent.id, first.intent.id);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
