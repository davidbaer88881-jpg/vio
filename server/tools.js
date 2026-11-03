import { evaluateAction, BUDGETED_ACTIONS, FORBIDDEN_ACTIONS, ALLOWED_PAYMENT_METHODS } from './policy.js';
import { getSettings, getProtected } from './db.js';
import * as google from './google.js';
import * as telegram from './telegram.js';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const DATE_HINT = 'Berliner Ortszeit im Format JJJJ-MM-TT HH:MM (oder nur JJJJ-MM-TT für ganztägig).';
const REPEAT = { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'], description: 'Wiederholung (optional).' };

// ---------- Basis-Werkzeuge (immer verfügbar) ----------
const BASE_TOOLS = [
  {
    name: 'remember_fact',
    description: 'Merkt sich eine dauerhafte Information über den Nutzer (Vorliebe, Person, Gewohnheit, wichtige Info). Kurz und in der dritten Person formulieren, z. B. "Mag Burger ohne Zwiebeln".',
    input_schema: { type: 'object', properties: { fact: S('Die zu merkende Information.'), category: { type: 'string', enum: ['vorliebe', 'person', 'gewohnheit', 'ort', 'arbeit', 'allgemein'] } }, required: ['fact'] },
  },
  {
    name: 'forget_fact',
    description: 'Löscht eine gespeicherte Information (ID aus dem Gedächtnis), wenn der Nutzer das möchte oder sie falsch ist.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'add_task',
    description: 'Legt eine Aufgabe/Erinnerung an. MIT Uhrzeit in due_at erinnert Vio zur Uhrzeit per Telegram (falls verbunden). Für wiederkehrende Erinnerungen repeat setzen.',
    input_schema: { type: 'object', properties: { title: S('Kurzer Titel'), notes: S('Notizen'), due_at: S(`Fälligkeit. ${DATE_HINT}`), repeat: REPEAT }, required: ['title'] },
  },
  {
    name: 'complete_task',
    description: 'Markiert eine Aufgabe (ID) als erledigt.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'check_paid_action',
    description: 'PFLICHT vor jeder Aktion, die Geld kosten kann (Bestellung, Reservierung, Buchung, Termin, Dienstleistung). Prüft die festen Budget- und Zahlungsregeln und gibt allow / deny / ask_user / need_price zurück.',
    input_schema: {
      type: 'object',
      properties: {
        action_type: { type: 'string', enum: [...BUDGETED_ACTIONS, ...Object.keys(FORBIDDEN_ACTIONS)] },
        merchant: S('Anbieter'), description: S('Was genau'),
        budget_eur: { type: ['number', 'null'], description: 'Nur ausfüllen, wenn der Nutzer selbst einen Betrag genannt hat.' },
        estimated_total_eur: { type: ['number', 'null'], description: 'Gesamtpreis inkl. Liefer-/Zusatzkosten, falls bekannt.' },
        payment_method: { type: 'string', enum: [...ALLOWED_PAYMENT_METHODS, 'vio_pays'] },
      },
      required: ['action_type', 'description'],
    },
  },
  {
    name: 'prepare_message',
    description: 'Bereitet eine WhatsApp- oder SMS-Nachricht vor. Der Nutzer bekommt einen Knopf, der die App mit dem fertigen Text öffnet – er drückt selbst auf Senden. (Vio kann WhatsApp/SMS nicht selbst verschicken.)',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['whatsapp', 'sms'] },
        text: S('Der Nachrichtentext'),
        contact_name: S('Name des Empfängers (falls bekannt)'),
        phone: S('Telefonnummer im internationalen Format, z. B. +4917612345678 (nur wenn bekannt; sonst wählt der Nutzer den Kontakt)'),
      },
      required: ['channel', 'text'],
    },
  },
  {
    name: 'prepare_call',
    description: 'Bereitet einen Anruf vor: zeigt einen Gesprächsleitfaden und einen Knopf, der die Telefon-App mit der Nummer öffnet. Der Nutzer telefoniert selbst. (Selbstständiges Anrufen durch Vio ist noch nicht eingerichtet.)',
    input_schema: {
      type: 'object',
      properties: {
        contact_name: S('Wen anrufen (z. B. "Burger King Forchheim")'),
        phone: S('Telefonnummer, falls bekannt'),
        purpose: S('Ziel des Anrufs in einem Satz'),
        script: S('Kurzer Gesprächsleitfaden mit den wichtigsten Punkten/Fragen'),
      },
      required: ['purpose', 'script'],
    },
  },
];

