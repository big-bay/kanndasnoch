import fs from 'node:fs';

const file = '/etc/caddy/Caddyfile';
const current = fs.readFileSync(file, 'utf8');
const original = `:8095 {
\ttls /etc/caddy/zeche.crt /etc/caddy/zeche.key
\treverse_proxy 192.168.0.148:8095
}`;
const replacement = `:8095 {
\ttls /etc/caddy/zeche.crt /etc/caddy/zeche.key

\t@kanndasnochRoot path /kanndasnoch
\tredir @kanndasnochRoot /kanndasnoch/ 308

\thandle_path /kanndasnoch/* {
\t\treverse_proxy 127.0.0.1:8787
\t}

\thandle {
\t\treverse_proxy 192.168.0.148:8095
\t}
}`;

if (current.includes('@kanndasnochRoot path /kanndasnoch')) {
  console.log('already-patched');
  process.exit(0);
}
if (!current.includes(original)) {
  throw new Error('Der erwartete unveränderte :8095-Block wurde nicht gefunden.');
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
const backup = `/root/Caddyfile.before-kanndasnoch-${stamp}`;
const temporary = `${file}.kanndasnoch-new`;
fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
fs.writeFileSync(temporary, current.replace(original, replacement), { mode: 0o644, flag: 'wx' });
fs.renameSync(temporary, file);
console.log(backup);

