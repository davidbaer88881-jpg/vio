// Telegram als eigenes Konto – getestet mit einer nachgebauten GramJS-Bibliothek
// (die echte Verbindung zu Telegram ist hier nicht möglich).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let gem, vio, base, cookie = '', db, tguser;
const sent = [];
const gemReqs = [];
let needs2fa = true;

// ---------- Nachgebaute GramJS-Bibliothek ----------
class Req { constructor(p) { Object.assign(this, p); } }
const Api = {
  auth: { SignIn: class SignIn extends Req {}, CheckPassword: class CheckPassword extends Req {}, LogOut: class LogOut extends Req {} },
  account: { GetPassword: class GetPassword extends Req {} },
};
const dialogs = [
  { title: 'Josua Bärnreuther', isUser: true, entity: { id: 1, username: 'josua_b' } },
  { title: 'Lisa Meier', isUser: true, entity: { id: 2 } },
  { title: 'Lisa König', isUser: true, entity: { id: 3 } },
  { title: 'Familie', isGroup: true, entity: { id: 4 } },
  { title: 'SpamBot', isUser: true, entity: { id: 5, bot: true } },
];
class FakeClient {
  constructor(session, apiId, apiHash) { this.session = { save: () => 'SESSION-STRING-XYZ' }; this.apiId = apiId; this.apiHash = apiHash; }
  setLogLevel() {}
  async connect() {}
  async disconnect() {}
  async sendCode(cred, phone) { assert.equal(cred.apiId, 12345); this.phone = phone; return { phoneCodeHash: 'HASH', isCodeViaApp: true }; }
  async invoke(r) {
    if (r instanceof Api.auth.SignIn) {
      if (r.phoneCode !== '24680') throw Object.assign(new Error('x'), { errorMessage: 'PHONE_CODE_INVALID' });
      if (needs2fa) throw Object.assign(new Error('x'), { errorMessage: 'SESSION_PASSWORD_NEEDED' });
      return {};
    }
    if (r instanceof Api.account.GetPassword) return { srp: 1 };
    if (r instanceof Api.auth.CheckPassword) { if (r.password !== 'CHECK(geheim)') throw Object.assign(new Error('x'), { errorMessage: 'PASSWORD_HASH_INVALID' }); return {}; }
    return {};
  }
  async getMe() { return { firstName: 'David', lastName: 'B.' }; }
  async getDialogs() { return dialogs; }
  async sendMessage(entity, { message }) { sent.push({ to: entity.id, message }); }
  async getMessages(entity) { return [{ message: 'Kommst du heute?', out: false, date: 1762250000, sender: { firstName: 'Josua' } }, { message: 'Ja klar', out: true, date: 1762250100 }]; }
}
const fakeLib = { TelegramClient: FakeClient, Api, StringSession: class { constructor(s) { this.s = s; } }, computeCheck: async (_p, pw) => `CHECK(${pw})` };

const sse = (res, parts) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts } }] })}\n\n`); };

before(async () => {
  gem = createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const j = JSON.parse(b); gemReqs.push(j);
    const last = j.contents.at(-1);
    const fr = last.parts.filter((p) => p.functionResponse);
    if (fr.length) return sse(res, [{ text: fr.map((p) => p.functionResponse.response.result).join(' | ') }]);
    const t = last.parts.map((p) => p.text || '').join('');
    if (/was schreibt/i.test(t)) return sse(res, [{ functionCall: { name: 'telegram_dm_read', args: { chat: 'Josua' } } }]);
    if (/josua/i.test(t)) return sse(res, [{ functionCall: { name: 'telegram_dm_send', args: { to: 'Josua', text: 'hi' } } }]);
    if (/lisa/i.test(t)) return sse(res, [{ functionCall: { name: 'telegram_dm_send', args: { to: 'Lisa', text: 'Hallo' } } }]);
    sse(res, [{ text: 'ok' }]);
  });
  await new Promise((r) => gem.listen(0, r));
  Object.assign(process.env, {
    GEMINI_API_KEY: 'k', GEMINI_BASE_URL: `http://127.0.0.1:${gem.address().port}`, VIO_GEMINI_MODEL: 'g', VIO_GEMINI_FALLBACKS: '',
    TELEGRAM_API_ID: '12345', TELEGRAM_API_HASH: 'abcdef', VIO_ENCRYPTION_KEY: 'test-schluessel',
    VIO_INITIAL_PASSWORD: 'richtig-langes-passwort', VIO_INSECURE_COOKIES: '1',
  });
  for (const k of ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'GOOGLE_CLIENT_ID']) delete process.env[k];
  const dbm = await import('../server/db.js'); const auth = await import('../server/auth.js'); const idx = await import('../server/index.js');
  tguser = await import('../server/tguser.js');
  tguser._setLib(fakeLib);
  db = dbm.openDb(':memory:'); auth.ensureUser(db);
  await new Promise((r) => { vio = createServer(idx.createApp(db)).listen(0, r); });
  base = `http://127.0.0.1:${vio.address().port}`;
  const l = await call('/api/auth/login', { method: 'POST', body: { password: 'richtig-langes-passwort' } });
  cookie = l.headers.get('set-cookie').split(';')[0];
});
after(() => { gem.close(); vio.close(); });

