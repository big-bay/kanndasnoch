import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { config } from './lib/config.mjs';
import { PublisherDatabase } from './lib/database.mjs';
import { TikTokComposioService } from './lib/composio.mjs';
import {
  applySecurityHeaders,
  clearSessionCookie,
  createRateLimiter,
  httpError,
  parseCookies,
  readJson,
  sanitizeFileName,
  sessionCookie,
  validateCommercialContent,
  validateEmail
} from './lib/security.mjs';

const database = new PublisherDatabase(config.databasePath);
const tiktok = new TikTokComposioService(config, database);
const loginLimit = createRateLimiter({ windowMs: 15 * 60_000, maximum: 8 });
const mutationLimit = createRateLimiter({ windowMs: 60_000, maximum: 30 });
const terminalStatuses = new Set(['PUBLISH_COMPLETE', 'FAILED', 'REJECTED', 'CANCELLED']);

function json(response, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(body);
}

function noContent(response, headers = {}) {
  response.writeHead(204, { 'Cache-Control': 'no-store', ...headers });
  response.end();
}

function apiError(response, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const code = typeof error?.code === 'string' ? error.code : 'internal_error';
  const message = status >= 500 && code === 'internal_error'
    ? 'Die Anfrage konnte nicht verarbeitet werden.'
    : String(error?.message || 'Die Anfrage konnte nicht verarbeitet werden.');
  if (status >= 500) console.error(`[${new Date().toISOString()}] ${code}: ${error?.stack || error}`);
  json(response, status, { error: { code, message, ...(error?.details ? { details: error.details } : {}) } });
}

