import { config } from '../lib/config.mjs';
import { PublisherDatabase } from '../lib/database.mjs';
import { validateEmail } from '../lib/security.mjs';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const email = validateEmail(argument('email'));
const label = String(argument('label') || '').trim();
const days = Number.parseInt(argument('days') || '7', 10);

if (!email || !label || !Number.isSafeInteger(days) || days < 1 || days > 30) {
  console.error('Aufruf: npm run invite -- --email creator@example.com --label "Creator-Name" [--days 7]');
  process.exitCode = 2;
} else {
  const database = new PublisherDatabase(config.databasePath);
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  const token = database.createInvite({ email, label, expiresAt });
  console.log('Einmaliger Einladungscode (jetzt sicher an den Creator übergeben):');
  console.log(token);
  console.log(`Gültig bis: ${expiresAt}`);
}