const CALENDAR_TOOLS = [
  {
    name: 'calendar_list_events',
    description: 'Listet Termine aus dem Google Kalender des Nutzers in einem Zeitraum (Standard: nächste 7 Tage).',
    input_schema: { type: 'object', properties: { from: S(`Beginn. ${DATE_HINT}`), to: S(`Ende. ${DATE_HINT}`), query: S('Suchbegriff (optional)') } },
  },
  {
    name: 'calendar_create_event',
    description: 'Legt einen Termin im Google Kalender an. Meldet Überschneidungen mit anderen Terminen zurück – weise den Nutzer darauf hin.',
    input_schema: {
      type: 'object',
      properties: {
        title: S('Titel'), start: S(`Start. ${DATE_HINT}`), end: S(`Ende (optional, Standard 1 Std.). ${DATE_HINT}`),
        all_day: { type: 'boolean' }, location: S('Ort'), description: S('Beschreibung'), recurrence: REPEAT,
        reminder_minutes: { type: 'integer', description: 'Google-Erinnerung X Minuten vorher (optional)' },
      },
      required: ['title', 'start'],
    },
  },
  {
    name: 'calendar_update_event',
    description: 'Ändert einen bestehenden Termin (ID aus calendar_list_events). Nur die zu ändernden Felder angeben.',
    input_schema: {
      type: 'object',
      properties: { id: S('Termin-ID'), title: S('Titel'), start: S(DATE_HINT), end: S(DATE_HINT), all_day: { type: 'boolean' }, location: S('Ort'), description: S('Beschreibung') },
      required: ['id'],
    },
  },
  {
    name: 'calendar_delete_event',
    description: 'Löscht einen Termin (ID aus calendar_list_events). Nur nach ausdrücklicher Bestätigung des Nutzers.',
    input_schema: { type: 'object', properties: { id: S('Termin-ID'), user_confirmed: { type: 'boolean' } }, required: ['id', 'user_confirmed'] },
  },
];

const GMAIL_TOOLS = [
  {
    name: 'gmail_search',
    description: 'Sucht E-Mails im Gmail-Postfach des Nutzers (Gmail-Suchsyntax, z. B. "is:unread", "from:amazon newer_than:7d"). Liefert Absender, Betreff, Datum, Vorschau und ID.',
    input_schema: { type: 'object', properties: { query: S('Gmail-Suchanfrage'), max: { type: 'integer' } } },
  },
  {
    name: 'gmail_read',
    description: 'Liest eine E-Mail vollständig (ID aus gmail_search).',
    input_schema: { type: 'object', properties: { id: S('Mail-ID') }, required: ['id'] },
  },
  {
    name: 'gmail_draft',
    description: 'Erstellt einen E-Mail-Entwurf (neue Mail oder Antwort) und zeigt ihn dem Nutzer. Danach fragen, ob er so raus soll.',
    input_schema: {
      type: 'object',
      properties: {
        to: S('Empfänger-Adresse (bei Antwort optional)'), subject: S('Betreff (bei Antwort optional)'), body: S('Text der Mail'),
        reply_to_id: S('ID der Mail, auf die geantwortet wird (optional)'),
      },
      required: ['body'],
    },
  },
  {
    name: 'gmail_send',
    description: 'Sendet einen zuvor erstellten Entwurf (draft_id). Funktioniert nur, wenn der Nutzer den Entwurf gesehen und danach zugestimmt hat.',
    input_schema: { type: 'object', properties: { draft_id: { type: 'integer' } }, required: ['draft_id'] },
  },
];

