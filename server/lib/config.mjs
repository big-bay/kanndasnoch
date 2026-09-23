import fs from 'node:fs';
import path from 'node:path';

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
loadDotEnv(path.join(projectRoot, '.env'));

function integer(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} muss zwischen ${minimum} und ${maximum} liegen.`);
  }
  return value;
}

function baseUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('PUBLIC_BASE_URL muss HTTP(S) verwenden.');
  return parsed.origin + parsed.pathname.replace(/\/$/, '');
}

const dataDir = path.resolve(projectRoot, process.env.DATA_DIR || 'runtime');
const publicBaseUrl = baseUrl(process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:8787');

export const config = Object.freeze({
  projectRoot,
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  databasePath: path.join(dataDir, 'publisher.sqlite3'),
  host: process.env.HOST || '127.0.0.1',
  port: integer('PORT', 8787, 1, 65535),
  publicBaseUrl,
  allowedOrigins: new Set(
    (process.env.ALLOWED_ORIGINS || publicBaseUrl)
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  ),
  sessionTtlDays: integer('SESSION_TTL_DAYS', 30, 1, 90),
  maxUploadBytes: integer('MAX_UPLOAD_BYTES', 500_000_000, 1_000_000, 4_000_000_000),
  composioApiKey: process.env.COMPOSIO_API_KEY || '',
  composioTikTokAuthConfigId: process.env.COMPOSIO_TIKTOK_AUTH_CONFIG_ID || '',
  composioReady: Boolean(process.env.COMPOSIO_API_KEY && process.env.COMPOSIO_TIKTOK_AUTH_CONFIG_ID),
  secureCookies: new URL(publicBaseUrl).protocol === 'https:'
});

fs.mkdirSync(config.uploadsDir, { recursive: true });
