// Telegram als DEIN Konto: Vio schreibt in deinem Namen an deine Kontakte und kann Chats lesen.
// Technik: GramJS (npm-Paket "telegram", wird von Render beim Bauen installiert).
// Sicherheit: Sitzung verschlüsselt in der DB, nur auf deine Anweisung, feste Obergrenze pro Stunde.
import { config } from './config.js';
import { getIntegration, setIntegration, deleteIntegration } from './secrets.js';

export const MAX_PER_HOUR = 20; // Schutz vor Spam-Sperre durch Telegram und vor Fehlbedienung

let lib = null; // { TelegramClient, Api, StringSession, computeCheck }
/** Für Tests: eigene (nachgebaute) Bibliothek einsetzen. */
export function _setLib(l) { lib = l; client = null; }

async function loadLib() {
  if (lib) return lib;
  try {
    const mod = await import('telegram');
    const tg = mod.default ?? mod;
    const sessions = tg.sessions ?? (await import('telegram/sessions/index.js'));
    const pw = tg.password ?? (await import('telegram/Password.js'));
    lib = { TelegramClient: tg.TelegramClient, Api: tg.Api, StringSession: sessions.StringSession, computeCheck: pw.computeCheck };
    return lib;
  } catch {
    throw new Error('Die Telegram-Bibliothek ist auf dem Server nicht installiert (nur auf Render verfügbar).');
  }
}

export const tgUserConfigured = () => !!(config.telegramApiId && config.telegramApiHash);
export const tgUserStatus = (db) => {
  const s = getIntegration(db, 'telegram_user');
  return { configured: tgUserConfigured(), connected: !!s, name: s?.name || '', phone: s?.phone ? s.phone.slice(0, 5) + '…' + s.phone.slice(-2) : '' };
};

let client = null;
async function newClient(sessionStr) {
  const { TelegramClient, StringSession } = await loadLib();
  const c = new TelegramClient(new StringSession(sessionStr || ''), Number(config.telegramApiId), config.telegramApiHash, { connectionRetries: 3 });
  c.setLogLevel?.('error');
  await c.connect();
  return c;
}
async function getClient(db) {
  const s = getIntegration(db, 'telegram_user');
  if (!s) throw new Error('Dein Telegram-Konto ist nicht mit Vio verbunden (Apps → Telegram-Konto).');
  if (!client) client = await newClient(s.session);
  return client;
}

// ---------- Anmeldung (Telefonnummer → Code → ggf. Passwort) ----------
let pending = null; // { client, phone, phoneCodeHash, expires }

export async function loginStart(phone) {
  if (!tgUserConfigured()) throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH fehlen auf dem Server.');
  const p = String(phone || '').replace(/[^\d+]/g, '');
  if (!/^\+\d{8,15}$/.test(p)) throw new Error('Bitte die Nummer im Format +49… eingeben.');
  const c = await newClient('');
  const r = await c.sendCode({ apiId: Number(config.telegramApiId), apiHash: config.telegramApiHash }, p);
  pending = { client: c, phone: p, phoneCodeHash: r.phoneCodeHash, expires: Date.now() + 10 * 60e3 };
  return { sent: true, via_app: r.isCodeViaApp !== false };
}

async function finishLogin(db) {
  const me = await pending.client.getMe();
  setIntegration(db, 'telegram_user', {
    session: pending.client.session.save(), phone: pending.phone,
    name: [me?.firstName, me?.lastName].filter(Boolean).join(' ') || me?.username || 'Telegram',
  });
  client = pending.client; pending = null;
  return tgUserStatus(db);
}

export async function loginCode(db, code) {
  if (!pending || pending.expires < Date.now()) throw new Error('Anmeldung abgelaufen. Bitte nochmal „Code senden“.');
  const { Api } = await loadLib();
  try {
    await pending.client.invoke(new Api.auth.SignIn({ phoneNumber: pending.phone, phoneCodeHash: pending.phoneCodeHash, phoneCode: String(code).replace(/\D/g, '') }));
  } catch (e) {
    const m = String(e.errorMessage || e.message);
    if (m.includes('SESSION_PASSWORD_NEEDED')) return { needs_password: true };
    if (m.includes('PHONE_CODE_INVALID')) throw new Error('Der Code stimmt nicht. Bitte nochmal eingeben.');
    if (m.includes('PHONE_CODE_EXPIRED')) { pending = null; throw new Error('Der Code ist abgelaufen. Bitte neu senden.'); }
    throw new Error(`Telegram: ${m}`);
  }
  return finishLogin(db);
}

