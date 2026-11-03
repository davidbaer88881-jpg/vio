// Google-Anbindung: Login (OAuth), Kalender, Gmail.
// Zugriff nur mit deiner ausdrücklichen Zustimmung bei Google; das Token liegt verschlüsselt in der Datenbank.
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { getIntegration, setIntegration, deleteIntegration } from './secrets.js';

export const GOOGLE_SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];
export const googleConfigured = () => !!(config.googleClientId && config.googleClientSecret && config.publicUrl);
export const redirectUri = () => `${config.publicUrl}/api/google/callback`;

// ---------- OAuth ----------
const pendingStates = new Map(); // state -> Ablaufzeit (einmalig, 10 Min.)
export function startAuthUrl() {
  const state = randomBytes(24).toString('base64url');
  pendingStates.set(state, Date.now() + 10 * 60e3);
  const p = new URLSearchParams({
    client_id: config.googleClientId, redirect_uri: redirectUri(), response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return `${config.googleAuthUrl}?${p}`;
}

export async function finishAuth(db, { code, state }) {
  const exp = pendingStates.get(state);
  pendingStates.delete(state);
  if (!exp || exp < Date.now()) throw new Error('Ungültige oder abgelaufene Anmeldung. Bitte nochmal verbinden.');
  const res = await fetch(config.googleTokenUrl, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: redirectUri(), grant_type: 'authorization_code' }),
  });
  const tok = await res.json();
  if (!res.ok || !tok.refresh_token) throw new Error(`Google-Anmeldung fehlgeschlagen: ${tok.error_description || tok.error || res.status}`);
  let email = '';
  try { email = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url')).email || ''; } catch {}
  setIntegration(db, 'google', {
    refresh_token: tok.refresh_token, access_token: tok.access_token, expires_at: Date.now() + (tok.expires_in - 60) * 1000,
    scope: tok.scope || '', email,
  });
  return { email };
}

export function googleStatus(db) {
  const g = getIntegration(db, 'google');
  return g ? { connected: true, email: g.email, scope: g.scope } : { connected: false };
}
export function disconnectGoogle(db) { deleteIntegration(db, 'google'); }

async function accessToken(db) {
  const g = getIntegration(db, 'google');
  if (!g) throw new Error('Google ist nicht verbunden. Verbinde es unter Apps.');
  if (g.access_token && g.expires_at > Date.now()) return g.access_token;
  const res = await fetch(config.googleTokenUrl, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, refresh_token: g.refresh_token, grant_type: 'refresh_token' }),
  });
  const tok = await res.json();
  if (!res.ok) {
    if (tok.error === 'invalid_grant') { deleteIntegration(db, 'google'); throw new Error('Die Google-Verbindung ist abgelaufen. Bitte unter Apps neu verbinden.'); }
    throw new Error(`Google-Token-Fehler: ${tok.error || res.status}`);
  }
  setIntegration(db, 'google', { ...g, access_token: tok.access_token, expires_at: Date.now() + (tok.expires_in - 60) * 1000 });
  return tok.access_token;
}

async function gapi(db, path, { method = 'GET', body, query } = {}) {
  const url = `${config.googleApiBase}${path}${query ? '?' + new URLSearchParams(query) : ''}`;
  const res = await fetch(url, {
    method, headers: { authorization: `Bearer ${await accessToken(db)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google ${res.status}: ${json.error?.message || 'Fehler'}`);
  return json;
}

// ---------- Zeit-Helfer (Europe/Berlin) ----------
const TZ = config.timezone;
/** "2026-11-05 14:30" (Berliner Zeit) → RFC3339 mit korrektem Offset */
export function berlinToIso(local) {
  const m = String(local).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) throw new Error(`Ungültiges Datum: ${local} (erwartet JJJJ-MM-TT HH:MM)`);
  const [, y, mo, d, h = '00', mi = '00'] = m;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  const offset = (t) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).reduce((a, p) => ({ ...a, [p.type]: p.value }), {});
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return new Date(t).toISOString();
}
export function fmtBerlin(iso, withDate = true) {
  return new Date(iso).toLocaleString('de-DE', { timeZone: TZ, ...(withDate ? { weekday: 'short', day: '2-digit', month: '2-digit' } : {}), hour: '2-digit', minute: '2-digit' });
}

function simplifyEvent(e) {
  return {
    id: e.id, title: e.summary || '(ohne Titel)', location: e.location || '', description: (e.description || '').slice(0, 300),
    start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, all_day: !!e.start?.date, link: e.htmlLink || '',
  };
}

// ---------- Kalender ----------
export async function listEvents(db, { from, to, query, max = 25 } = {}) {
  const timeMin = from ? berlinToIso(from) : new Date().toISOString();
  const timeMax = to ? berlinToIso(to) : new Date(Date.now() + 7 * 864e5).toISOString();
  const q = { timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.min(max, 100)) };
  if (query) q.q = query;
  const r = await gapi(db, '/calendar/v3/calendars/primary/events', { query: q });
  return (r.items || []).filter((e) => e.status !== 'cancelled').map(simplifyEvent);
}

