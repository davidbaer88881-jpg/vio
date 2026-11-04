// v0.5: Tempo-Einstellung, Weiterarbeiten nach Verbindungsabbruch, Stopp, Telegram-Nachreichung, Spracherkennung.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';

let mock, vio, base, port, cookie = '', db;
const gem = [];
const tg = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  mock = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    if (req.url.startsWith('/botTOK/')) { tg.push({ m: req.url.split('/').pop(), body: JSON.parse(raw || '{}') }); res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"result":{"username":"VioBot"}}'); }
    const b = JSON.parse(raw);
    const model = req.url.match(/models\/([^:]+):/)[1];
    gem.push({ model, url: req.url, body: b });
    // Modell "alt" kennt thinkingLevel nicht
    if (model === 'alt' && b.generationConfig?.thinkingConfig) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Unknown name \\"thinkingLevel\\" at generation_config.thinking_config"}}'); }
    if (req.url.includes(':generateContent')) { // Spracherkennung
      const audio = b.contents[0].parts.find((p) => p.inlineData);
      const text = audio && audio.inlineData.mimeType === 'audio/wav' && Buffer.from(audio.inlineData.data, 'base64').subarray(0, 4).toString() === 'RIFF' ? 'Erinner mich morgen an den Zahnarzt' : 'LEER';
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    }
    const t = b.contents.at(-1).parts.map((p) => p.text || '').join('');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const words = /langsam/i.test(t) ? ['Das ', 'dauert ', 'etwas ', 'länger, ', 'aber ', 'hier ', 'ist ', 'die ', 'Antwort.'] : ['Kurz.'];
    for (const w of words) {
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: w }] } }] })}\n\n`);
      await sleep(/langsam/i.test(t) ? 120 : 0);
    }
    res.end();
  });
  await new Promise((r) => mock.listen(0, r));
  const mb = `http://127.0.0.1:${mock.address().port}`;
  Object.assign(process.env, {
    GEMINI_API_KEY: 'k', GEMINI_BASE_URL: mb, VIO_GEMINI_MODEL: 'haupt', VIO_GEMINI_FALLBACKS: '',
    TELEGRAM_BOT_TOKEN: 'TOK', TELEGRAM_API_BASE: mb, VIO_ENCRYPTION_KEY: 'k2',
    VIO_INITIAL_PASSWORD: 'richtig-langes-passwort', VIO_INSECURE_COOKIES: '1',
  });
  for (const k of ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'GOOGLE_CLIENT_ID', 'TELEGRAM_API_ID', 'VIO_GEMINI_THINKING']) delete process.env[k];
  const dbm = await import('../server/db.js'); const auth = await import('../server/auth.js'); const idx = await import('../server/index.js');
  const secrets = await import('../server/secrets.js');
  db = dbm.openDb(':memory:'); auth.ensureUser(db);
  secrets.setIntegration(db, 'telegram', { chat_id: '777', name: 'David' }); // Bot ist verknüpft
  await new Promise((r) => { vio = createServer(idx.createApp(db)).listen(0, r); });
  port = vio.address().port; base = `http://127.0.0.1:${port}`;
  const l = await call('/api/auth/login', { method: 'POST', body: { password: 'richtig-langes-passwort' } });
  cookie = l.headers.get('set-cookie').split(';')[0];
});
after(() => { mock.close(); vio.close(); });

function call(path, { method = 'GET', body, headers = {} } = {}) {
  return fetch(base + path, { method, headers: { 'X-Vio': '1', cookie, ...(body && !(body instanceof Buffer) ? { 'content-type': 'application/json' } : {}), ...headers }, body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined });
}