export async function loginPassword(db, password) {
  if (!pending) throw new Error('Anmeldung abgelaufen. Bitte nochmal von vorn.');
  const { Api, computeCheck } = await loadLib();
  try {
    const pwd = await pending.client.invoke(new Api.account.GetPassword());
    await pending.client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(pwd, String(password)) }));
  } catch (e) {
    if (String(e.errorMessage || e.message).includes('PASSWORD_HASH_INVALID')) throw new Error('Das Passwort (zweistufige Bestätigung) stimmt nicht.');
    throw new Error(`Telegram: ${e.errorMessage || e.message}`);
  }
  return finishLogin(db);
}

export async function logout(db) {
  try { const c = await getClient(db); const { Api } = await loadLib(); await c.invoke(new Api.auth.LogOut()); } catch {}
  try { await client?.disconnect(); } catch {}
  client = null;
  deleteIntegration(db, 'telegram_user');
}

// ---------- Kontakte finden ----------
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ß ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Sucht passende Chats (Personen, Gruppen) nach Namen. */
export async function findChats(db, name) {
  const c = await getClient(db);
  const q = norm(name).replace(/^@/, '');
  if (!q) return [];
  const dialogs = await c.getDialogs({ limit: 300 });
  const list = dialogs.map((d) => ({
    entity: d.entity, title: d.title || d.name || '', username: d.entity?.username || '',
    kind: d.isUser ? 'person' : d.isGroup ? 'gruppe' : d.isChannel ? 'kanal' : 'chat',
    bot: !!d.entity?.bot,
  })).filter((x) => !x.bot);
  const exact = list.filter((x) => norm(x.title) === q || norm(x.username) === q);
  if (exact.length) return exact;
  const words = q.split(' ');
  return list.filter((x) => { const t = norm(x.title) + ' ' + norm(x.username); return words.every((w) => t.includes(w)); }).slice(0, 8);
}

// ---------- Senden & Lesen ----------
export async function sendAsMe(db, name, text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Leere Nachricht.');
  if (t.length > 3000) throw new Error('Nachricht zu lang.');
  const recent = db.prepare("SELECT COUNT(*) AS n FROM action_log WHERE action_type = 'telegram_user_send' AND created_at > datetime('now', '-1 hour')").get().n;
  if (recent >= MAX_PER_HOUR) throw new Error(`Sicherheitsgrenze erreicht: höchstens ${MAX_PER_HOUR} Nachrichten pro Stunde.`);
  const matches = await findChats(db, name);
  if (!matches.length) return { status: 'not_found' };
  if (matches.length > 1) return { status: 'ambiguous', options: matches.map((m) => `${m.title}${m.username ? ' (@' + m.username + ')' : ''} – ${m.kind}`) };
  const target = matches[0];
  const c = await getClient(db);
  await c.sendMessage(target.entity, { message: t });
  db.prepare("INSERT INTO action_log (action_type, payload, decision, reason) VALUES ('telegram_user_send', ?, 'allow', 'Auf Anweisung des Nutzers gesendet')")
    .run(JSON.stringify({ to: target.title, length: t.length }));
  return { status: 'sent', to: target.title, kind: target.kind };
}

export async function readChat(db, name, limit = 15) {
  const matches = await findChats(db, name);
  if (!matches.length) return { status: 'not_found' };
  if (matches.length > 1) return { status: 'ambiguous', options: matches.map((m) => `${m.title} – ${m.kind}`) };
  const c = await getClient(db);
  const msgs = await c.getMessages(matches[0].entity, { limit: Math.min(Number(limit) || 15, 50) });
  const lines = [...msgs].reverse().filter((m) => m.message).map((m) => {
    const when = new Date((m.date || 0) * 1000).toLocaleString('de-DE', { timeZone: config.timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const who = m.out ? 'Du' : (m.sender?.firstName || matches[0].title);
    return `[${when}] ${who}: ${String(m.message).slice(0, 500)}`;
  });
  return { status: 'ok', chat: matches[0].title, lines };
}