const TELEGRAM_TOOLS = [
  {
    name: 'telegram_send',
    description: 'Schickt eine Telegram-Nachricht – an den Nutzer selbst ("me") oder in eine Gruppe, in der Vios Bot Mitglied ist (Gruppenname). Bei Gruppen vorher Text zeigen und bestätigen lassen (user_confirmed=true).',
    input_schema: { type: 'object', properties: { chat: S('"me" oder Name der Gruppe'), text: S('Nachricht'), user_confirmed: { type: 'boolean' } }, required: ['chat', 'text'] },
  },
];

/** Welche Werkzeuge gerade verfügbar sind – abhängig davon, was verbunden ist. */
export function getToolDefs(db) {
  const tools = [...BASE_TOOLS];
  const g = google.googleStatus(db);
  if (g.connected && g.scope.includes('calendar')) tools.push(...CALENDAR_TOOLS);
  if (g.connected && g.scope.includes('gmail')) tools.push(...GMAIL_TOOLS);
  if (telegram.telegramStatus(db).linked) tools.push(...TELEGRAM_TOOLS);
  return tools;
}
export const TOOL_DEFS = BASE_TOOLS; // für Tests/Abwärtskompatibilität

const drafts = new Map(); // E-Mail-Entwürfe im Speicher
let draftSeq = 0;
const digits = (p) => String(p || '').replace(/[^\d+]/g, '');
const fmtEvent = (e) => `#${e.id} | ${e.all_day ? e.start.slice(0, 10) + ' ganztägig' : google.fmtBerlin(e.start) + '–' + google.fmtBerlin(e.end, false)} | ${e.title}${e.location ? ' | ' + e.location : ''}`;
const conflictText = (c) => (c.length ? ` ⚠️ Überschneidung mit: ${c.map((e) => `${e.title} (${google.fmtBerlin(e.start)})`).join(', ')}. Weise den Nutzer darauf hin.` : ' Keine Überschneidungen.');

/** Führt ein Werkzeug aus. Gibt { result (Text für die KI), event (für die App) } zurück. */
export async function runTool(db, name, input, ctx) {
  try {
    return await runToolInner(db, name, input || {}, ctx);
  } catch (e) {
    return { result: `Fehler: ${e.message}`, event: { type: 'tool', label: `⚠️ ${e.message}`, kind: 'deny' } };
  }
}

