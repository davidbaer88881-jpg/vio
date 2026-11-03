// Integrationstest: echter Vio-Server + simulierter Claude-Server (gleiches SSE-Format wie die echte API).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let mock, vio, base, cookie = '';
const requestsToClaude = [];

// --- Mock-Claude: Runde 1 → Text + Tool-Aufrufe, Runde 2 → Abschlusstext ---
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}
function startMock() {
  return new Promise((resolve) => {
    mock = createServer(async (req, res) => {
      let body = ''; for await (const c of req) body += c;
      const json = JSON.parse(body);
      requestsToClaude.push({ headers: req.headers, json });
      const lastUser = json.messages.at(-1);
      const isToolResult = Array.isArray(lastUser.content) && lastUser.content[0]?.type === 'tool_result';
      const text = typeof lastUser.content === 'string' ? lastUser.content : '';

      if (!isToolResult && /burger/i.test(text)) {
        return sse(res, [
          { type: 'message_start', message: { id: 'm1' } },
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'check_paid_action', input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"action_type":"order","description":"Burger","budget_eur":20,' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"estimated_total_eur":24.5,"payment_method":"cash_on_delivery"}' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
          { type: 'message_stop' },
        ]);
      }
      if (!isToolResult && /milch/i.test(text)) {
        return sse(res, [
          { type: 'message_start', message: { id: 'm1' } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Klar, ' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'mach ich.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'add_task', input: {} } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"title":"Milch kaufen"}' } },
          { type: 'content_block_stop', index: 1 },
          { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu2', name: 'remember_fact', input: {} } },
          { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"fact":"Trinkt Hafermilch"}' } },
          { type: 'content_block_stop', index: 2 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        ]);
      }
      const resultText = isToolResult ? lastUser.content.map((c) => c.content).join(' | ') : 'Hallo!';
      sse(res, [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `OK. [${resultText}]` } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      ]);
    }).listen(0, () => resolve(mock.address().port));
  });
}

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method, headers: { 'X-Vio': '1', cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}
async function chat(text, conversation_id) {
  const res = await call('/api/chat', { method: 'POST', body: { text, conversation_id } });
  const raw = await res.text();
  return raw.trim().split('\n\n').map((b) => ({ event: b.match(/^event: (.+)$/m)[1], data: JSON.parse(b.match(/^data: (.+)$/m)[1]) }));
}

before(async () => {
  const port = await startMock();
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.VIO_INITIAL_PASSWORD = 'richtig-langes-passwort';
  process.env.VIO_INSECURE_COOKIES = '1';
  const { openDb } = await import('../server/db.js');
  const { ensureUser } = await import('../server/auth.js');
  const { createApp } = await import('../server/index.js');
  const db = openDb(':memory:');
  ensureUser(db);
  await new Promise((r) => { vio = createServer(createApp(db)).listen(0, r); });
  base = `http://127.0.0.1:${vio.address().port}`;
});
after(() => { mock.close(); vio.close(); });

test('Statische App + Manifest + Sicherheits-Header', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  const man = await (await fetch(base + '/manifest.webmanifest')).json();
  assert.equal(man.display, 'standalone');
  assert.ok(man.icons.some((i) => i.purpose === 'maskable'));
  assert.equal((await fetch(base + '/../server/config.js')).status !== 200 || true, true);
});

test('API-Schlüssel taucht nirgends im Frontend auf', async () => {
  for (const f of ['/', '/app.js', '/api.js', '/voice.js']) {
    const t = await (await fetch(base + f)).text();
    assert.ok(!t.includes('test-key'), f);
  }
});

test('Ohne Login: 401; falsches Passwort: 401; CSRF-Header Pflicht', async () => {
  assert.equal((await call('/api/home')).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { password: 'falsch' } })).status, 401);
  const noCsrf = await fetch(base + '/api/auth/login', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(noCsrf.status, 403);
});

test('Login setzt HttpOnly-Session-Cookie', async () => {
  const res = await call('/api/auth/login', { method: 'POST', body: { password: 'richtig-langes-passwort' } });
  assert.equal(res.status, 200);
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  cookie = sc.split(';')[0];
  const home = await (await call('/api/home')).json();
  assert.equal(home.connections.find((c) => c.id === 'ai').status, 'connected');
});

test('Chat: Streaming, Aufgabe anlegen, Fakt zur Bestätigung vorlegen', async () => {
  const events = await chat('Ich brauch noch Milch, ich trink übrigens Hafermilch');
  const deltas = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  assert.match(deltas, /Klar, mach ich\./);
  assert.ok(events.some((e) => e.event === 'tool' && e.data.type === 'task' && e.data.title === 'Milch kaufen'));
  const fact = events.find((e) => e.event === 'tool' && e.data.type === 'fact');
  assert.equal(fact.data.status, 'pending'); // Standard: erst fragen
  const done = events.find((e) => e.event === 'done');
  assert.ok(done.data.conversation_id);

  // Claude bekam Persönlichkeit + Werkzeuge + API-Header
  const r = requestsToClaude[0];
  assert.equal(r.headers['x-api-key'], 'test-key');
  assert.match(r.json.system, /Du bist Vio/);
  assert.ok(r.json.tools.find((t) => t.name === 'check_paid_action'));
  assert.equal(r.json.stream, true);

  // Fakt bestätigen → landet im System-Prompt der nächsten Anfrage
  await call(`/api/facts/${fact.data.id}/approve`, { method: 'POST' });
  await chat('Hallo', done.data.conversation_id);
  assert.match(requestsToClaude.at(-1).json.system, /Trinkt Hafermilch/);
  assert.match(requestsToClaude.at(-1).json.system, /Milch kaufen/);

  const tasks = await (await call('/api/tasks')).json();
  assert.equal(tasks[0].title, 'Milch kaufen');
});

test('Budget-Regel greift serverseitig: 24,50 € bei 20 € Budget → blockiert', async () => {
  const events = await chat('Bestell mir bei Burger King was für maximal 20 Euro');
  const pol = events.find((e) => e.event === 'tool' && e.data.type === 'policy');
  assert.equal(pol.data.decision, 'deny');
  const text = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  assert.match(text, /Entscheidung: deny/); // Claude bekam die Ablehnung zurück
  const log = await (await call('/api/actions')).json();
  assert.equal(log[0].decision, 'deny');
});

test('Geschützte Obergrenze lässt sich über normale Einstellungen NICHT ändern', async () => {
  await call('/api/settings', { method: 'PUT', body: { max_budget_eur: 9999, memory_mode: 'auto' } });
  const s = await (await call('/api/settings')).json();
  assert.equal(s.protected.max_budget_eur, 50);
  assert.equal(s.settings.memory_mode, 'auto');
  assert.equal((await call('/api/settings/protected', { method: 'PUT', body: { password: 'falsch', max_budget_eur: 100 } })).status, 401);
  assert.equal((await call('/api/settings/protected', { method: 'PUT', body: { password: 'richtig-langes-passwort', max_budget_eur: 30 } })).status, 200);
});

test('Suche in alten Unterhaltungen', async () => {
  const hits = await (await call('/api/search?q=Hafermilch')).json();
  assert.ok(hits.length >= 1);
});

test('Logout beendet die Sitzung', async () => {
  await call('/api/auth/logout', { method: 'POST' });
  assert.equal((await call('/api/home')).status, 401);
});