function publicIntent(row) {
  if (!row) return null;
  return {
    id: row.id,
    caption: row.caption,
    privacyLevel: row.privacy_level,
    status: row.status,
    tiktokUsername: row.tiktok_username || null,
    publishId: row.publish_id || null,
    error: row.error_code ? { code: row.error_code, message: row.error_message || 'TikTok hat die Veröffentlichung abgelehnt.' } : null,
    asset: {
      fileName: row.original_name,
      sizeBytes: row.size_bytes,
      durationSeconds: row.duration_seconds,
      sha256: row.asset_sha256
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function clientAddress(request) {
  return String(request.socket.remoteAddress || 'unknown');
}

function requireOrigin(request) {
  const origin = request.headers.origin;
  if (origin && !config.allowedOrigins.has(origin)) {
    throw httpError(403, 'origin_not_allowed', 'Diese Website darf die API nicht aufrufen.');
  }
}

function requireUser(request) {
  const token = parseCookies(request.headers.cookie).kdn_session;
  const user = database.userFromSessionToken(token);
  if (!user) throw httpError(401, 'authentication_required', 'Melde dich mit deinem Einladungslink an.');
  return { user, token };
}

function requireMutationBudget(request, userId) {
  const verdict = mutationLimit(`${userId}:${clientAddress(request)}`);
  if (!verdict.allowed) {
    const error = httpError(429, 'rate_limited', 'Zu viele Anfragen. Bitte kurz warten.');
    error.retryAfterSeconds = verdict.retryAfterSeconds;
    throw error;
  }
}

function cleanText(value, maximum, fieldName) {
  if (typeof value !== 'string') throw httpError(400, 'invalid_field', `${fieldName} fehlt.`);
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maximum) throw httpError(400, 'invalid_field', `${fieldName} muss 1 bis ${maximum} Zeichen enthalten.`);
  return cleaned;
}

async function saveUpload(request, user) {
  const contentType = String(request.headers['content-type'] || '').split(';')[0].toLowerCase();
  if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(contentType)) {
    throw httpError(415, 'unsupported_media_type', 'Erlaubt sind MP4-, MOV- und WebM-Videos.');
  }
  const declaredLength = Number.parseInt(request.headers['content-length'] || '0', 10);
  if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0) {
    throw httpError(411, 'content_length_required', 'Die Dateigröße muss vor dem Upload feststehen.');
  }
  if (declaredLength > config.maxUploadBytes) throw httpError(413, 'upload_too_large', 'Das Video ist größer als das erlaubte Upload-Limit.');
  const durationSeconds = Number.parseFloat(String(request.headers['x-video-duration-seconds'] || ''));
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 86_400) {
    throw httpError(400, 'invalid_video_duration', 'Die Videodauer fehlt oder ist ungültig.');
  }

  const originalName = sanitizeFileName(request.headers['x-file-name']);
  const temporaryPath = path.join(config.uploadsDir, `.upload-${crypto.randomUUID()}.part`);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > config.maxUploadBytes) return callback(httpError(413, 'upload_too_large', 'Das Video ist größer als das erlaubte Upload-Limit.'));
      hash.update(chunk);
      callback(null, chunk);
    }
  });

  try {
    await pipeline(request, limiter, fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
    if (bytes !== declaredLength) throw httpError(400, 'upload_incomplete', 'Der Upload ist unvollständig.');
    const contentHash = hash.digest('hex').toUpperCase();
    const existing = database.findUploadByHash(user.id, contentHash);
    if (existing) {
      fs.rmSync(temporaryPath, { force: true });
      return { upload: database.setUploadDurationIfMissing(user.id, existing.id, durationSeconds), duplicate: true };
    }
    const extension = contentType === 'video/quicktime' ? '.mov' : contentType === 'video/webm' ? '.webm' : '.mp4';
    const finalPath = path.join(config.uploadsDir, `${crypto.randomUUID()}${extension}`);
    fs.renameSync(temporaryPath, finalPath);
    const upload = database.createUpload({
      userId: user.id,
      originalName,
      mimeType: contentType,
      sizeBytes: bytes,
      durationSeconds,
      sha256: contentHash,
      localPath: finalPath
    });
    return { upload, duplicate: false };
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/v1/health') {
    return json(response, 200, {
      status: 'ok',
      integrationConfigured: config.composioReady,
      version: '1.0.0',
      checkedAt: new Date().toISOString()
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/auth/session') {
    requireOrigin(request);
    const verdict = loginLimit(clientAddress(request));
    if (!verdict.allowed) {
      response.setHeader('Retry-After', verdict.retryAfterSeconds);
      throw httpError(429, 'rate_limited', 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.');
    }
    const body = await readJson(request, 16_000);
    const email = validateEmail(body.email);
    const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';
    if (!email || inviteCode.length < 20 || inviteCode.length > 200) {
      throw httpError(400, 'invalid_credentials', 'E-Mail-Adresse oder Einladungscode ist ungültig.');
    }
    const redeemed = database.redeemInvite({ email, token: inviteCode, sessionTtlDays: config.sessionTtlDays });
    if (!redeemed) throw httpError(401, 'invalid_credentials', 'E-Mail-Adresse oder Einladungscode ist ungültig oder abgelaufen.');
    return json(response, 201, {
      user: { email: redeemed.user.email, label: redeemed.user.label },
      expiresAt: redeemed.expiresAt
    }, {
      'Set-Cookie': sessionCookie(redeemed.sessionToken, {
        secure: config.secureCookies,
        maxAgeSeconds: config.sessionTtlDays * 86_400,
        path: config.cookiePath
      })
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/auth/session') {
    const token = parseCookies(request.headers.cookie).kdn_session;
    const user = database.userFromSessionToken(token);
    return json(response, 200, {
      authenticated: Boolean(user),
      user: user ? { email: user.email, label: user.label } : null
    });
  }

  if (request.method === 'DELETE' && url.pathname === '/api/v1/auth/session') {
    requireOrigin(request);
    const { token } = requireUser(request);
    database.revokeSession(token);
    return noContent(response, { 'Set-Cookie': clearSessionCookie(config.secureCookies, config.cookiePath) });
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/me') {
    const { user } = requireUser(request);
    return json(response, 200, { user: { email: user.email, label: user.label } });
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/tiktok/connection') {
    const { user } = requireUser(request);
    if (!config.composioReady) return json(response, 200, { connected: false, configured: false });
    const creator = await tiktok.creatorInfo(user.id);
    return json(response, 200, { configured: true, ...creator });
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/tiktok/connections') {
    requireOrigin(request);
    const { user } = requireUser(request);
    requireMutationBudget(request, user.id);
    const current = await tiktok.creatorInfo(user.id);
    if (current.connected) return json(response, 200, { connected: true });
    const link = await tiktok.createConnectLink(user.id);
    return json(response, 201, link);
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/uploads') {
    requireOrigin(request);
    const { user } = requireUser(request);
    requireMutationBudget(request, user.id);
    const { upload, duplicate } = await saveUpload(request, user);
    return json(response, duplicate ? 200 : 201, {
      upload: {
        id: upload.id,
        fileName: upload.original_name,
        mimeType: upload.mime_type,
        sizeBytes: upload.size_bytes,
        durationSeconds: upload.duration_seconds,
        sha256: upload.sha256,
        duplicate
      }
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/publish-intents') {
    const { user } = requireUser(request);
    return json(response, 200, { items: database.listIntents(user.id).map(publicIntent) });
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/publish-intents') {
    requireOrigin(request);
    const { user } = requireUser(request);
    requireMutationBudget(request, user.id);
    const idempotencyKey = String(request.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{20,200}$/.test(idempotencyKey)) {
      throw httpError(400, 'invalid_idempotency_key', 'Der Veröffentlichungsauftrag benötigt einen gültigen Wiederholungsschlüssel.');
    }
    const body = await readJson(request, 32_000);
    const uploadId = cleanText(body.uploadId, 100, 'Upload-ID');
    const upload = database.getUpload(user.id, uploadId);
    if (!upload) throw httpError(404, 'upload_not_found', 'Das ausgewählte Video wurde nicht gefunden.');
    const caption = cleanText(body.caption, 2200, 'Beschreibung');
    const privacyLevel = cleanText(body.privacyLevel, 40, 'Sichtbarkeit');
    if (!['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'].includes(privacyLevel)) {
      throw httpError(400, 'invalid_privacy_level', 'Die gewählte Sichtbarkeit ist ungültig.');
    }
    if (body.acceptedRights !== true) throw httpError(400, 'rights_confirmation_required', 'Bestätige vor dem Veröffentlichen deine Rechte am Inhalt.');
    const commercial = validateCommercialContent({
      commercialContent: body.commercialContent === true,
      brandOrganic: body.brandOrganicToggle === true,
      brandContent: body.brandContentToggle === true,
      privacyLevel
    });

    const { intent, created } = database.createOrGetIntent({
      userId: user.id,
      idempotencyKey,
      uploadId,
      caption,
      privacyLevel,
      disableComment: body.disableComment === true,
      disableDuet: body.disableDuet === true,
      disableStitch: body.disableStitch === true,
      isAigc: body.isAigc === true,
      brandContentToggle: commercial.brandContent,
      brandOrganicToggle: commercial.brandOrganic,
      acceptedRights: true
    });
    if (!created) return json(response, 200, { intent: publicIntent(database.getIntent(user.id, intent.id)), replayed: true });

    try {
      const result = await tiktok.publish(user.id, intent, upload);
      const updated = database.updateIntent(user.id, intent.id, {
        status: 'PROCESSING_UPLOAD',
        tiktok_username: result.username,
        publish_id: result.publishId,
        result_json: JSON.stringify(result.result)
      });
      return json(response, 201, { intent: publicIntent(updated), replayed: false });
    } catch (error) {
      const failed = database.updateIntent(user.id, intent.id, {
        status: 'FAILED',
        error_code: error.code || 'publish_failed',
        error_message: error.message || 'TikTok hat die Veröffentlichung abgelehnt.'
      });
      if (error.status) error.details = { ...(error.details || {}), intent: publicIntent(failed) };
      throw error;
    }
  }

  const intentMatch = url.pathname.match(/^\/api\/v1\/publish-intents\/([^/]+)$/);
  if (request.method === 'GET' && intentMatch) {
    const { user } = requireUser(request);
    let intent = database.getIntent(user.id, decodeURIComponent(intentMatch[1]));
    if (!intent) throw httpError(404, 'intent_not_found', 'Der Veröffentlichungsauftrag wurde nicht gefunden.');
    if (intent.publish_id && !terminalStatuses.has(intent.status)) {
      try {
        const remote = await tiktok.publishStatus(user.id, intent.publish_id);
        const terminalFailure = ['FAILED', 'REJECTED', 'CANCELLED'].includes(remote.status);
        intent = database.updateIntent(user.id, intent.id, {
          status: remote.status,
          error_code: terminalFailure ? (remote.errorCode || 'tiktok_processing_failed') : null,
          error_message: terminalFailure ? 'TikTok konnte das Video nicht veröffentlichen.' : null,
          result_json: JSON.stringify(remote.result)
        });
      } catch (error) {
        if (error.status !== 429) console.warn(`[${new Date().toISOString()}] Statusabruf ${intent.id}: ${error.message}`);
      }
    }
    return json(response, 200, { intent: publicIntent(intent) });
  }

  throw httpError(404, 'not_found', 'API-Endpunkt nicht gefunden.');
}

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.mp4', 'video/mp4'],
  ['.txt', 'text/plain; charset=utf-8']
]);

function serveStatic(request, response, pathname) {
  const aliases = new Map([
    ['/', '/index.html'],
    ['/app', '/app.html'],
    ['/datenschutz', '/privacy.html'],
    ['/nutzung', '/terms.html']
  ]);
  const normalized = aliases.get(pathname) || pathname;
  const relative = decodeURIComponent(normalized).replace(/^\/+/, '');
  const candidate = path.resolve(config.projectRoot, relative);
  if (!candidate.startsWith(config.projectRoot + path.sep)) throw httpError(403, 'forbidden', 'Zugriff verweigert.');
  if (candidate.includes(`${path.sep}server${path.sep}`) || candidate.includes(`${path.sep}runtime${path.sep}`) || candidate.includes(`${path.sep}.git${path.sep}`)) {
    throw httpError(404, 'not_found', 'Datei nicht gefunden.');
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw httpError(404, 'not_found', 'Datei nicht gefunden.');
  const extension = path.extname(candidate).toLowerCase();
  response.writeHead(200, {
    'Content-Type': mimeTypes.get(extension) || 'application/octet-stream',
    'Cache-Control': ['.html', '.css', '.js'].includes(extension) ? 'no-cache' : 'public, max-age=3600',
    'Content-Length': fs.statSync(candidate).size
  });
  if (request.method === 'HEAD') return response.end();
  fs.createReadStream(candidate).pipe(response);
}

export function createServer() {
  return http.createServer(async (request, response) => {
    applySecurityHeaders(response, { development: !config.secureCookies });
    try {
      const url = new URL(request.url, config.publicBaseUrl);
      if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
      else if (request.method === 'GET' || request.method === 'HEAD') serveStatic(request, response, url.pathname);
      else throw httpError(405, 'method_not_allowed', 'Methode nicht erlaubt.');
    } catch (error) {
      if (!response.headersSent) {
        if (error?.retryAfterSeconds) response.setHeader('Retry-After', error.retryAfterSeconds);
        apiError(response, error);
      } else response.destroy(error);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  database.purgeExpiredSessions();
  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`Kann das noch? Publisher läuft auf http://${config.host}:${config.port}`);
    console.log(`TikTok-Integration: ${config.composioReady ? 'konfiguriert' : 'noch nicht konfiguriert'}`);
  });
}
