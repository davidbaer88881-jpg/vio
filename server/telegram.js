// Telegram-Bot: Erinnerungen aufs Handy, mit Vio über Telegram chatten, Nachrichten an Gruppen.
// Sicherheit: Nur der Chat, der sich mit einem einmaligen Code verknüpft hat, darf Vio steuern.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { getIntegration, setIntegration, deleteIntegration } from './secrets.js';

export const telegramConfigured = () => !!config.telegramToken;
const api = async (method, body) => {
  const res = await fetch(`${config.telegramApiBase}/bot${config.telegramToken}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`Telegram: ${json.description || res.status}`);
  return json.result;
};

// Geheimer Pfad + Header für den Webhook (aus dem Bot-Token abgeleitet, nie im Klartext)
export const webhookSecret = () => createHash('sha256').update('vio-tg:' + config.telegramToken).digest('hex').slice(0, 48);

let botInfo = null;
export async function getBot() {
  if (!botInfo) botInfo = await api('getMe');
  return botInfo;
}

export async function setupWebhook() {
  if (!telegramConfigured() || !config.publicUrl) return false;
  await api('setWebhook', {
    url: `${config.publicUrl}/api/telegram/webhook`, secret_token: webhookSecret(),
    allowed_updates: ['message', 'my_chat_member'], drop_pending_updates: false,
  });
  return true;
}

// ---------- Verknüpfung ----------
const linkCodes = new Map(); // code -> Ablaufzeit
export async function createLinkCode() {
  const code = randomBytes(9).toString('base64url');
  linkCodes.set(code, Date.now() + 15 * 60e3);
  const bot = await getBot();
  return { code, url: `https://t.me/${bot.username}?start=${code}`, bot: bot.username };
}
export const linkedChat = (db) => getIntegration(db, 'telegram');
export const unlinkTelegram = (db) => deleteIntegration(db, 'telegram');
export const telegramStatus = (db) => {
  const t = linkedChat(db);
  return { configured: telegramConfigured(), linked: !!t, name: t?.name || '' };
};

export async function sendToMe(db, text, extra = {}) {
  const t = linkedChat(db);
  if (!t) throw new Error('Telegram ist noch nicht mit Vio verknüpft.');
  return api('sendMessage', { chat_id: t.chat_id, text: String(text).slice(0, 4000), ...extra });
}
export async function sendToChat(chatId, text) {
  return api('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000) });
}
export const sendTyping = (chatId) => api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

/**
 * Verarbeitet ein Telegram-Update. onChat(text) liefert Vios Antwort (nur für den verknüpften Chat).
 */
export async function handleUpdate(db, update, headerSecret, onChat) {
  const expected = Buffer.from(webhookSecret());
  const got = Buffer.from(String(headerSecret || ''));
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { status: 403 };

  // Bot wurde einer Gruppe hinzugefügt / entfernt
  const mcm = update.my_chat_member;
  if (mcm && ['group', 'supergroup'].includes(mcm.chat.type)) {
    if (['member', 'administrator'].includes(mcm.new_chat_member?.status)) {
      db.prepare('INSERT INTO telegram_chats (chat_id, title, type) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title')
        .run(String(mcm.chat.id), mcm.chat.title || 'Gruppe', mcm.chat.type);
    } else db.prepare('DELETE FROM telegram_chats WHERE chat_id = ?').run(String(mcm.chat.id));
    return { status: 200 };
  }

  const msg = update.message;
  if (!msg?.chat || typeof msg.text !== 'string') return { status: 200 };
  const chatId = String(msg.chat.id);
  if (msg.chat.type !== 'private') {
    db.prepare('INSERT INTO telegram_chats (chat_id, title, type) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title')
      .run(chatId, msg.chat.title || 'Gruppe', msg.chat.type);
    return { status: 200 }; // In Gruppen hört Vio nicht zu – er schreibt dort nur, wenn du es ihm sagst
  }

  const start = msg.text.match(/^\/start\s+(\S+)/);
  if (start) {
    const exp = linkCodes.get(start[1]);
    linkCodes.delete(start[1]);
    if (exp && exp > Date.now()) {
      setIntegration(db, 'telegram', { chat_id: chatId, name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') });
      await sendToChat(chatId, '✅ Verbunden! Ab jetzt schicke ich dir hier Erinnerungen – und du kannst mir hier jederzeit schreiben.');
    } else {
      await sendToChat(chatId, 'Dieser Code ist ungültig oder abgelaufen. Öffne in Vio „Apps → Telegram verbinden“ für einen neuen Link.');
    }
    return { status: 200 };
  }

  const linked = linkedChat(db);
  if (!linked || linked.chat_id !== chatId) {
    await sendToChat(chatId, 'Ich bin ein privater Assistent und rede nur mit meinem Besitzer. 🙂');
    return { status: 200 };
  }

  await sendTyping(chatId);
  const reply = await onChat(msg.text);
  if (reply) await sendToChat(chatId, reply);
  return { status: 200 };
}