function call(path, { method = 'GET', body } = {}) {
  return fetch(base + path, { method, headers: { 'X-Vio': '1', cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
async function chat(text) {
  const raw = await (await call('/api/chat', { method: 'POST', body: { text } })).text();
  return raw.trim().split('\n\n').map((b) => ({ event: b.match(/^event: (.+)$/m)[1], data: JSON.parse(b.match(/^data: (.+)$/m)[1]) }));
}
const toolNames = () => (gemReqs.at(-1)?.tools?.[0]?.functionDeclarations || []).map((d) => d.name);

test('Vor der Anmeldung: kein Werkzeug zum Senden als Nutzer', async () => {
  await chat('Hallo');
  assert.ok(!toolNames().includes('telegram_dm_send'));
  const c = await (await call('/api/connections')).json();
  assert.equal(c.tguser.configured, true);
  assert.equal(c.tguser.connected, false);
});

test('Anmeldung: falsche Nummer, falscher Code, dann Code + Passwort (2FA)', async () => {
  const bad = await call('/api/tguser/start', { method: 'POST', body: { phone: '0176 123' } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /\+49/);

  assert.equal((await call('/api/tguser/start', { method: 'POST', body: { phone: '+49 176 1234567' } })).status, 200);
  const wrong = await call('/api/tguser/code', { method: 'POST', body: { code: '11111' } });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /stimmt nicht/);
  const r = await (await call('/api/tguser/code', { method: 'POST', body: { code: '24-680' } })).json();
  assert.equal(r.needs_password, true);
  const wrongPw = await call('/api/tguser/password', { method: 'POST', body: { password: 'falsch' } });
  assert.match((await wrongPw.json()).error, /Passwort/);
  const ok = await (await call('/api/tguser/password', { method: 'POST', body: { password: 'geheim' } })).json();
  assert.equal(ok.connected, true);
  assert.equal(ok.name, 'David B.');
  assert.equal(ok.phone, '+4917…67');

  const raw = db.prepare("SELECT value FROM integrations WHERE name = 'telegram_user'").get().value;
  assert.ok(!raw.includes('SESSION-STRING-XYZ'), 'Sitzung muss verschlüsselt gespeichert sein');
});

test('„Schreib Josua auf Telegram hi“ → geht sofort raus, ohne Rückfrage', async () => {
  const ev = await chat('Schreibe Josua auf Telegram hi');
  assert.ok(toolNames().includes('telegram_dm_send'));
  assert.deepEqual(sent.at(-1), { to: 1, message: 'hi' });
  const t = ev.find((e) => e.event === 'tool');
  assert.match(t.data.label, /Telegram an Josua Bärnreuther gesendet/);
  assert.match(gemReqs[gemReqs.length - 2].systemInstruction.parts[0].text, /schick es SOFORT mit telegram_dm_send/);
});

test('Zwei Lisas → nichts senden, nachfragen', async () => {
  const before = sent.length;
  const ev = await chat('Schreib Lisa hallo');
  assert.equal(sent.length, before);
  assert.match(ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), /Mehrere Treffer: Lisa Meier.*Lisa König/);
});

test('Chat lesen zum Zusammenfassen', async () => {
  const ev = await chat('Was schreibt Josua?');
  const text = ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  assert.match(text, /Josua: Kommst du heute\?/);
  assert.match(text, /Du: Ja klar/);
});

test('Bots werden nie als Empfänger gefunden; Stundenlimit greift', async () => {
  assert.equal((await tguser.findChats(db, 'SpamBot')).length, 0);
  for (let i = 0; i < tguser.MAX_PER_HOUR; i++) {
    db.prepare("INSERT INTO action_log (action_type, payload, decision, reason) VALUES ('telegram_user_send', '{}', 'allow', 'x')").run();
  }
  await assert.rejects(() => tguser.sendAsMe(db, 'Josua', 'noch eine'), /Sicherheitsgrenze/);
});

test('Abmelden löscht die Sitzung', async () => {
  await call('/api/tguser/logout', { method: 'POST' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM integrations WHERE name = 'telegram_user'").get().n, 0);
  assert.equal((await (await call('/api/connections')).json()).tguser.connected, false);
});