function eventBody({ title, start, end, all_day, location, description, recurrence, reminder_minutes }) {
  const body = {};
  if (title) body.summary = title;
  if (location !== undefined) body.location = location;
  if (description !== undefined) body.description = description;
  if (start) {
    if (all_day) {
      const d = start.slice(0, 10);
      const e = (end || start).slice(0, 10);
      const next = new Date(Date.parse(e + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
      body.start = { date: d }; body.end = { date: next };
    } else {
      const s = berlinToIso(start);
      const e = end ? berlinToIso(end) : new Date(Date.parse(s) + 60 * 60e3).toISOString();
      body.start = { dateTime: s, timeZone: TZ }; body.end = { dateTime: e, timeZone: TZ };
    }
  }
  const rr = { daily: 'RRULE:FREQ=DAILY', weekdays: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: 'RRULE:FREQ=WEEKLY', monthly: 'RRULE:FREQ=MONTHLY', yearly: 'RRULE:FREQ=YEARLY' }[recurrence];
  if (rr) body.recurrence = [rr];
  if (Number.isFinite(reminder_minutes)) body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: reminder_minutes }] };
  return body;
}

/** Findet Termine, die sich mit [start, end) überschneiden. */
export async function findConflicts(db, startIso, endIso, ignoreId) {
  const r = await gapi(db, '/calendar/v3/calendars/primary/events', { query: { timeMin: startIso, timeMax: endIso, singleEvents: 'true', orderBy: 'startTime' } });
  return (r.items || []).filter((e) => e.id !== ignoreId && e.status !== 'cancelled' && e.transparency !== 'transparent' && e.start?.dateTime).map(simplifyEvent);
}

export async function createEvent(db, input) {
  const body = eventBody(input);
  if (!body.start) throw new Error('Startzeit fehlt.');
  const conflicts = body.start.dateTime ? await findConflicts(db, body.start.dateTime, body.end.dateTime) : [];
  const e = await gapi(db, '/calendar/v3/calendars/primary/events', { method: 'POST', body });
  return { event: simplifyEvent(e), conflicts };
}
export async function updateEvent(db, id, input) {
  const body = eventBody(input);
  const e = await gapi(db, `/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`, { method: 'PATCH', body });
  const ev = simplifyEvent(e);
  const conflicts = e.start?.dateTime ? await findConflicts(db, e.start.dateTime, e.end.dateTime, e.id) : [];
  return { event: ev, conflicts };
}
export async function deleteEvent(db, id) {
  await gapi(db, `/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ---------- Gmail ----------
const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
function bodyText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  for (const p of payload.parts || []) { const t = bodyText(p); if (t) return t; }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  }
  return '';
}

export async function searchMail(db, { query = 'in:inbox', max = 10 } = {}) {
  const list = await gapi(db, '/gmail/v1/users/me/messages', { query: { q: query, maxResults: String(Math.min(max, 20)) } });
  const out = [];
  for (const m of list.messages || []) {
    const msg = await gapi(db, `/gmail/v1/users/me/messages/${m.id}`, {
      query: [['format', 'metadata'], ['metadataHeaders', 'From'], ['metadataHeaders', 'Subject'], ['metadataHeaders', 'Date']],
    }).catch(() => null);
    if (!msg) continue;
    out.push({ id: m.id, thread_id: msg.threadId, from: header(msg, 'From'), subject: header(msg, 'Subject'), date: header(msg, 'Date'), snippet: msg.snippet || '', unread: (msg.labelIds || []).includes('UNREAD') });
  }
  return out;
}

export async function readMail(db, id) {
  const msg = await gapi(db, `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, { query: { format: 'full' } });
  return {
    id: msg.id, thread_id: msg.threadId, from: header(msg, 'From'), to: header(msg, 'To'), subject: header(msg, 'Subject'),
    date: header(msg, 'Date'), message_id: header(msg, 'Message-ID'), body: bodyText(msg.payload).trim().slice(0, 6000),
  };
}

const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
export function buildMime({ to, subject, body, inReplyTo }) {
  if (/[\r\n]/.test(to + subject)) throw new Error('Ungültige Zeichen in Empfänger oder Betreff.');
  const lines = [
    `To: ${to}`, `Subject: ${encodeHeader(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    '', Buffer.from(body, 'utf8').toString('base64'),
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

export async function sendMail(db, { to, subject, body, reply_to_id }) {
  let threadId, inReplyTo, subj = subject;
  if (reply_to_id) {
    const orig = await readMail(db, reply_to_id);
    threadId = orig.thread_id; inReplyTo = orig.message_id;
    if (!subj) subj = orig.subject.startsWith('Re:') ? orig.subject : `Re: ${orig.subject}`;
    if (!to) to = orig.from;
  }
  const raw = buildMime({ to, subject: subj || '(kein Betreff)', body, inReplyTo });
  const r = await gapi(db, '/gmail/v1/users/me/messages/send', { method: 'POST', body: { raw, ...(threadId ? { threadId } : {}) } });
  return { id: r.id, to, subject: subj };
}
