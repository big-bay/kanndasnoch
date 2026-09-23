import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCookies,
  sanitizeFileName,
  sessionCookie,
  sha256,
  safeEqualHex,
  validateEmail
} from '../server/lib/security.mjs';

test('email normalization accepts normal addresses and rejects malformed input', () => {
  assert.equal(validateEmail(' Creator@Example.COM '), 'creator@example.com');
  assert.equal(validateEmail('not-an-email'), null);
  assert.equal(validateEmail('a@b'), null);
});

test('session cookie is HttpOnly, SameSite and optionally Secure', () => {
  const cookie = sessionCookie('secret token', { secure: true, maxAgeSeconds: 60, path: '/kanndasnoch' });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Path=\/kanndasnoch/);
  assert.equal(parseCookies(cookie).kdn_session, 'secret token');
});

test('file names cannot escape the upload directory', () => {
  assert.equal(sanitizeFileName('../../mein clip.mp4'), 'mein_clip.mp4');
  assert.equal(sanitizeFileName('.env'), 'video.mp4');
});

test('constant-time hash comparison distinguishes tokens', () => {
  const left = sha256('alpha');
  assert.equal(safeEqualHex(left, sha256('alpha')), true);
  assert.equal(safeEqualHex(left, sha256('beta')), false);
});
