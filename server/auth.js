import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { config } from './config.js';

const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(expected, actual);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function ensureUser(db) {
  const existing = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (existing) return true;
  if (!config.initialPassword) return false;
  if (config.initialPassword.length < 10) {
    console.error('VIO_INITIAL_PASSWORD muss mindestens 10 Zeichen haben.');
    return false;
  }
  db.prepare('INSERT INTO users (username, pw_hash) VALUES (?, ?)').run('owner', hashPassword(config.initialPassword));
  console.log('Benutzer angelegt. Du kannst VIO_INITIAL_PASSWORD jetzt wieder entfernen.');
  return true;
}

export function setPassword(db, password) {
  const hash = hashPassword(password);
  const u = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (u) db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(hash, u.id);
  else db.prepare('INSERT INTO users (username, pw_hash) VALUES (?, ?)').run('owner', hash);
  db.prepare('DELETE FROM sessions').run(); // alle Geräte abmelden
}

export function checkOwnerPassword(db, password) {
  const u = db.prepare('SELECT pw_hash FROM users LIMIT 1').get();
  return !!u && verifyPassword(password, u.pw_hash);
}

export function createSession(db, userAgent) {
  const token = randomBytes(32).toString('base64url');
  const u = db.prepare('SELECT id FROM users LIMIT 1').get();
  const expires = new Date(Date.now() + config.sessionDays * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)')
    .run(sha256(token), u.id, expires, String(userAgent || '').slice(0, 200));
  return token;
}

export function getSessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  return { id: row.user_id };
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function sessionCookie(token, maxAgeSec) {
  const parts = [`vio_session=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

// Einfacher Brute-Force-Schutz: 5 Fehlversuche pro IP → 15 Minuten Sperre
const attempts = new Map();
export function loginAllowed(ip) {
  const a = attempts.get(ip);
  return !(a && a.count >= 5 && Date.now() - a.first < 15 * 60e3);
}
export function registerLoginFailure(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > 15 * 60e3) attempts.set(ip, { count: 1, first: Date.now() });
  else a.count++;
}
export function clearLoginFailures(ip) { attempts.delete(ip); }
