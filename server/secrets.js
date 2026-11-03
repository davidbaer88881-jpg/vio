// Verschlüsselte Ablage von Zugangsdaten (z. B. Google-Token) in der Datenbank.
// Der Schlüssel liegt nur als Umgebungsvariable auf dem Server – die Supabase-Sicherung enthält nur Chiffretext.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';

const key = () => {
  if (!config.encryptionSecret) throw new Error('Kein Verschlüsselungsschlüssel (VIO_ENCRYPTION_KEY) gesetzt.');
  return createHash('sha256').update('vio:' + config.encryptionSecret).digest();
};

export function encrypt(obj) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function decrypt(str) {
  const [v, iv, tag, data] = String(str).split('.');
  if (v !== 'v1') throw new Error('Unbekanntes Format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
}

export function getIntegration(db, name) {
  const row = db.prepare('SELECT value FROM integrations WHERE name = ?').get(name);
  if (!row) return null;
  try { return decrypt(row.value); } catch { return null; }
}
export function setIntegration(db, name, value) {
  db.prepare('INSERT INTO integrations (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, encrypt(value));
}
export function deleteIntegration(db, name) {
  db.prepare('DELETE FROM integrations WHERE name = ?').run(name);
}
