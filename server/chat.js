import { availableProviders, config } from './config.js';
import { getSettings } from './db.js';
import { buildSystemPrompt } from './persona.js';
import { getToolDefs, runTool } from './tools.js';
import { googleStatus } from './google.js';
import { telegramStatus } from './telegram.js';
import { getConnections } from './connections.js';
import * as claude from './providers/claude.js';
import * as gemini from './providers/gemini.js';

const PROVIDERS = { claude, gemini };
const HISTORY_LIMIT = 30;

/** Welches KI-Gehirn ist aktiv? Einstellung, sonst das erste mit Schlüssel (Gemini bevorzugt, weil gratis). */
export function activeProvider(settings) {
  const avail = availableProviders();
  if (avail.includes(settings.ai_provider)) return settings.ai_provider;
  return avail[0] || null;
}
export const providerLabel = (p) => (p === 'claude' ? `Claude (${config.model})` : p === 'gemini' ? `Gemini (${config.geminiModel})` : 'keins');

/**
 * Führt einen kompletten Gesprächszug aus und streamt Events über send(event, data).
 */
export async function runChatTurn(db, { conversationId, text, channel = 'app' }, send, signal) {
  text = String(text || '').trim().slice(0, 8000);
  if (!text) throw new Error('Leere Nachricht.');

  const settings = getSettings(db);
  const providerName = activeProvider(settings);
  if (!providerName) {
    send('error', { message: 'Kein KI-Schlüssel hinterlegt. Setze GEMINI_API_KEY (kostenlos) oder ANTHROPIC_API_KEY auf dem Server (siehe Anleitung).' });
    return;
  }

  // Gespräch anlegen oder fortsetzen
  let convId = Number(conversationId) || null;
  if (convId && !db.prepare('SELECT id FROM conversations WHERE id = ?').get(convId)) convId = null;
  if (!convId) {
    const title = text.length > 60 ? text.slice(0, 57) + '…' : text;
    convId = Number(db.prepare('INSERT INTO conversations (title) VALUES (?)').run(title).lastInsertRowid);
  }
  send('meta', { conversation_id: convId, provider: providerName });

  const turnId = Number(db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(convId, 'user', text).lastInsertRowid);

  // Verlauf laden (die letzten N Nachrichten), Rollen sauber abwechseln lassen
  const rows = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
    .all(convId, HISTORY_LIMIT).reverse();
  const messages = [];
  for (const r of rows) {
    const last = messages[messages.length - 1];
    if (last && last.role === r.role) last.content += '\n\n' + r.content;
    else messages.push({ role: r.role, content: r.content });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();

  const userTexts = db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user'").all(convId).map((r) => r.content);

  const system = buildSystemPrompt({
    settings,
    facts: db.prepare("SELECT id, text FROM facts WHERE status = 'active' ORDER BY id").all(),
    openTasks: db.prepare('SELECT id, title, due_at FROM tasks WHERE done = 0 ORDER BY COALESCE(due_at, created_at) LIMIT 30').all(),
    connections: getConnections(settings, db),
    google: googleStatus(db), telegram: telegramStatus(db), channel,
  });

  let fullText = '';
  let lastWasTool = false;
  await PROVIDERS[providerName].run({
    system, messages, tools: getToolDefs(db), signal,
    onText: (t) => {
      if (lastWasTool && fullText && !/\s$/.test(fullText)) { fullText += ' '; send('delta', { text: ' ' }); }
      lastWasTool = false;
      fullText += t; send('delta', { text: t });
    },
    runTool: async (name, input) => {
      lastWasTool = true;
      const { result, event } = await runTool(db, name, input, { userTexts, turnId, lastUserText: text });
      if (event) send('tool', event);
      return result;
    },
  });

  fullText = fullText.trim() || '…';
  const msgId = Number(db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(convId, 'assistant', fullText).lastInsertRowid);
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(convId);
  send('done', { message_id: msgId, conversation_id: convId });
}

/** Gesprächszug ohne Streaming (für Telegram). Liefert den Antworttext. */
export async function runChatTurnCollect(db, text, channel = 'telegram') {
  let conv = db.prepare("SELECT id FROM conversations WHERE title = '💬 Telegram'").get();
  if (!conv) conv = { id: Number(db.prepare("INSERT INTO conversations (title) VALUES ('💬 Telegram')").run().lastInsertRowid) };
  let out = '';
  const notes = [];
  await runChatTurn(db, { conversationId: conv.id, text, channel }, (ev, data) => {
    if (ev === 'delta') out += data.text;
    else if (ev === 'error') out += (out ? '\n\n' : '') + '⚠️ ' + data.message;
    else if (ev === 'tool' && data.type === 'message') notes.push(`👉 ${data.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} öffnen: ${data.url}`);
    else if (ev === 'tool' && data.type === 'call' && data.phone) notes.push(`📞 Anrufen: tel:${data.phone}`);
    else if (ev === 'tool' && data.type === 'fact' && data.status === 'pending') notes.push(`🧠 Zum Merken vorgeschlagen: „${data.text}“ (in der App bestätigen)`);
  });
  return [out.trim(), ...notes].filter(Boolean).join('\n\n');
}
