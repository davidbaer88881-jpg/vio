// Hintergrund-Aufgaben: Erinnerungen zur Uhrzeit, wiederkehrende Aufgaben, Tagesübersicht am Morgen.
// Läuft jede Minute auf dem Server. Auf Render Free schläft der Server nach 15 Min. ohne Besuch –
// dafür sorgt ein kostenloser Weck-Dienst (siehe Anleitung), der /api/health regelmäßig aufruft.
import { config } from './config.js';
import { getSettings, saveSettings } from './db.js';
import { linkedChat, sendToMe } from './telegram.js';
import { googleStatus, listEvents, fmtBerlin } from './google.js';

/** Aktuelle Berliner Zeit als { date: 'YYYY-MM-DD', time: 'HH:MM', stamp: 'YYYY-MM-DD HH:MM', weekday: 0-6 } */
export function berlinNow(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(now).reduce((a, x) => ({ ...a, [x.type]: x.value }), {});
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}`;
  return { date, time, stamp: `${date} ${time}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

/** Nächster Termin einer wiederkehrenden Aufgabe (lokales Datum/Uhrzeit-String). */
export function nextOccurrence(due, repeat) {
  const [d, t = ''] = due.split(' ');
  const dt = new Date(d + 'T00:00:00Z');
  const step = () => {
    if (repeat === 'daily' || repeat === 'weekdays') dt.setUTCDate(dt.getUTCDate() + 1);
    else if (repeat === 'weekly') dt.setUTCDate(dt.getUTCDate() + 7);
    else if (repeat === 'monthly') {
      const day = dt.getUTCDate();
      dt.setUTCDate(1); dt.setUTCMonth(dt.getUTCMonth() + 1);
      const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
      dt.setUTCDate(Math.min(day, last)); // 31. → letzter Tag des Monats
    }
    else if (repeat === 'yearly') dt.setUTCFullYear(dt.getUTCFullYear() + 1);
  };
  step();
  if (repeat === 'weekdays') while ([0, 6].includes(dt.getUTCDay())) dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10) + (t ? ' ' + t : '');
}

export async function tick(db, now = new Date()) {
  const n = berlinNow(now);
  const settings = getSettings(db);
  const sent = [];
  const tg = linkedChat(db);

  // 1) Fällige Erinnerungen (nur Aufgaben mit Uhrzeit)
  const due = db.prepare("SELECT * FROM tasks WHERE done = 0 AND reminded_at IS NULL AND length(due_at) >= 16 AND due_at <= ?").all(n.stamp);
  for (const t of due) {
    if (tg && settings.telegram_reminders) {
      try { await sendToMe(db, `⏰ Erinnerung: ${t.title}${t.notes ? `\n${t.notes}` : ''}`); sent.push(t.id); } catch (e) { console.error(e.message); continue; }
    }
    if (t.repeat) {
      db.prepare('UPDATE tasks SET due_at = ?, reminded_at = NULL WHERE id = ?').run(nextOccurrence(t.due_at, t.repeat), t.id);
    } else {
      db.prepare("UPDATE tasks SET reminded_at = datetime('now') WHERE id = ?").run(t.id);
    }
  }

  // 2) Tagesübersicht am Morgen (einmal pro Tag, zur eingestellten Uhrzeit oder kurz danach)
  const bt = settings.morning_briefing;
  if (tg && /^\d{2}:\d{2}$/.test(bt || '') && n.time >= bt && settings.last_briefing !== n.date) {
    saveSettings(db, { last_briefing: n.date });
    try { await sendToMe(db, await buildBriefing(db, n)); sent.push('briefing'); } catch (e) { console.error(e.message); }
  }
  return sent;
}

export async function buildBriefing(db, n = berlinNow()) {
  const name = getSettings(db).user_name;
  const lines = [`☀️ Guten Morgen, ${name}! Dein Tag (${new Date(n.date + 'T12:00:00Z').toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })}):`];
  if (googleStatus(db).connected) {
    try {
      const evs = await listEvents(db, { from: `${n.date} 00:00`, to: `${n.date} 23:59` });
      lines.push('', evs.length ? '📅 Termine:' : '📅 Keine Termine heute.');
      for (const e of evs) lines.push(`• ${e.all_day ? 'ganztägig' : fmtBerlin(e.start, false)} – ${e.title}${e.location ? ` (${e.location})` : ''}`);
    } catch (e) { lines.push('', `📅 Kalender gerade nicht erreichbar (${e.message}).`); }
  }
  const tasks = db.prepare("SELECT title, due_at FROM tasks WHERE done = 0 AND (due_at IS NULL OR substr(due_at, 1, 10) <= ?) ORDER BY due_at IS NULL, due_at LIMIT 10").all(n.date);
  lines.push('', tasks.length ? '✅ Offene Aufgaben:' : '✅ Keine offenen Aufgaben.');
  for (const t of tasks) lines.push(`• ${t.title}${t.due_at ? ` (${t.due_at.slice(0, 10) < n.date ? 'überfällig' : t.due_at.length > 10 ? t.due_at.slice(11) : 'heute'})` : ''}`);
  return lines.join('\n');
}

export function startScheduler(db, onChange) {
  const run = () => tick(db).then((sent) => { if (sent.length) onChange?.(); }).catch((e) => console.error('Scheduler:', e.message));
  setTimeout(run, 5000);
  return setInterval(run, 60e3);
}
