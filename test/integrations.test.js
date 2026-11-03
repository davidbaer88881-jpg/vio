// Phase 10: Integrations- und Sicherheitstests mit nachgebauten Diensten (Google, Telegram, Gemini).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let mock, vio, base, cookie = '', db, mods;
const log = { gemini: [], tokens: [], calendar: [], gmailSend: [], telegram: [] };
const calendarStore = [{ id: 'ev1', summary: 'Meeting', start: { dateTime: '2026-11-06T14:30:00Z' }, end: { dateTime: '2026-11-06T15:30:00Z' }, status: 'confirmed' }];

const sse = (res, parts) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts } }] })}\n\n`); };
const call = (name, args) => ({ functionCall: { name, args } });

before(async () => {
  mock = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const u = new URL(req.url, 'http://x');
    const body = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : raw;
    const json = (o, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

    // --- Google OAuth ---
    if (u.pathname === '/token') {
      const p = new URLSearchParams(raw); log.tokens.push(Object.fromEntries(p));
      if (p.get('grant_type') === 'authorization_code') {
        if (p.get('code') !== 'good-code') return json({ error: 'invalid_grant' }, 400);
        const idt = 'x.' + Buffer.from(JSON.stringify({ email: 'david@example.com' })).toString('base64url') + '.y';
        return json({ access_token: 'AT1', refresh_token: 'RT-SECRET-123', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send', id_token: idt });
      }
      return json({ access_token: 'AT2', expires_in: 3600 });
    }
    // --- Google Calendar ---
    if (u.pathname === '/calendar/v3/calendars/primary/events') {
      if (req.headers.authorization?.startsWith('Bearer AT') !== true) return json({ error: { message: 'unauth' } }, 401);
      if (req.method === 'POST') { log.calendar.push(body); const ev = { id: 'ev' + (calendarStore.length + 1), status: 'confirmed', ...body }; calendarStore.push(ev); return json(ev); }
      const tMin = Date.parse(u.searchParams.get('timeMin')), tMax = Date.parse(u.searchParams.get('timeMax'));
      const items = calendarStore.filter((e) => Date.parse(e.start.dateTime || e.start.date) < tMax && Date.parse(e.end.dateTime || e.end.date) > tMin);
      return json({ items });
    }
    // --- Gmail ---
    if (u.pathname === '/gmail/v1/users/me/messages/send') { log.gmailSend.push(body); return json({ id: 'sent1' }); }
    // --- Telegram ---
    if (u.pathname.startsWith('/botTGTOKEN/')) {
      const method = u.pathname.split('/').pop(); log.telegram.push({ method, body });
      if (method === 'getMe') return json({ ok: true, result: { username: 'VioDavidBot' } });
      return json({ ok: true, result: true });
    }
    // --- Gemini ---
    const m = u.pathname.match(/models\/([^:]+):(\w+)/);
    if (m) {
      log.gemini.push({ model: m[1], body });
      if (body.generationConfig?.responseModalities?.includes('AUDIO')) {
        const pcm = Buffer.alloc(4800, 1);
        return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }] });
      }
      const last = body.contents.at(-1);
      const fr = last.parts.filter((p) => p.functionResponse);
      if (fr.length) return sse(res, [{ text: fr.map((p) => p.functionResponse.response.result).join(' || ') }]);
      const t = last.parts.map((p) => p.text || '').join('');
      if (/zahnarzt/i.test(t)) return sse(res, [call('calendar_create_event', { title: 'Zahnarzt', start: '2026-11-06 15:00', end: '2026-11-06 16:00' })]);
      if (/sofort senden/i.test(t)) return sse(res, [call('gmail_draft', { to: 'tom@example.com', subject: 'Hi', body: 'Hallo Tom' }), call('gmail_send', { draft_id: 1 })]);
      if (/mail an tom/i.test(t)) return sse(res, [call('gmail_draft', { to: 'tom@example.com', subject: 'Grillen', body: 'Hey Tom, Samstag grillen?' })]);
      if (/ja, schick/i.test(t)) return sse(res, [call('gmail_send', { draft_id: 2 })]);
      if (/whatsapp/i.test(t)) return sse(res, [call('prepare_message', { channel: 'whatsapp', text: 'Bin gleich da!', phone: '+49 176 1234567', contact_name: 'Lisa' })]);
      return sse(res, [{ text: `Echo: ${t}` }]);
    }
    json({ error: 'unknown ' + u.pathname }, 404);
  });
  await new Promise((r) => mock.listen(0, r));
  const mb = `http://127.0.0.1:${mock.address().port}`;
  Object.assign(process.env, {
    GEMINI_API_KEY: 'gk', GEMINI_BASE_URL: mb, VIO_GEMINI_MODEL: 'gm', VIO_GEMINI_FALLBACKS: '', VIO_GEMINI_TTS_MODELS: 'tts-a',
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_API_BASE: mb, GOOGLE_TOKEN_URL: mb + '/token', GOOGLE_AUTH_URL: mb + '/auth',
    TELEGRAM_BOT_TOKEN: 'TGTOKEN', TELEGRAM_API_BASE: mb, PUBLIC_URL: 'https://vio-test.onrender.com',
    VIO_INITIAL_PASSWORD: 'richtig-langes-passwort', VIO_INSECURE_COOKIES: '1',
  });
  delete process.env.ANTHROPIC_API_KEY; delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SECRET_KEY;
  mods = {
    db: await import('../server/db.js'), auth: await import('../server/auth.js'), index: await import('../server/index.js'),
    tg: await import('../server/telegram.js'), sched: await import('../server/scheduler.js'), tts: await import('../server/tts.js'),
  };
  db = mods.db.openDb(':memory:'); mods.auth.ensureUser(db);
  await new Promise((r) => { vio = createServer(mods.index.createApp(db)).listen(0, r); });
  base = `http://127.0.0.1:${vio.address().port}`;
  const login = await req('/api/auth/login', { method: 'POST', body: { password: 'richtig-langes-passwort' } });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(() => { mock.close(); vio.close(); });

