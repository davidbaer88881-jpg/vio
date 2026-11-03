// Integrationstest: Vio mit Gemini (simuliert, gleiches SSE-Format wie die echte API)
// plus Datensicherung in einem simulierten Supabase Storage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let gem, store, vio, base, cookie = '', db;
const geminiRequests = [];
const storage = new Map(); // "bucket/object" -> Buffer
const storageAuth = [];
const dir = mkdtempSync(join(tmpdir(), 'vio-test-'));
const dbPath = join(dir, 'vio.db');

function listen(srv) { return new Promise((r) => srv.listen(0, () => r(srv.address().port))); }
const sseLine = (obj) => `data: ${JSON.stringify(obj)}\r\n\r\n`;

before(async () => {
  // --- Mock Gemini ---
  gem = createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const json = JSON.parse(b);
    geminiRequests.push({ url: req.url, headers: req.headers, json });
    const last = json.contents.at(-1);
    const isFnResp = last.parts.some((p) => p.functionResponse);
    const text = last.parts.map((p) => p.text || '').join('');
    if (/stresstest/i.test(text) && req.url.includes('gemini-test:')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand.' } }));
    }
    if (/stresstest/i.test(text)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseLine({ candidates: [{ content: { role: 'model', parts: [{ text: 'Läuft trotzdem!' }] } }] }));
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!isFnResp && /zahnarzt/i.test(text)) {
      res.write(sseLine({ candidates: [{ content: { role: 'model', parts: [{ text: 'Alles klar, ' }] } }] }));
      res.write(sseLine({ candidates: [{ content: { role: 'model', parts: [
        { functionCall: { name: 'add_task', args: { title: 'Zahnarzt anrufen', due_at: '2026-11-06' } }, thoughtSignature: 'SIG123' },
      ] }, finishReason: 'STOP' }] }));
      return res.end();
    }
    if (!isFnResp && /pizza/i.test(text)) {
      res.write(sseLine({ candidates: [{ content: { role: 'model', parts: [
        { functionCall: { name: 'check_paid_action', args: { action_type: 'order', description: 'Pizza', budget_eur: 15, estimated_total_eur: 13.9, payment_method: 'cash_on_delivery' } } },
      ] } }] }));
      return res.end();
    }
    const reply = isFnResp ? `notiert. [${JSON.stringify(last.parts[0].functionResponse.response)}]` : 'Servus David!';
    res.write(sseLine({ candidates: [{ content: { role: 'model', parts: [{ text: reply }] }, finishReason: 'STOP' }] }));
    res.end();
  });
  // --- Mock Supabase Storage ---
  store = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    storageAuth.push(req.headers.apikey);
    if (req.headers.apikey !== 'sb_secret_test') { res.writeHead(401); return res.end('{"message":"unauthorized"}'); }
    if (req.url === '/storage/v1/bucket' && req.method === 'POST') { res.writeHead(200); return res.end('{}'); }
    const m = req.url.match(/^\/storage\/v1\/object\/(.+)$/);
    if (m && req.method === 'POST') { storage.set(m[1], Buffer.concat(chunks)); res.writeHead(200); return res.end('{}'); }
    if (m && req.method === 'GET') {
      if (!storage.has(m[1])) { res.writeHead(400); return res.end('{"error":"not_found"}'); }
      res.writeHead(200); return res.end(storage.get(m[1]));
    }
    res.writeHead(404); res.end();
  });
  const gp = await listen(gem); const sp = await listen(store);

  Object.assign(process.env, {
    GEMINI_API_KEY: 'gem-key', GEMINI_BASE_URL: `http://127.0.0.1:${gp}`, VIO_GEMINI_MODEL: 'gemini-test',
    VIO_GEMINI_FALLBACKS: 'gemini-lite-test', VIO_RETRY_DELAY_MS: '5',
    SUPABASE_URL: `http://127.0.0.1:${sp}`, SUPABASE_SECRET_KEY: 'sb_secret_test',
    VIO_INITIAL_PASSWORD: 'richtig-langes-passwort', VIO_INSECURE_COOKIES: '1', VIO_DB_PATH: dbPath,
  });
  delete process.env.ANTHROPIC_API_KEY;
});

after(() => { gem.close(); store.close(); vio?.close(); rmSync(dir, { recursive: true, force: true }); });

