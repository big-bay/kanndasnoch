import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const browser = fs.readFileSync(new URL('../assets/publisher.js', import.meta.url), 'utf8');
const service = fs.readFileSync(new URL('../server/lib/composio.mjs', import.meta.url), 'utf8');

test('review UI includes explicit music and commercial-content controls', () => {
  assert.match(html, /id="commercial-content"/);
  assert.match(html, /id="commercial-options"[^>]*hidden/);
  assert.match(html, /Music Usage Confirmation/);
  assert.match(browser, /Branded Content Policy und Music Usage Confirmation/);
  assert.match(browser, /selfOnlyOption\.disabled = branded/);
});

test('creator nickname is taken from fresh TikTok creator info', () => {
  assert.match(service, /creator_nickname/);
  assert.match(browser, /creator\.displayName/);
});

