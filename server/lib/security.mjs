import crypto from 'node:crypto';

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function parseCookies(header = '') {
  const result = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = '';
    }
  }
  return result;
}

export function sessionCookie(token, { secure, maxAgeSeconds }) {
  const attributes = [
    `kdn_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearSessionCookie(secure) {
  return sessionCookie('', { secure, maxAgeSeconds: 0 });
}

export function applySecurityHeaders(response, { development = false } = {}) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self' https://www.tiktok.com https://*.tiktok.com https://*.composio.dev",
      "img-src 'self' data: https:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "object-src 'none'",
      development ? '' : 'upgrade-insecure-requests'
    ].filter(Boolean).join('; ')
  );
}

export async function readJson(request, maxBytes = 64_000) {
  const declared = Number.parseInt(request.headers['content-length'] || '0', 10);
  if (declared > maxBytes) throw httpError(413, 'payload_too_large', 'Die Anfrage ist zu groß.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw httpError(413, 'payload_too_large', 'Die Anfrage ist zu groß.');
    chunks.push(chunk);
  }
  if (bytes === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'invalid_json', 'Die Anfrage enthält kein gültiges JSON.');
  }
}

export function httpError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

export function validateEmail(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

export function sanitizeFileName(value) {
  const fallback = 'video.mp4';
  if (typeof value !== 'string') return fallback;
  const base = value.split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return base && !base.startsWith('.') ? base : fallback;
}

export function createRateLimiter({ windowMs, maximum }) {
  const attempts = new Map();
  return key => {
    const now = Date.now();
    const current = attempts.get(key);
    if (!current || current.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    current.count += 1;
    return {
      allowed: current.count <= maximum,
      retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000)
    };
  };
}