test('Tempo: Gemini bekommt "minimal nachdenken" mit', async () => {
  await (await call('/api/chat', { method: 'POST', body: { text: 'Hallo' } })).text();
  assert.deepEqual(gem.at(-1).body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
  const { thinkingFor } = await import('../server/providers/gemini.js');
  assert.deepEqual(thinkingFor('gemini-2.5-flash'), { thinkingBudget: 0 });
});

test('App verlassen mitten in der Antwort → Vio arbeitet weiter, speichert und schickt per Telegram', async () => {
  // Verbindung nach dem ersten Wort hart kappen (wie App schließen / Netz weg)
  const convId = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/chat', method: 'POST', headers: { 'content-type': 'application/json', 'X-Vio': '1', cookie } }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        const m = buf.match(/"conversation_id":(\d+)/);
        if (m && buf.includes('event: delta')) { req.destroy(); resolve(Number(m[1])); }
      });
    });
    req.on('error', () => {});
    req.end(JSON.stringify({ text: 'Antworte bitte langsam', request_id: 'r-gone' }));
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
  // Während Vio noch arbeitet: running = true
  const mid = await (await call(`/api/conversations/${convId}`)).json();
  assert.equal(mid.running, true);
  await sleep(1500);
  const conv = await (await call(`/api/conversations/${convId}`)).json();
  assert.equal(conv.running, false);
  assert.equal(conv.messages.at(-1).role, 'assistant');
  assert.equal(conv.messages.at(-1).content, 'Das dauert etwas länger, aber hier ist die Antwort.');
  const msg = tg.filter((t) => t.m === 'sendMessage').at(-1);
  assert.equal(msg.body.chat_id, '777');
  assert.match(msg.body.text, /^💬 Vio: Das dauert etwas länger/);
});

test('Stopp-Knopf bricht wirklich ab (auch auf dem Server)', async () => {
  const before = tg.length;
  const p = call('/api/chat', { method: 'POST', body: { text: 'Antworte langsam bitte', request_id: 'r-stop' } }).then((r) => r.text());
  await sleep(250);
  await call('/api/chat/stop', { method: 'POST', body: { request_id: 'r-stop' } });
  const raw = await p;
  assert.ok(!raw.includes('event: done'));
  await sleep(300);
  assert.equal(tg.length, before, 'kein Telegram bei Abbruch');
});

test('Nicht weg, normale Antwort → keine doppelte Telegram-Nachricht', async () => {
  const before = tg.filter((t) => t.m === 'sendMessage').length;
  const raw = await (await call('/api/chat', { method: 'POST', body: { text: 'Hallo nochmal' } })).text();
  assert.match(raw, /event: done/);
  assert.equal(tg.filter((t) => t.m === 'sendMessage').length, before);
});

test('Offline-Sprachnachricht: WAV hochladen → Text', async () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4000)]);
  const r = await call('/api/transcribe', { method: 'POST', body: wav, headers: { 'content-type': 'audio/wav' } });
  assert.deepEqual(await r.json(), { text: 'Erinner mich morgen an den Zahnarzt' });
  const leer = await call('/api/transcribe', { method: 'POST', body: Buffer.alloc(100), headers: { 'content-type': 'audio/mpeg' } });
  assert.deepEqual(await leer.json(), { text: '' });
  const bad = await call('/api/transcribe', { method: 'POST', body: Buffer.from('x'), headers: { 'content-type': 'text/plain' } });
  assert.equal(bad.status, 415);
  const anon = await fetch(base + '/api/transcribe', { method: 'POST', headers: { 'X-Vio': '1', 'content-type': 'audio/wav' }, body: wav });
  assert.equal(anon.status, 401);
});

test('Modell kennt die Denk-Einstellung nicht → automatisch ohne sie weiter', async () => {
  const { config } = await import('../server/config.js');
  config.geminiModel = 'alt';
  const raw = await (await call('/api/chat', { method: 'POST', body: { text: 'Hallo' } })).text();
  assert.match(raw, /Kurz\./);
  const calls = gem.filter((g) => g.model === 'alt');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].body.generationConfig.thinkingConfig);
  assert.equal(calls[1].body.generationConfig.thinkingConfig, undefined);
  config.geminiModel = 'haupt';
});