async function runToolInner(db, name, input, ctx) {
  switch (name) {
    case 'remember_fact': {
      const mode = getSettings(db).memory_mode;
      if (mode === 'off') return { result: 'Gedächtnis ist ausgeschaltet – nichts gespeichert.' };
      const text = String(input.fact || '').trim().slice(0, 300);
      if (!text) return { result: 'Leerer Fakt – nichts gespeichert.' };
      const status = mode === 'auto' ? 'active' : 'pending';
      const { lastInsertRowid } = db.prepare('INSERT INTO facts (text, category, status) VALUES (?, ?, ?)')
        .run(text, String(input.category || 'allgemein'), status);
      return {
        result: status === 'active' ? `Gespeichert (#${lastInsertRowid}).` : `Zur Bestätigung vorgelegt (#${lastInsertRowid}). Der Nutzer entscheidet in der App.`,
        event: { type: 'fact', id: Number(lastInsertRowid), text, status },
      };
    }
    case 'forget_fact': {
      const r = db.prepare('DELETE FROM facts WHERE id = ?').run(Number(input.id));
      return { result: r.changes ? 'Gelöscht.' : 'Nicht gefunden.', event: { type: 'tool', label: 'Erinnerung gelöscht' } };
    }
    case 'add_task': {
      const title = String(input.title || '').trim().slice(0, 200);
      if (!title) return { result: 'Titel fehlt.' };
      const due = input.due_at ? String(input.due_at).replace('T', ' ').slice(0, 16) : null;
      if (due && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(due)) return { result: `Ungültiges Datum "${due}". Format: JJJJ-MM-TT HH:MM.` };
      const repeat = ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(input.repeat) ? input.repeat : null;
      const { lastInsertRowid } = db.prepare('INSERT INTO tasks (title, notes, due_at, repeat) VALUES (?, ?, ?, ?)')
        .run(title, input.notes ? String(input.notes).slice(0, 1000) : null, due, repeat);
      const tg = telegram.telegramStatus(db).linked;
      const hint = due && due.length > 10 ? (tg ? ' Erinnerung kommt zur Uhrzeit per Telegram.' : ' Hinweis: Telegram ist nicht verbunden, daher gibt es keine Push-Erinnerung – nur in der App.') : '';
      return { result: `Aufgabe #${lastInsertRowid} angelegt.${hint}`, event: { type: 'task', id: Number(lastInsertRowid), title, due_at: due, repeat } };
    }
    case 'complete_task': {
      const r = db.prepare("UPDATE tasks SET done = 1, done_at = datetime('now') WHERE id = ? AND done = 0").run(Number(input.id));
      return { result: r.changes ? 'Erledigt.' : 'Aufgabe nicht gefunden oder schon erledigt.', event: { type: 'tool', label: 'Aufgabe abgehakt' } };
    }
    case 'check_paid_action': {
      const verdict = evaluateAction(input, { userTexts: ctx.userTexts, maxBudgetEur: getProtected(db).max_budget_eur });
      db.prepare('INSERT INTO action_log (action_type, payload, decision, reason) VALUES (?, ?, ?, ?)')
        .run(String(input.action_type), JSON.stringify(input), verdict.decision, verdict.reason);
      const exec = verdict.decision === 'allow'
        ? ' HINWEIS: Vio kann noch nicht selbst anrufen oder bestellen. Bereite die Bestellung mit prepare_call vor (Leitfaden mit Budget-Grenze) und sag ehrlich, dass der Nutzer selbst anruft.'
        : '';
      return { result: `Entscheidung: ${verdict.decision}. Grund: ${verdict.reason}${exec}`, event: { type: 'policy', decision: verdict.decision, reason: verdict.reason } };
    }
    case 'prepare_message': {
      const text = String(input.text || '').slice(0, 2000);
      const phone = digits(input.phone);
      const channel = input.channel === 'sms' ? 'sms' : 'whatsapp';
      const url = channel === 'whatsapp'
        ? `https://wa.me/${phone.replace('+', '')}?text=${encodeURIComponent(text)}`
        : `sms:${phone}?body=${encodeURIComponent(text)}`;
      return {
        result: 'Nachricht vorbereitet. Der Nutzer sieht einen Knopf zum Öffnen und schickt sie selbst ab.',
        event: { type: 'message', channel, text, phone, contact_name: input.contact_name || '', url, needs_contact: !phone },
      };
    }
    case 'prepare_call': {
      const phone = digits(input.phone);
      return {
        result: 'Anruf vorbereitet. Der Nutzer sieht Leitfaden und Anruf-Knopf und telefoniert selbst.',
        event: { type: 'call', contact_name: input.contact_name || '', phone, purpose: input.purpose || '', script: String(input.script || '').slice(0, 1500), needs_contact: !phone },
      };
    }
    // ---------- Kalender ----------
    case 'calendar_list_events': {
      const evs = await google.listEvents(db, input);
      return { result: evs.length ? evs.map(fmtEvent).join('\n') : 'Keine Termine in diesem Zeitraum.', event: { type: 'tool', label: `📅 ${evs.length} Termin(e) gelesen` } };
    }
    case 'calendar_create_event': {
      const { event, conflicts } = await google.createEvent(db, input);
      return { result: `Termin angelegt: ${fmtEvent(event)}.${conflictText(conflicts)}`, event: { type: 'calendar', action: 'created', title: event.title, start: event.start, all_day: event.all_day, conflicts: conflicts.map((c) => c.title) } };
    }
    case 'calendar_update_event': {
      const { id, ...rest } = input;
      const { event, conflicts } = await google.updateEvent(db, id, rest);
      return { result: `Termin geändert: ${fmtEvent(event)}.${conflictText(conflicts)}`, event: { type: 'calendar', action: 'updated', title: event.title, start: event.start, all_day: event.all_day, conflicts: conflicts.map((c) => c.title) } };
    }
    case 'calendar_delete_event': {
      if (input.user_confirmed !== true) return { result: 'Nicht gelöscht: Frag den Nutzer zuerst ausdrücklich, ob der Termin wirklich gelöscht werden soll.' };
      await google.deleteEvent(db, input.id);
      return { result: 'Termin gelöscht.', event: { type: 'tool', label: '🗑️ Termin gelöscht' } };
    }
    // ---------- Gmail ----------
    case 'gmail_search': {
      const mails = await google.searchMail(db, input);
      return {
        result: mails.length ? mails.map((m) => `#${m.id} | ${m.unread ? '[ungelesen] ' : ''}${m.from} | ${m.subject} | ${m.date} | ${m.snippet}`).join('\n') : 'Keine Mails gefunden.',
        event: { type: 'tool', label: `✉️ ${mails.length} Mail(s) gefunden` },
      };
    }
    case 'gmail_read': {
      const m = await google.readMail(db, input.id);
      return { result: `Von: ${m.from}\nAn: ${m.to}\nBetreff: ${m.subject}\nDatum: ${m.date}\n\n${m.body}`, event: { type: 'tool', label: `✉️ Mail gelesen: ${m.subject}` } };
    }
    case 'gmail_draft': {
      const id = ++draftSeq;
      drafts.set(id, { payload: { to: input.to, subject: input.subject, body: String(input.body || ''), reply_to_id: input.reply_to_id }, turn: ctx.turnId });
      return {
        result: `Entwurf #${id} erstellt und dem Nutzer angezeigt. Frag ihn, ob er so raus soll. Senden erst nach seiner Zustimmung mit gmail_send(draft_id=${id}).`,
        event: { type: 'draft', id, to: input.to || '(Antwort an Absender)', subject: input.subject || '(Antwort)', body: String(input.body || '') },
      };
    }
    case 'gmail_send': {
      const d = drafts.get(Number(input.draft_id));
      // Technische Sperre: Der Entwurf muss aus einer FRÜHEREN Runde stammen – der Nutzer hat ihn also gesehen und danach geantwortet.
      if (!d) return { result: 'Entwurf nicht gefunden. Erstelle zuerst mit gmail_draft einen Entwurf und zeig ihn dem Nutzer.' };
      if (!(d.turn < ctx.turnId)) return { result: 'NICHT gesendet: Der Nutzer hat den Entwurf noch nicht bestätigt. Zeig ihn und warte auf seine Antwort.' };
      const r = await google.sendMail(db, d.payload);
      drafts.delete(Number(input.draft_id));
      return { result: `Gesendet an ${r.to} (Betreff: ${r.subject}).`, event: { type: 'tool', label: `✉️ Mail gesendet an ${r.to}`, kind: 'allow' } };
    }
    // ---------- Telegram ----------
    case 'telegram_send': {
      const chat = String(input.chat || 'me');
      if (chat === 'me') {
        await telegram.sendToMe(db, input.text);
        return { result: 'An dich per Telegram geschickt.', event: { type: 'tool', label: '📨 Telegram-Nachricht an dich gesendet', kind: 'allow' } };
      }
      const groups = db.prepare('SELECT chat_id, title FROM telegram_chats').all();
      const g = groups.find((x) => x.title.toLowerCase() === chat.toLowerCase()) || groups.find((x) => x.title.toLowerCase().includes(chat.toLowerCase()));
      if (!g) return { result: `Gruppe "${chat}" nicht gefunden. Bekannte Gruppen: ${groups.map((x) => x.title).join(', ') || 'keine (Bot erst in die Gruppe einladen)'}.` };
      if (input.user_confirmed !== true) return { result: `Noch nicht gesendet. Zeig dem Nutzer den Text für „${g.title}“ und frag nach Bestätigung.` };
      await telegram.sendToChat(g.chat_id, input.text);
      return { result: `In „${g.title}“ gesendet.`, event: { type: 'tool', label: `📨 In „${g.title}“ gesendet`, kind: 'allow' } };
    }
    default:
      return { result: `Unbekanntes Werkzeug: ${name}` };
  }
}