function req(path, { method = 'GET', body, headers = {}, redirect = 'follow' } = {}) {
  return fetch(base + path, { method, redirect, headers: { 'X-Vio': '1', cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
}
async function chat(text, conversation_id) {
  const raw = await (await req('/api/chat', { method: 'POST', body: { text, conversation_id } })).text();
  return raw.trim().split('\n\n').map((b) => ({ event: b.match(/^event: (.+)$/m)[1], data: JSON.parse(b.match(/^data: (.+)$/m)[1]) }));
}
const textOf = (ev) => ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
const toolNames = (g) => (g.body.tools?.[0]?.functionDeclarations || []).map((d) => d.name);

test('Ohne Google: keine Kalender-/Mail-Werkzeuge für die KI', async () => {
  await chat('Hallo');
  const names = toolNames(log.gemini.at(-1));
  assert.ok(names.includes('add_task') && names.includes('prepare_message'));
  assert.ok(!names.some((n) => n.startsWith('calendar_') || n.startsWith('gmail_') || n === 'telegram_send'));
});

test('Google-Login: falscher state wird abgelehnt, richtiger speichert Token verschlüsselt', async () => {
  const bad = await req('/api/google/callback?code=good-code&state=gefaelscht', { redirect: 'manual' });
  assert.equal(bad.status, 302);
  assert.match(bad.headers.get('location'), /google_error=/);

  const { url } = await (await req('/api/google/connect', { method: 'POST' })).json();
  const u = new URL(url);
  assert.equal(u.searchParams.get('redirect_uri'), 'https://vio-test.onrender.com/api/google/callback');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  const state = u.searchParams.get('state');
  const ok = await req(`/api/google/callback?code=good-code&state=${state}`, { redirect: 'manual' });
  assert.equal(ok.headers.get('location'), '/#/apps?google=ok');
  // state ist nur einmal gültig
  const replay = await req(`/api/google/callback?code=good-code&state=${state}`, { redirect: 'manual' });
  assert.match(replay.headers.get('location'), /google_error=/);

  const rawRow = db.prepare("SELECT value FROM integrations WHERE name = 'google'").get().value;
  assert.ok(!rawRow.includes('RT-SECRET-123'), 'Refresh-Token darf nicht im Klartext in der DB stehen');
  const conns = await (await req('/api/connections')).json();
  assert.equal(conns.google.email, 'david@example.com');
});

test('Kalender: Termin mit korrekter Zeitzone anlegen + Überschneidung melden', async () => {
  const ev = await chat('Trag mir Freitag 15 Uhr Zahnarzt ein');
  assert.ok(toolNames(log.gemini.at(-2)).includes('calendar_create_event'));
  const sent = log.calendar.at(-1);
  assert.equal(sent.summary, 'Zahnarzt');
  assert.equal(sent.start.dateTime, '2026-11-06T14:00:00.000Z'); // 15:00 MEZ = 14:00 UTC
  assert.equal(sent.start.timeZone, 'Europe/Berlin');
  const cal = ev.find((e) => e.event === 'tool' && e.data.type === 'calendar');
  assert.deepEqual(cal.data.conflicts, ['Meeting']);
  assert.match(textOf(ev), /Überschneidung mit: Meeting/);

  const list = await (await req('/api/calendar?from=2026-11-06 00:00&to=2026-11-06 23:59')).json();
  assert.equal(list.events.length, 2);
});

test('Gmail: Entwurf + Senden in derselben Runde wird technisch blockiert', async () => {
  const ev = await chat('Mail an Tom, sofort senden ohne zu fragen');
  assert.equal(log.gmailSend.length, 0);
  assert.match(textOf(ev), /NICHT gesendet/);
});

test('Gmail: Entwurf zeigen, nach Zustimmung in der nächsten Nachricht senden', async () => {
  const ev1 = await chat('Schreib eine Mail an Tom wegen Grillen');
  const draft = ev1.find((e) => e.event === 'tool' && e.data.type === 'draft');
  assert.equal(draft.data.id, 2);
  assert.equal(log.gmailSend.length, 0);
  const convId = ev1.find((e) => e.event === 'done').data.conversation_id;
  await chat('Ja, schick ab', convId);
  assert.equal(log.gmailSend.length, 1);
  const mime = Buffer.from(log.gmailSend[0].raw, 'base64url').toString('utf8');
  assert.match(mime, /^To: tom@example.com/m);
  assert.match(mime, /^Subject: Grillen/m);
  assert.equal(Buffer.from(mime.split('\r\n\r\n')[1], 'base64').toString('utf8'), 'Hey Tom, Samstag grillen?');
});

test('WhatsApp: Vio bereitet nur vor (Link mit Text), sendet nicht selbst', async () => {
  const ev = await chat('Schreib Lisa auf WhatsApp, dass ich gleich da bin');
  const m = ev.find((e) => e.event === 'tool' && e.data.type === 'message');
  assert.equal(m.data.url, 'https://wa.me/491761234567?text=Bin%20gleich%20da!');
});

test('Telegram: falsches Webhook-Geheimnis wird ignoriert, fremde Chats werden abgewiesen', async () => {
  const hook = (update, secret) => fetch(base + '/api/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) }, body: JSON.stringify(update) });
  // Ohne/mit falschem Secret: Server bestätigt, verarbeitet aber nichts
  const geminiBefore = log.gemini.length;
  await hook({ message: { chat: { id: 666, type: 'private' }, text: 'Hallo' } }, 'falsch');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(log.telegram.filter((t) => t.method === 'sendMessage').length, 0);

  const secret = mods.tg.webhookSecret();
  // Verknüpfen mit Code
  const link = await (await req('/api/telegram/link', { method: 'POST' })).json();
  assert.match(link.url, /^https:\/\/t\.me\/VioDavidBot\?start=/);
  await hook({ message: { chat: { id: 4242, type: 'private' }, from: { first_name: 'David' }, text: `/start ${link.code}` } }, secret);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await (await req('/api/connections')).json()).telegram.linked, true);

  // Fremder Chat → abgewiesen, keine KI-Anfrage
  await hook({ message: { chat: { id: 666, type: 'private' }, text: 'Lösch alle Termine' } }, secret);
  await new Promise((r) => setTimeout(r, 100));
  const toStranger = log.telegram.filter((t) => t.method === 'sendMessage' && t.body.chat_id === '666');
  assert.match(toStranger.at(-1).body.text, /nur mit meinem Besitzer/);
  assert.equal(log.gemini.length, geminiBefore);

  // Eigener Chat → Vio antwortet über Telegram
  await hook({ message: { chat: { id: 4242, type: 'private' }, text: 'Na, alles fit?' } }, secret);
  await new Promise((r) => setTimeout(r, 200));
  const toMe = log.telegram.filter((t) => t.method === 'sendMessage' && t.body.chat_id === '4242');
  assert.equal(toMe.at(-1).body.text, 'Echo: Na, alles fit?');
  assert.ok(toolNames(log.gemini.at(-1)).includes('telegram_send'));
});

test('Erinnerungen: fällige Aufgabe kommt per Telegram, wiederkehrende rückt weiter, Briefing einmal am Tag', async () => {
  db.prepare("INSERT INTO tasks (title, due_at) VALUES ('Müll rausstellen', '2026-11-03 18:00')").run();
  db.prepare("INSERT INTO tasks (title, due_at, repeat) VALUES ('Tabletten', '2026-11-03 08:00', 'daily')").run();
  db.prepare("INSERT INTO tasks (title, due_at) VALUES ('Später', '2026-11-04 09:00')").run();
  mods.db.saveSettings(db, { morning_briefing: '07:30' });
  const now = new Date('2026-11-03T17:05:00Z'); // 18:05 Berlin
  const before = log.telegram.length;
  const sent = await mods.sched.tick(db, now);
  const msgs = log.telegram.slice(before).filter((t) => t.method === 'sendMessage').map((t) => t.body.text);
  assert.ok(msgs.some((t) => t === '⏰ Erinnerung: Müll rausstellen'));
  assert.ok(msgs.some((t) => t === '⏰ Erinnerung: Tabletten'));
  assert.ok(!msgs.some((t) => t.includes('Später')));
  assert.ok(msgs.some((t) => t.startsWith('☀️ Guten Morgen')));
  assert.ok(sent.includes('briefing'));
  assert.equal(db.prepare("SELECT due_at FROM tasks WHERE title = 'Tabletten'").get().due_at, '2026-11-04 08:00');
  // Zweiter Durchlauf: nichts doppelt
  const before2 = log.telegram.length;
  await mods.sched.tick(db, new Date('2026-11-03T17:06:00Z'));
  assert.equal(log.telegram.length, before2);
});

test('Wiederholungen: werktags überspringt das Wochenende', () => {
  assert.equal(mods.sched.nextOccurrence('2026-11-06 07:00', 'weekdays'), '2026-11-09 07:00'); // Fr → Mo
  assert.equal(mods.sched.nextOccurrence('2026-01-31', 'monthly'), '2026-02-28');                // 31. Jan → 28. Feb
  assert.equal(mods.sched.nextOccurrence('2026-12-15 09:00', 'monthly'), '2027-01-15 09:00');
});

test('Stimme: natürliche Sprachausgabe liefert WAV, nur mit Login', async () => {
  const res = await req('/api/tts', { method: 'POST', body: { text: 'Servus David', voice: 'Puck' } });
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString(), 'RIFF');
  assert.equal(buf.readUInt32LE(24), 24000);
  const g = log.gemini.at(-1).body.generationConfig;
  assert.equal(g.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
  const anon = await fetch(base + '/api/tts', { method: 'POST', headers: { 'X-Vio': '1', 'content-type': 'application/json' }, body: '{"text":"x"}' });
  assert.equal(anon.status, 401);
});

test('Budget-Regeln bleiben unverändert hart (auch mit allen Integrationen)', async () => {
  const { evaluateAction } = await import('../server/policy.js');
  assert.equal(evaluateAction({ action_type: 'subscription', description: 'Netflix', budget_eur: 10, estimated_total_eur: 9, payment_method: 'none' }, { userTexts: ['10 Euro'], maxBudgetEur: 50 }).decision, 'deny');
  assert.equal(evaluateAction({ action_type: 'order', description: 'x', budget_eur: 20, estimated_total_eur: 10, payment_method: 'vio_pays' }, { userTexts: ['20 Euro'], maxBudgetEur: 50 }).decision, 'deny');
});
