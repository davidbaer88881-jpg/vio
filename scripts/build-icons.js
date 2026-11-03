// Stellt die App-Icons aus den .b64-Textdateien wieder her (für Git-Repos ohne Binärdateien).
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
const dir = new URL('../public/icons/', import.meta.url);
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.png.b64')) continue;
  const target = new URL(f.replace(/\.b64$/, ''), dir);
  if (!existsSync(target)) writeFileSync(target, Buffer.from(readFileSync(new URL(f, dir), 'utf8'), 'base64'));
}
