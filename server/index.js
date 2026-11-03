import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, availableProviders } from './config.js';
import { openDb, getSettings, saveSettings, getProtected, saveProtected, DEFAULT_SETTINGS } from './db.js';
import * as auth from './auth.js';
import { runChatTurn, activeProvider, providerLabel } from './chat.js';
import { restoreBackup, scheduleBackup, flushBackup, backupEnabled } from './backup.js';
import { getConnections } from './connections.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// ---------- Helfer ----------
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(config.secureCookies ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
const json = (res, status, obj) => send(res, status, obj, { 'Cache-Control': 'no-store' });

async function readJson(req, limit = 64 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('Zu groß'), { status: 413 }); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Ungültiges JSON'), { status: 400 }); }
}

function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

// ---------- Statische Dateien ----------
async function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Verboten');
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error();
    const ext = extname(file);
    const etag = `W/"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
    const data = await readFile(file);
    // App-Dateien immer neu prüfen (günstig per ETag), damit Updates sofort ankommen; nur Icons dürfen länger im Cache bleiben
    const cache = ext === '.png' ? 'public, max-age=86400' : 'no-cache';
    return send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache, ETag: etag });
  } catch {
    // SPA-Fallback
    if (!extname(p)) return serveStatic(req, res, '/');
    return send(res, 404, 'Nicht gefunden');
  }
}

// ---------- App ----------
export function createApp(db) {
  const hasUser = () => !!db.prepare('SELECT 1 FROM users LIMIT 1').get();

  return async function handler(req, res) {
    if (req.method !== 'GET' && req.url.startsWith('/api/')) res.on('finish', () => scheduleBackup(db));
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const method = req.method;

    try {
      if (!pathname.startsWith('/api/')) return await serveStatic(req, res, pathname);

      // CSRF-Schutz: alle schreibenden API-Aufrufe brauchen den Header X-Vio (kann eine fremde Seite nicht setzen)
      if (method !== 'GET' && req.headers['x-vio'] !== '1') return json(res, 403, { error: 'CSRF-Schutz' });

      if (pathname === '/api/health') return json(res, 200, { ok: true, setup: hasUser(), ai: availableProviders(), backup: backupEnabled() });

      // --- Login ---
      if (pathname === '/api/auth/login' && method === 'POST') {
        const ip = clientIp(req);
        if (!auth.loginAllowed(ip)) return json(res, 429, { error: 'Zu viele Fehlversuche. Bitte 15 Minuten warten.' });
        if (!hasUser()) return json(res, 503, { error: 'Noch kein Passwort eingerichtet (VIO_INITIAL_PASSWORD).' });
        const { password } = await readJson(req);
        if (!auth.checkOwnerPassword(db, password || '')) {
          auth.registerLoginFailure(ip);
          return json(res, 401, { error: 'Falsches Passwort.' });
        }
        auth.clearLoginFailures(ip);
        const token = auth.createSession(db, req.headers['user-agent']);
        return send(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(token, config.sessionDays * 86400), 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
      }

      // --- ab hier: nur angemeldet ---
      const token = getCookie(req, 'vio_session');
      const user = auth.getSessionUser(db, token);
      if (!user) return json(res, 401, { error: 'Nicht angemeldet.' });

      if (pathname === '/api/auth/logout' && method === 'POST') {
        auth.destroySession(db, token);
        return send(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie('', 0), 'Content-Type': 'application/json' });
      }

      if (pathname === '/api/home' && method === 'GET') {
        return json(res, 200, {
          settings: getSettings(db),
          conversations: db.prepare('SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 5').all(),
          tasks: db.prepare('SELECT id, title, due_at FROM tasks WHERE done = 0 ORDER BY due_at IS NULL, due_at, id LIMIT 5').all(),
          pending_facts: db.prepare("SELECT id, text FROM facts WHERE status = 'pending' ORDER BY id").all(),
          events: null, // Kalender noch nicht verbunden (Phase 7)
          connections: getConnections(getSettings(db)),
        });
      }

      // --- Chat (Server-Sent Events) ---
      if (pathname === '/api/chat' && method === 'POST') {
        const body = await readJson(req);
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableEnded) ac.abort(); });
        const sse = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
        try {
          await runChatTurn(db, { conversationId: body.conversation_id, text: body.text }, sse, ac.signal);
        } catch (e) {
          if (e.name !== 'AbortError') {
            console.error(e);
            const msg = e.message === 'fetch failed' ? 'Der KI-Dienst ist gerade nicht erreichbar. Versuch es gleich nochmal.' : (e.message || 'Fehler');
            sse('error', { message: msg });
          }
        }
        return res.end();
      }

      // --- Gespräche ---
      if (pathname === '/api/conversations' && method === 'GET') {
        return json(res, 200, db.prepare('SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 100').all());
      }
      let m = pathname.match(/^\/api\/conversations\/(\d+)$/);
      if (m && method === 'GET') {
        const conv = db.prepare('SELECT id, title FROM conversations WHERE id = ?').get(Number(m[1]));
        if (!conv) return json(res, 404, { error: 'Nicht gefunden' });
        conv.messages = db.prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(conv.id);
        return json(res, 200, conv);
      }
      if (m && method === 'DELETE') {
        db.prepare('DELETE FROM conversations WHERE id = ?').run(Number(m[1]));
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/search' && method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
        if (q.length < 2) return json(res, 200, []);
        const like = '%' + q.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
        return json(res, 200, db.prepare(`
          SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title
          FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.content LIKE ? ESCAPE '\\' ORDER BY m.id DESC LIMIT 30`).all(like));
      }

      // --- Einstellungen ---
      if (pathname === '/api/settings' && method === 'GET') {
        const st = getSettings(db);
        return json(res, 200, {
          settings: st, protected: getProtected(db),
          providers: availableProviders().map((p) => ({ id: p, label: providerLabel(p) })),
          active_provider: activeProvider(st), backup: backupEnabled(),
        });
      }
      if (pathname === '/api/settings' && method === 'PUT') {
        const body = await readJson(req);
        const patch = {};
        for (const [k, v] of Object.entries(body)) {
          if (!(k in DEFAULT_SETTINGS)) continue; // geschützte Werte sind hier NICHT änderbar
          if (typeof v !== typeof DEFAULT_SETTINGS[k]) continue;
          if (k === 'memory_mode' && !['ask', 'auto', 'off'].includes(v)) continue;
          if (k === 'ai_provider' && !['auto', 'gemini', 'claude'].includes(v)) continue;
          if (k === 'tts_mode' && !['voice', 'always', 'never'].includes(v)) continue;
          if ((k === 'speech_rate' || k === 'speech_pitch') && !(v >= 0.5 && v <= 2)) continue;
          patch[k] = typeof v === 'string' ? v.slice(0, 100) : v;
        }
        saveSettings(db, patch);
        return json(res, 200, { settings: getSettings(db) });
      }
      if (pathname === '/api/settings/protected' && method === 'PUT') {
        const { password, max_budget_eur } = await readJson(req);
        if (!auth.checkOwnerPassword(db, password || '')) return json(res, 401, { error: 'Falsches Passwort.' });
        const v = Number(max_budget_eur);
        if (!Number.isFinite(v) || v < 0 || v > 1000) return json(res, 400, { error: 'Obergrenze muss zwischen 0 und 1000 € liegen.' });
        saveProtected(db, { max_budget_eur: Math.round(v * 100) / 100 });
        return json(res, 200, { protected: getProtected(db) });
      }
      if (pathname === '/api/settings/password' && method === 'PUT') {
        const { current, next } = await readJson(req);
        if (!auth.checkOwnerPassword(db, current || '')) return json(res, 401, { error: 'Aktuelles Passwort falsch.' });
        if (String(next || '').length < 10) return json(res, 400, { error: 'Neues Passwort: mindestens 10 Zeichen.' });
        auth.setPassword(db, next);
        return json(res, 200, { ok: true, relogin: true });
      }

      // --- Gedächtnis ---
      if (pathname === '/api/facts' && method === 'GET') {
        return json(res, 200, db.prepare('SELECT id, text, category, status, created_at FROM facts ORDER BY status DESC, id DESC').all());
      }
      if (pathname === '/api/facts' && method === 'POST') {
        const { text } = await readJson(req);
        const t = String(text || '').trim().slice(0, 300);
        if (!t) return json(res, 400, { error: 'Text fehlt' });
        db.prepare("INSERT INTO facts (text, status) VALUES (?, 'active')").run(t);
        return json(res, 200, { ok: true });
      }
      m = pathname.match(/^\/api\/facts\/(\d+)(\/approve)?$/);
      if (m && m[2] && method === 'POST') {
        db.prepare("UPDATE facts SET status = 'active' WHERE id = ?").run(Number(m[1]));
        return json(res, 200, { ok: true });
      }
      if (m && !m[2] && method === 'DELETE') {
        db.prepare('DELETE FROM facts WHERE id = ?').run(Number(m[1]));
        return json(res, 200, { ok: true });
      }

      // --- Aufgaben ---
      if (pathname === '/api/tasks' && method === 'GET') {
        return json(res, 200, db.prepare('SELECT * FROM tasks ORDER BY done, due_at IS NULL, due_at, id DESC LIMIT 200').all());
      }
      if (pathname === '/api/tasks' && method === 'POST') {
        const { title, due_at } = await readJson(req);
        const t = String(title || '').trim().slice(0, 200);
        if (!t) return json(res, 400, { error: 'Titel fehlt' });
        db.prepare('INSERT INTO tasks (title, due_at) VALUES (?, ?)').run(t, due_at ? String(due_at).slice(0, 16) : null);
        return json(res, 200, { ok: true });
      }
      m = pathname.match(/^\/api\/tasks\/(\d+)$/);
      if (m && method === 'PATCH') {
        const { done } = await readJson(req);
        db.prepare("UPDATE tasks SET done = ?, done_at = CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE id = ?").run(done ? 1 : 0, done ? 1 : 0, Number(m[1]));
        return json(res, 200, { ok: true });
      }
      if (m && method === 'DELETE') {
        db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(m[1]));
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/connections' && method === 'GET') return json(res, 200, getConnections(getSettings(db)));
      if (pathname === '/api/actions' && method === 'GET') {
        return json(res, 200, db.prepare('SELECT * FROM action_log ORDER BY id DESC LIMIT 50').all());
      }

      return json(res, 404, { error: 'Unbekannter Endpunkt' });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) return json(res, e.status || 500, { error: e.status ? e.message : 'Serverfehler' });
      res.end();
    }
  };
}

// ---------- Start ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  try {
    const r = await restoreBackup();
    if (r === 'restored') console.log('Datenbank aus Supabase-Sicherung wiederhergestellt.');
    else if (r === 'none') console.log('Noch keine Sicherung vorhanden – starte mit leerer Datenbank.');
  } catch (e) {
    // Lieber nicht starten, als eine leere DB über die gute Sicherung zu schreiben
    console.error('❌ ' + e.message); process.exit(1);
  }
  const db = openDb();
  if (!auth.ensureUser(db)) console.warn('⚠️  Noch kein Passwort. Setze VIO_INITIAL_PASSWORD (min. 10 Zeichen) oder führe "npm run set-password" aus.');
  else scheduleBackup(db, 1000);
  if (!availableProviders().length) console.warn('⚠️  Kein KI-Schlüssel (GEMINI_API_KEY oder ANTHROPIC_API_KEY) – Vio kann noch nicht antworten.');
  setInterval(() => db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run(), 3600e3).unref();
  const server = createServer(createApp(db)).listen(config.port, () =>
    console.log(`Vio läuft auf Port ${config.port} · KI: ${availableProviders().map(providerLabel).join(', ') || 'keine'} · Sicherung: ${backupEnabled() ? 'an' : 'aus'}`));
  const shutdown = async () => { server.close(); await flushBackup().catch(() => {}); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
