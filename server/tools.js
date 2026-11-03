import { evaluateAction, BUDGETED_ACTIONS, FORBIDDEN_ACTIONS, ALLOWED_PAYMENT_METHODS } from './policy.js';
import { getSettings, getProtected } from './db.js';

export const TOOL_DEFS = [
  {
    name: 'remember_fact',
    description: 'Merkt sich eine dauerhafte Information über den Nutzer (Vorliebe, Person, Gewohnheit, wichtige Info). Kurz und in der dritten Person formulieren, z. B. "Mag Burger ohne Zwiebeln".',
    input_schema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'Die zu merkende Information.' },
        category: { type: 'string', enum: ['vorliebe', 'person', 'gewohnheit', 'ort', 'arbeit', 'allgemein'] },
      },
      required: ['fact'],
    },
  },
  {
    name: 'forget_fact',
    description: 'Löscht eine gespeicherte Information (ID aus dem Gedächtnis), wenn der Nutzer das möchte oder sie falsch ist.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'add_task',
    description: 'Legt eine Aufgabe auf der Aufgabenliste des Nutzers an.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        notes: { type: 'string' },
        due_at: { type: 'string', description: 'Optionales Fälligkeitsdatum im Format YYYY-MM-DD oder YYYY-MM-DD HH:MM (Europe/Berlin).' },
      },
      required: ['title'],
    },
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
        merchant: { type: 'string' },
        description: { type: 'string' },
        budget_eur: { type: ['number', 'null'], description: 'Nur ausfüllen, wenn der Nutzer selbst einen Betrag genannt hat.' },
        estimated_total_eur: { type: ['number', 'null'], description: 'Gesamtpreis inkl. Liefer-/Zusatzkosten, falls bekannt.' },
        payment_method: { type: 'string', enum: [...ALLOWED_PAYMENT_METHODS, 'vio_pays'] },
      },
      required: ['action_type', 'description'],
    },
  },
];

/** Führt ein Tool aus. Gibt { result (String für Claude), event (für die App) } zurück. */
export function runTool(db, name, input, ctx) {
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
      const { lastInsertRowid } = db.prepare('INSERT INTO tasks (title, notes, due_at) VALUES (?, ?, ?)')
        .run(title, input.notes ? String(input.notes).slice(0, 1000) : null, input.due_at ? String(input.due_at).slice(0, 16) : null);
      return { result: `Aufgabe #${lastInsertRowid} angelegt.`, event: { type: 'task', id: Number(lastInsertRowid), title } };
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
        ? ' HINWEIS: Die Ausführung (Telefonie/Bestellung) ist in dieser Version noch nicht eingerichtet. Sag dem Nutzer ehrlich, dass du die Bestellung vorbereitet, aber nicht abgeschickt hast.'
        : '';
      return {
        result: `Entscheidung: ${verdict.decision}. Grund: ${verdict.reason}${exec}`,
        event: { type: 'policy', decision: verdict.decision, reason: verdict.reason },
      };
    }
    default:
      return { result: `Unbekanntes Werkzeug: ${name}` };
  }
}
