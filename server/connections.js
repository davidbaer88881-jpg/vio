import { config } from './config.js';
import { googleConfigured, googleStatus } from './google.js';
import { telegramStatus } from './telegram.js';
import { tgUserStatus } from './tguser.js';

// Ehrlicher Verbindungsstatus. Nichts wird als "verbunden" angezeigt, was nicht wirklich läuft.
// status: connected | missing_key | available (eingerichtet, aber noch nicht verknüpft) | needs_setup | limited | planned
export function getConnections(settings = {}, db = null) {
  const brain = settings.ai_provider === 'claude' && config.apiKey ? 'Claude' : config.geminiKey ? 'Gemini' : config.apiKey ? 'Claude' : '';
  const g = db ? googleStatus(db) : { connected: false };
  const t = db ? telegramStatus(db) : { configured: false, linked: false };
  const u = db ? tgUserStatus(db) : { configured: false, connected: false };
  const gState = g.connected ? 'connected' : googleConfigured() ? 'available' : 'needs_setup';
  return [
    { id: 'ai', name: brain ? `KI-Gehirn (${brain})` : 'KI-Gehirn', status: brain ? 'connected' : 'missing_key' },
    { id: 'tasks', name: 'Aufgaben & Erinnerungen', status: 'connected' },
    { id: 'memory', name: 'Gedächtnis', status: 'connected' },
    { id: 'backup', name: 'Datensicherung (Supabase)', status: config.supabaseUrl && config.supabaseKey ? 'connected' : 'needs_setup' },
    { id: 'google_calendar', name: 'Google Kalender', status: gState, detail: g.email || '' },
    { id: 'gmail', name: 'Gmail', status: gState, detail: g.email || '' },
    { id: 'telegram', name: 'Telegram-Bot (Erinnerungen)', status: t.linked ? 'connected' : t.configured ? 'available' : 'needs_setup', detail: t.name || '' },
    { id: 'telegram_user', name: 'Telegram (dein Konto)', status: u.connected ? 'connected' : u.configured ? 'available' : 'needs_setup', detail: u.connected ? `als ${u.name} – Vio schreibt direkt in deinem Namen` : '' },
    { id: 'whatsapp', name: 'WhatsApp', status: 'limited', detail: 'Vio schreibt, du tippst auf Senden' },
    { id: 'sms', name: 'SMS', status: 'limited', detail: 'Vio schreibt, du tippst auf Senden' },
    { id: 'phone', name: 'Telefon', status: 'limited', detail: 'Vio bereitet vor, du rufst an' },
    { id: 'web_search', name: 'Websuche & Preise', status: 'planned' },
  ];
}