async function startVio() {
  const { openDb } = await import('../server/db.js');
  const { ensureUser } = await import('../server/auth.js');
  const { createApp } = await import('../server/index.js');
  db = openDb(dbPath); ensureUser(db);
  await new Promise((r) => { vio = createServer(createApp(db)).listen(0, r); });
  base = `http://127.0.0.1:${vio.address().port}`;
}
const call = (path, { method = 'GET', body } = {}) => fetch(base + path, {
  method, headers: { 'X-Vio': '1', cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
});
async function chat(text, conversation_id) {
  const raw = await (await call('/api/chat', { method: 'POST', body: { text, conversation_id } })).text();
  return raw.trim().split('\n\n').map((b) => ({ event: b.match(/^event: (.+)$/m)[1], data: JSON.parse(b.match(/^data: (.+)$/m)[1]) }));
}

test('Ohne Sicherung: Wiederherstellung meldet "none" und legt den Bucket an', async () => {
  const { restoreBackup } = await import('../server/backup.js');
  assert.equal(await restoreBackup(dbPath), 'none');
  await startVio();
  const login = await call('/api/auth/login', { method: 'POST', body: { password: 'richtig-langes-passwort' } });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const s = await (await call('/api/settings')).json();
  assert.deepEqual(s.providers.map((p) => p.id), ['gemini']);
  assert.equal(s.active_provider, 'gemini');
  assert.equal(s.backup, true);
});

test('Gemini: Streaming + Werkzeug + Gedanken-Signatur bleibt im Verlauf erhalten', async () => {
  const ev = await chat('Ich muss Freitag noch den Zahnarzt anrufen');
  const text = ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  assert.match(text, /^Alles klar, notiert\./);
  assert.ok(ev.some((e) => e.event === 'tool' && e.data.title === 'Zahnarzt anrufen'));

  const [first, second] = geminiRequests.slice(-2);
  assert.match(first.url, /models\/gemini-test:streamGenerateContent\?alt=sse/);
  assert.equal(first.headers['x-goog-api-key'], 'gem-key');
  assert.match(first.json.systemInstruction.parts[0].text, /Du bist Vio/);
  const decl = first.json.tools[0].functionDeclarations.find((d) => d.name === 'check_paid_action');
  assert.equal(decl.parameters.type, 'OBJECT');
  assert.equal(decl.parameters.properties.budget_eur.type, 'NUMBER');
  assert.equal(decl.parameters.properties.budget_eur.nullable, true);
  // 2. Runde: Modell-Antwort mit Signatur + Funktionsergebnis
  const modelTurn = second.json.contents.at(-2);
  assert.equal(modelTurn.role, 'model');
  assert.equal(modelTurn.parts.find((p) => p.functionCall).thoughtSignature, 'SIG123');
  assert.equal(second.json.contents.at(-1).parts[0].functionResponse.name, 'add_task');
});

test('Budget-Regeln gelten auch mit Gemini (15 € genannt, 13,90 € → freigegeben)', async () => {
  const ev = await chat('Bestell mir eine Pizza, maximal 15 Euro');
  const pol = ev.find((e) => e.event === 'tool' && e.data.type === 'policy');
  assert.equal(pol.data.decision, 'allow');
  assert.match(ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), /noch nicht eingerichtet/);
});

test('Gemini überlastet (503): 3 Versuche, dann automatisch Ausweich-Modell', async () => {
  const before = geminiRequests.length;
  const ev = await chat('Stresstest bitte');
  const urls = geminiRequests.slice(before).map((r) => r.url);
  assert.equal(urls.filter((u) => u.includes('gemini-test:')).length, 3);
  assert.equal(urls.filter((u) => u.includes('gemini-lite-test:')).length, 1);
  assert.equal(ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), 'Läuft trotzdem!');
  assert.ok(!ev.some((e) => e.event === 'error'));
});

test('Sicherung landet in Supabase und lässt sich auf einem „neuen Server“ wiederherstellen', async () => {
  const { flushBackup, restoreBackup } = await import('../server/backup.js');
  await new Promise((r) => setTimeout(r, 50));
  await flushBackup();
  assert.ok(storage.get('vio-backup/vio.db')?.length > 1000, 'Sicherung hochgeladen');
  assert.ok(storageAuth.every((k) => k === 'sb_secret_test'));

  // Neuer leerer Server: Datei weg → aus Sicherung holen
  vio.close(); db.close();
  rmSync(dbPath, { force: true }); rmSync(dbPath + '-wal', { force: true }); rmSync(dbPath + '-shm', { force: true });
  assert.equal(existsSync(dbPath), false);
  assert.equal(await restoreBackup(dbPath), 'restored');
  const { openDb } = await import('../server/db.js');
  const db2 = openDb(dbPath);
  assert.equal(db2.prepare("SELECT title FROM tasks WHERE title = 'Zahnarzt anrufen'").get()?.title, 'Zahnarzt anrufen');
  assert.ok(db2.prepare('SELECT 1 FROM users').get(), 'Passwort-Benutzer ist mit gesichert');
  db2.close();
});
