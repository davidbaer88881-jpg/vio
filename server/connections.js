import { config } from './config.js';

// Ehrlicher Verbindungsstatus. Nichts wird als "verbunden" angezeigt, was nicht wirklich läuft.
// Neue Integrationen werden hier registriert (erweiterbares Integrationssystem).
export function getConnections(settings = {}) {
  const hasBrain = !!(config.geminiKey || config.apiKey);
  const brain = settings.ai_provider === 'claude' && config.apiKey ? 'Claude'
    : config.geminiKey ? 'Gemini' : config.apiKey ? 'Claude' : '';
  return [
    { id: 'ai', name: brain ? `KI-Gehirn (${brain})` : 'KI-Gehirn', status: hasBrain ? 'connected' : 'missing_key', phase: 4 },
    { id: 'tasks', name: 'Aufgaben (intern)', status: 'connected', phase: 1 },
    { id: 'memory', name: 'Gedächtnis (intern)', status: 'connected', phase: 1 },
    { id: 'backup', name: 'Datensicherung (Supabase)', status: config.supabaseUrl && config.supabaseKey ? 'connected' : 'optional', phase: 1 },
    { id: 'google_calendar', name: 'Google Kalender', status: 'planned', phase: 7 },
    { id: 'telegram', name: 'Telegram', status: 'planned', phase: 8 },
    { id: 'gmail', name: 'Gmail', status: 'planned', phase: 8 },
    { id: 'whatsapp', name: 'WhatsApp', status: 'planned', phase: 8 },
    { id: 'phone', name: 'Telefonie', status: 'planned', phase: 9 },
    { id: 'web_search', name: 'Websuche & Preise', status: 'planned', phase: 8 },
  ];
}
