import { api, streamChat, AuthError, isNetworkError } from './api.js';
import * as outbox from './outbox.js';
import * as voice from './voice.js';

// ============================================================================
//  Zustand & Helfer
// ============================================================================
const state = {
  settings: null,
  convId: null,
  messages: [],          // { role, content } | { role: 'event', kind, html }
  convTitle: '',
  streaming: null,       // AbortController
  installPrompt: null,
  handsfreeActive: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const view = () => $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  history: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/></svg>',
  speaker: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4"/></svg>',
  brain: '<svg viewBox="0 0 24 24"><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1"/></svg>',
  apps: '<svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/></svg>',
};

function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

/** Minimaler, sicherer Markdown-Renderer (erst escapen, dann formatieren). */
function md(text) {
  let s = esc(text);
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c.trim()}</code></pre>`);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/(?:^|\n)((?:[-•] .+(?:\n|$))+)/g, (_, block) =>
    '<ul>' + block.trim().split('\n').map((l) => `<li>${l.replace(/^[-•] /, '')}</li>`).join('') + '</ul>');
  return s.replace(/\n/g, '<br>');
}

function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') || iso.includes('+') ? '' : 'Z'));
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'gerade eben';
  if (diff < 3600) return `vor ${Math.floor(diff / 60)} Min.`;
  if (diff < 86400) return `vor ${Math.floor(diff / 3600)} Std.`;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}
function fmtDue(due) {
  if (!due) return '';
  const d = new Date(due.length <= 10 ? due + 'T00:00' : due.replace(' ', 'T'));
  if (isNaN(d)) return due;
  const opts = { weekday: 'short', day: '2-digit', month: '2-digit' };
  if (due.length > 10) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('de-DE', opts);
}

function greeting(name) {
  const h = new Date().getHours();
  const g = h < 5 ? 'Noch wach' : h < 11 ? 'Guten Morgen' : h < 14 ? 'Mahlzeit' : h < 18 ? 'Hey' : h < 22 ? 'Guten Abend' : 'Spät dran';
  return `${g}, ${name}`;
}
export const VERSION = '0.7.0';
const QUIPS = [
  'Was steht an? Ich bin ganz Ohr – im übertragenen Sinne.',
  'Sag einfach, was du brauchst. Ich kümmer mich.',
  'Bereit, wenn du es bist.',
  'Heute schon was vergessen? Dafür bin ich ja da.',
  'Tipp auf den Knopf und leg los.',
];

// ============================================================================
//  Router
// ============================================================================
const routes = {
  '': renderHome, chat: renderChat, history: renderHistory, tasks: renderTasks, apps: renderApps,
  more: renderMore, calendar: renderCalendar, phone: renderPhone, reminders: renderReminders,
  memory: renderMemory, settings: renderSettings,
};

async function route() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  state.query = new URLSearchParams(query);
  const [, name = '', arg] = path.split('/');
  const fn = routes[name] || renderHome;
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const n = a.dataset.nav;
    a.classList.toggle('active', n === (name || 'home') || (n === 'more' && ['calendar', 'phone', 'reminders', 'memory', 'settings', 'apps'].includes(name)) || (n === 'chat' && name === 'history'));
  });
  if (name !== 'chat') { voice.stopListening(); }
  try {
    await fn(arg);
  } catch (e) {
    if (e instanceof AuthError) return renderLogin();
    if (isNetworkError(e)) return renderOffline(name);
    view().innerHTML = `<div class="empty">Fehler: ${esc(e.message)}</div>`;
  }
  window.scrollTo(0, name === 'chat' ? document.body.scrollHeight : 0);
}
window.addEventListener('hashchange', route);

// ============================================================================
//  Login
// ============================================================================
function renderLogin() {
  $('#nav').hidden = true;
  view().innerHTML = `
    <section class="login">
      <div class="avatar">V</div>
      <h1>Hey, ich bin Vio.</h1>
      <p class="sub">Bitte melde dich an.</p>
      <form id="login-form" autocomplete="on">
        <input type="text" name="username" value="owner" autocomplete="username" hidden>
        <input class="input" type="password" name="password" placeholder="Passwort" autocomplete="current-password" required>
        <button class="btn primary" type="submit">Anmelden</button>
        <div class="error" id="login-err"></div>
      </form>
    </section>`;
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const password = e.target.password.value;
    try {
      await api('/api/auth/login', { method: 'POST', body: { password } });
      await boot();
    } catch (err) { $('#login-err').textContent = err.message; }
  };
}

// ============================================================================
//  Startseite
// ============================================================================
// ---------- Schnellspeicher: Seiten sofort mit letztem Stand zeigen, dann im Hintergrund auffrischen ----------
function readCache(path) { try { return JSON.parse(localStorage.getItem('swr:' + path) || 'null'); } catch { return null; } }
function writeCache(path, data) { try { localStorage.setItem('swr:' + path, JSON.stringify(data)); } catch {} }
function clearCaches() { try { Object.keys(localStorage).filter((k) => k.startsWith('swr:') || k === 'vio-settings').forEach((k) => localStorage.removeItem(k)); } catch {} }
async function swr(path, render) {
  const token = (state.renderToken = Symbol(path));
  const cached = readCache(path);
  if (cached) render(cached);
  let fresh;
  try { fresh = await api(path); } catch (e) { if (cached && (isNetworkError(e))) return; throw e; }
  writeCache(path, fresh);
  if (state.renderToken !== token) return; // Nutzer ist schon woanders
  if (!cached || JSON.stringify(cached) !== JSON.stringify(fresh)) render(fresh);
}

// Tageszeit-Farbe der Aura
function setDaypart() {
  const h = new Date().getHours();
  document.documentElement.dataset.daypart = h >= 5 && h < 11 ? 'morning' : h >= 11 && h < 17 ? 'day' : h >= 17 && h < 22 ? 'evening' : 'night';
}
setDaypart(); setInterval(setDaypart, 10 * 60e3);

const todayKey = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const hhmm = (iso) => new Date(iso).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });

/** Termine + Aufgaben zu einer Zeitleiste für heute zusammenführen. */
function buildToday(events, tasks) {
  const today = todayKey();
  const items = [];
  for (const e of events || []) {
    if (dayKey(e.start, e.all_day) !== today) continue;
    items.push({ kind: 'event', sort: e.all_day ? '00:00' : hhmm(e.start), time: e.all_day ? 'Ganztags' : hhmm(e.start), title: e.title, meta: [e.all_day ? '' : `bis ${hhmm(e.end)}`, e.location].filter(Boolean).join(', '), id: e.id, start: e.start, end: e.end, all_day: e.all_day });
  }
  for (const t of tasks || []) {
    if (!t.due_at || t.due_at.slice(0, 10) > today) continue;
    const overdue = t.due_at.slice(0, 10) < today;
    items.push({ kind: 'task', sort: overdue ? '00:00' : t.due_at.length > 10 ? t.due_at.slice(11) : '23:59', time: overdue ? 'Offen' : t.due_at.length > 10 ? t.due_at.slice(11) : 'Heute', title: t.title, meta: [overdue ? `fällig seit ${fmtDue(t.due_at)}` : '', t.repeat ? `🔁 ${REPEAT_LABEL[t.repeat] || ''}` : ''].filter(Boolean).join(' · '), task: t });
  }
  items.sort((a, b) => a.sort.localeCompare(b.sort));
  // Überschneidungen markieren
  const timed = items.filter((i) => i.kind === 'event' && !i.all_day);
  for (const a of timed) for (const b of timed) if (a !== b && Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end)) a.conflict = true;
  return items;
}

async function renderHome() {
  await swr('/api/home', paintHome);
}

function paintHome(data) {
  state.settings = data.settings; cacheSettings(data.settings);
  const name = data.settings.user_name && data.settings.user_name !== 'du' ? data.settings.user_name : '';
  const keep = $('#ask input')?.value || '';
  if (!state.quip) state.quip = QUIPS[Math.floor(Math.random() * QUIPS.length)];
  const brain = data.connections.find((c) => c.id === 'ai');
  const today = buildToday(data.events, data.tasks);
  const undated = (data.tasks || []).filter((t) => !t.due_at);
  const later = (data.events || []).filter((e) => dayKey(e.start, e.all_day) > todayKey()).slice(0, 3);
  const dateLine = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

  view().innerHTML = `
    <div class="home-top"><span>${esc(dateLine)}</span><a class="avatar-btn" href="#/settings" aria-label="Einstellungen">${esc((name || 'V').slice(0, 1))}</a></div>
    <div class="greeting">${esc(greeting('').replace(/,\s*$/, ''))}${name ? `,<br><span class="name">${esc(name)}.</span>` : '.'}</div>
    <p class="quip">${esc(state.quip)}</p>

    <div class="aura-stage">
      <button class="aura" id="orb" aria-label="Gespräch mit Vio starten">${ICON.mic}</button>
      <div class="aura-label">Tippen und lossprechen</div>
    </div>

    <form class="ask" id="ask">
      <input class="input" name="q" placeholder="Oder schreib Vio etwas …" autocomplete="off" enterkeyhint="send" value="${esc(keep)}">
      <button class="icon-btn send" aria-label="Senden">${ICON.send}</button>
    </form>
    <div class="quick">
      ${[['📅', 'Termin eintragen', 'Trag mir einen Termin ein: '], ['⏰', 'Erinnerung', 'Erinner mich '], ['✈️', 'Nachricht', 'Schreib '], ['☀️', 'Mein Tag', 'Was steht heute an?'], ['📞', 'Anruf', 'Bereite einen Anruf vor: ']]
        .map(([i, l, p]) => `<button class="chip" data-prefill="${esc(p)}">${i} ${l}</button>`).join('')}
    </div>
    ${brain.status !== 'connected' ? `<div class="empty warn-box">Auf dem Server fehlt der KI-Schlüssel (GEMINI_API_KEY). Bis er eingetragen ist, kann Vio nicht antworten.</div>` : ''}
    ${state.installPrompt ? `<div class="card install-banner"><div class="avatar">V</div><div class="grow">Vio auf den Startbildschirm legen?</div><button class="btn primary small" id="install">Installieren</button></div>` : ''}

    ${data.pending_facts.length ? `<h2>Soll ich mir das merken?</h2><div class="list">${data.pending_facts.map(factRow).join('')}</div>` : ''}

    <h2>Heute</h2>
    ${today.length ? `<div class="timeline">${today.map((i) => `
      <div class="tl-item ${i.kind}${i.conflict ? ' conflict' : ''}">
        <div class="tl-time">${esc(i.time)}</div><div class="tl-mark"></div>
        <div class="tl-body"><div class="title">${esc(i.title)}</div>${i.meta || i.conflict ? `<div class="meta">${esc(i.meta)}${i.conflict ? `${i.meta ? ' · ' : ''}überschneidet sich` : ''}</div>` : ''}</div>
        ${i.kind === 'task' ? `<button class="check" data-toggle="${i.task.id}" data-done="0" aria-label="Erledigt"></button>` : '<span></span>'}
      </div>`).join('')}</div>`
      : `<div class="empty">${data.events === null ? 'Heute steht nichts an. Verbinde den Google Kalender unter <a href="#/apps"><u>Apps</u></a>, dann erscheinen hier auch deine Termine.' : 'Heute ist nichts geplant. Genieß es – oder sag Vio, was ansteht.'}</div>`}

    ${later.length ? `<h2>Demnächst</h2><div class="list">${later.map(eventRow).join('')}</div>` : ''}
    ${undated.length ? `<h2>Irgendwann erledigen</h2><div class="list">${undated.map(taskRow).join('')}</div>` : ''}

    ${data.conversations.length ? `<h2>Zuletzt gesprochen</h2><div class="list">${data.conversations.slice(0, 3).map((c) => `
      <a class="row" href="#/chat/${c.id}"><div class="grow"><div class="title">${esc(c.title)}</div><div class="meta">${relTime(c.updated_at)}</div></div></a>`).join('')}</div>` : ''}
  `;

  $('#orb').onclick = () => openConversation();
  $('#ask').onsubmit = (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim(); if (!q) return;
    newConversation(); location.hash = '#/chat';
    setTimeout(() => sendMessage(q, false), 60);
  };
  document.querySelectorAll('[data-prefill]').forEach((b) => (b.onclick = () => {
    const p = b.dataset.prefill;
    newConversation(); location.hash = '#/chat';
    if (!/ $/.test(p)) { setTimeout(() => sendMessage(p, false), 60); return; }
    setTimeout(() => { const i = $('#input'); if (i) { i.value = p; i.focus(); i.setSelectionRange(p.length, p.length); } }, 90);
  }));
  $('#install')?.addEventListener('click', doInstall);
  bindTaskRows(); bindFactRows();
}

function connChip(c) {
  const cls = c.status === 'connected' ? 'ok' : c.status === 'missing_key' ? 'warn' : 'off';
  return `<span class="chip"><span class="dot ${cls}"></span>${esc(c.name.replace(/ \(.*\)/, ''))}</span>`;
}
function taskRow(t) {
  return `<div class="row" data-task="${t.id}">
    <button class="check ${t.done ? 'done' : ''}" data-toggle="${t.id}" data-done="${t.done ? 1 : 0}" aria-label="Erledigt">${t.done ? ICON.check : ''}</button>
    <div class="grow"><div class="title ${t.done ? 'done-text' : ''}">${esc(t.title)}</div>${t.due_at ? `<div class="meta">${esc(fmtDue(t.due_at))}${t.repeat ? ` · 🔁 ${REPEAT_LABEL[t.repeat] || ''}` : ''}</div>` : ''}</div>
  </div>`;
}
function bindTaskRows(after) {
  document.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = async () => {
    await api(`/api/tasks/${b.dataset.toggle}`, { method: 'PATCH', body: { done: b.dataset.done !== '1' } });
    (after || route)();
  }));
}
function factRow(f) {
  return `<div class="row"><div class="grow">${esc(f.text)}</div>
    <button class="btn small primary" data-approve="${f.id}">Merken</button>
    <button class="btn small" data-reject="${f.id}">Nein</button></div>`;
}
function bindFactRows(root = document, after) {
  root.querySelectorAll('[data-approve]').forEach((b) => (b.onclick = async () => {
    await api(`/api/facts/${b.dataset.approve}/approve`, { method: 'POST' }); toast('Gemerkt 👍'); (after || route)();
  }));
  root.querySelectorAll('[data-reject]').forEach((b) => (b.onclick = async () => {
    await api(`/api/facts/${b.dataset.reject}`, { method: 'DELETE' }); toast('Okay, vergessen.'); (after || route)();
  }));
}

// ============================================================================
//  Chat
// ============================================================================
function newConversation() {
  state.streaming?.abort();
  voice.stopSpeaking();
  state.convId = null; state.messages = []; state.convTitle = '';
}

async function renderChat(id) {
  if (id && Number(id) !== state.convId) {
    try {
      const conv = await api(`/api/conversations/${Number(id)}`);
      state.convId = conv.id; state.convTitle = conv.title;
      state.messages = conv.messages.map((m) => ({ role: m.role, content: m.content }));
      if (conv.running) { state.resumeConv = conv.id; setTimeout(resumeIfNeeded, 1500); }
    } catch (e) { if (!isNetworkError(e)) throw e; }
  }
  if (!state.settings) state.settings = cachedSettings() || (await api('/api/settings')).settings;
  await addPendingBubbles();

  view().innerHTML = `
    <section class="chat-view">
      <div class="chat-head">
        <div class="avatar">V</div>
        <div class="grow">${esc(state.convTitle || 'Vio')}</div>
        <a class="icon-btn" href="#/history" aria-label="Verlauf">${ICON.history}</a>
        <button class="icon-btn" id="new-chat" aria-label="Neues Gespräch">${ICON.plus}</button>
      </div>
      <div class="offline-bar" id="offline-bar" ${navigator.onLine ? 'hidden' : ''}>📴 Kein Netz – deine Nachrichten und Sprachaufnahmen werden gespeichert und automatisch gesendet, sobald du wieder Netz hast.</div>
      <div class="messages" id="messages"></div>
      <div class="listen-hint" id="hint"></div>
      <form class="composer" id="composer">
        <button type="button" class="icon-btn mic" id="mic" aria-label="Sprechen">${ICON.mic}</button>
        <textarea id="input" rows="1" placeholder="Nachricht an Vio …" enterkeyhint="send"></textarea>
        <button class="icon-btn send" id="send" aria-label="Senden">${ICON.send}</button>
      </form>
    </section>`;

  renderMessages();
  const input = $('#input');
  input.oninput = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('#composer').requestSubmit(); } };
  $('#composer').onsubmit = (e) => {
    e.preventDefault();
    if (state.streaming) { stopAll(); return; }
    const t = input.value.trim(); if (!t) return;
    input.value = ''; input.style.height = 'auto';
    sendMessage(t, false);
  };
  $('#mic').onclick = () => {
    if (state.recording) { finishRecording(); return; }
    if (voice.isListening()) { voice.stopListening(); state.handsfreeActive = false; updateMic(); return; }
    if (voice.isSpeaking()) { voice.stopSpeaking(); } // Unterbrechen
    startListening();
  };
  $('#new-chat').onclick = () => { newConversation(); location.hash = '#/chat'; renderChat(); };
  updateSendBtn(); updateMic();
}

function renderMessages() {
  const box = $('#messages'); if (!box) return;
  if (!state.messages.length) {
    box.innerHTML = `<div class="welcome"><div class="avatar">V</div>
      <div>Worüber wollen wir reden?</div>
      <div class="suggestions">
        ${['Was steht heute an?', 'Merk dir: Ich trinke Kaffee schwarz.', 'Erinner mich morgen ans Altglas.', 'Erzähl mir einen Witz.']
          .map((s) => `<button class="chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}
      </div></div>`;
    box.querySelectorAll('[data-suggest]').forEach((b) => (b.onclick = () => sendMessage(b.dataset.suggest, false)));
    return;
  }
  box.innerHTML = state.messages.map((m, i) => {
    if (m.role === 'event') return m.card ? `<div class="action-card">${m.html}</div>` : `<div class="event ${m.kind || ''}">${m.html}</div>`;
    if (m.role === 'user') return `<div class="msg user ${m.pending ? 'pending' : ''}">${esc(m.content).replace(/\n/g, '<br>')}${m.pending ? '<div class="pending-note">⏳ wird gesendet, sobald du Netz hast</div>' : ''}</div>`;
    return `<div class="msg assistant ${m.typing ? 'typing' : ''}" data-i="${i}">${md(m.content)}${!m.typing && m.content ? `<button class="speak" data-speak="${i}" aria-label="Vorlesen">${ICON.speaker}</button>` : ''}</div>`;
  }).join('');
  box.querySelectorAll('[data-speak]').forEach((b) => (b.onclick = () => { voice.stopSpeaking(); voice.say(state.messages[b.dataset.speak].content, state.settings); }));
  bindFactRows(box, () => {});
  bindActionCards(box);
  box.querySelectorAll('[data-approve],[data-reject]').forEach((b) => b.addEventListener('click', () => {
    b.closest('.event').innerHTML = b.dataset.approve ? '✓ Gemerkt' : 'Okay, nicht gemerkt';
  }));
  window.scrollTo({ top: document.body.scrollHeight });
}

function updateSendBtn() {
  const b = $('#send'); if (!b) return;
  b.innerHTML = state.streaming ? ICON.stop : ICON.send;
  b.setAttribute('aria-label', state.streaming ? 'Stopp' : 'Senden');
}
function updateMic() {
  const m = $('#mic'); if (!m) return;
  m.classList.toggle('listening', voice.isListening() || !!state.recording);
  m.classList.toggle('speaking', !voice.isListening() && voice.isSpeaking());
  const hint = $('#hint');
  if (hint) hint.textContent = state.recording ? '🎙️ Aufnahme läuft (ohne Netz) – tippe aufs Mikro zum Beenden' : voice.isListening() ? 'Ich höre zu …' : voice.isSpeaking() ? 'Vio spricht – tippe aufs Mikro zum Unterbrechen' : state.handsfreeActive ? 'Freisprechmodus aktiv' : '';
}
window.addEventListener('vio-speaking', updateMic);

function stopAll() {
  if (state.streaming && state.rid) api('/api/chat/stop', { method: 'POST', body: { request_id: state.rid } }).catch(() => {});
  state.streaming?.abort();
  if (state.recording) { state.recording.cancel(); state.recording = null; }
  voice.stopSpeaking(); voice.stopListening();
  state.handsfreeActive = false;
  updateMic();
}

function startListening() {
  if (!navigator.onLine) { startRecording(); return; } // ohne Netz: Aufnahme speichern, später umwandeln
  if (!voice.canListen) { toast('Spracherkennung geht hier nicht – bitte Chrome auf Android nutzen.'); return; }
  state.handsfreeActive = !!state.settings?.handsfree;
  voice.listen({
    onInterim: (t) => { const i = $('#input'); if (i) i.value = t; },
    onFinal: (t) => { const i = $('#input'); if (i) i.value = ''; sendMessage(t, true); },
    onEnd: (gotText) => { if (!gotText) state.handsfreeActive = false; updateMic(); },
    onError: (msg, code) => {
      state.handsfreeActive = false;
      if (code === 'network') { toast('Kein Netz für die Spracherkennung – ich nehme stattdessen auf und sende später.', 4000); startRecording(); return; }
      toast(msg, 5000); updateMic();
    },
  });
  updateMic();
}

async function sendMessage(text, viaVoice, opts = {}) {
  if (state.streaming) return;
  if (!$('#messages')) { location.hash = '#/chat'; await renderChat(); }
  voice.stopSpeaking();
  if (!navigator.onLine) { await queueMessage({ kind: 'text', text }); return; }

  const s = state.settings || {};
  const shouldSpeak = opts.forceSpeak || s.tts_mode === 'always' || (s.tts_mode !== 'never' && viaVoice);
  const speaker = shouldSpeak ? new voice.SentenceSpeaker(s) : null;

  state.messages.push({ role: 'user', content: text });
  const reply = { role: 'assistant', content: '', typing: true };
  state.messages.push(reply);
  renderMessages();

  const ac = new AbortController();
  const rid = (crypto.randomUUID?.() || String(Math.random()).slice(2)) + '';
  state.streaming = ac; state.rid = rid; updateSendBtn();
  let reachedServer = false;

  let pending = '';
  let raf = 0;
  const flush = () => { raf = 0; const el = document.querySelector(`.msg[data-i="${state.messages.indexOf(reply)}"]`); if (el) { el.innerHTML = md(reply.content); window.scrollTo({ top: document.body.scrollHeight }); } };

  try {
    await streamChat({
      text, conversationId: state.convId, signal: ac.signal, requestId: rid,
      onEvent: (ev, data) => {
        if (ev === 'meta') { reachedServer = true; state.convId = data.conversation_id; if (!state.convTitle) state.convTitle = text.slice(0, 60); }
        else if (ev === 'delta') { reply.content += data.text; speaker?.push(data.text); opts.onUpdate?.(reply.content); if (!raf) raf = requestAnimationFrame(flush); }
        else if (ev === 'tool') { insertEvent(reply, data); }
        else if (ev === 'error') { reply.content += (reply.content ? '\n\n' : '') + '⚠️ ' + data.message; opts.onUpdate?.(reply.content); if (speaker) speaker.push(' ' + data.message + ' '); }
      },
    });
  } catch (e) {
    if (e instanceof AuthError) return renderLogin();
    if (e.name === 'AbortError') reply.content += reply.content ? ' …' : '(abgebrochen)';
    else if (!reachedServer && isNetworkError(e)) {
      // Nachricht ist nie beim Server angekommen → in die Warteschlange
      state.messages.splice(state.messages.indexOf(reply), 1);
      state.messages.splice(state.messages.findLastIndex((m) => m.role === 'user' && m.content === text), 1);
      await queueMessage({ kind: 'text', text });
    } else if (reachedServer) {
      // Verbindung weg, aber Vio arbeitet auf dem Server weiter → Antwort später abholen
      reply.content += (reply.content ? ' …' : '') + '\n\n⏳ Vio arbeitet weiter – die Antwort erscheint hier, sobald du wieder verbunden bist.';
      state.resumeConv = state.convId;
      setTimeout(resumeIfNeeded, 2500);
    } else reply.content += (reply.content ? '\n\n' : '') + '⚠️ Da ist etwas schiefgelaufen. Schick die Nachricht bitte nochmal.';
  } finally {
    reply.typing = false;
    state.streaming = null;
    speaker?.flush();
    renderMessages(); updateSendBtn();
    const head = document.querySelector('.chat-head .grow'); if (head) head.textContent = state.convTitle || 'Vio';
    if (history.replaceState && state.convId) history.replaceState(null, '', `#/chat/${state.convId}`);
  }

  opts.onUpdate?.(reply.content);
  if (opts.noLoop) return reply.content;
  // Freisprechmodus: nach Vios Antwort automatisch wieder zuhören
  if (viaVoice && state.handsfreeActive) voice.whenSpeechDone(() => { if (state.handsfreeActive && $('#mic')) startListening(); });
}

// ============================================================================
//  Gesprächsmodus (großer Kreis): Vio begrüßt dich, hört zu, antwortet laut – immer im Wechsel
// ============================================================================
const convo = { active: false, phase: 'idle', silence: 0 };
const PHASE_TEXT = {
  greeting: 'Vio begrüßt dich …', listening: 'Ich höre zu …', thinking: 'Moment, ich denk kurz nach …',
  speaking: 'Vio spricht – tippe zum Unterbrechen', idle: 'Tippe auf den Kreis, um zu sprechen', offline: 'Kein Netz – tippe zum Aufnehmen',
};

function convoEl() {
  let el = $('#convo');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'convo'; el.className = 'convo'; el.hidden = true;
  el.innerHTML = `
    <button class="icon-btn convo-close" id="convo-close" aria-label="Gespräch beenden">✕</button>
    <div class="convo-status" id="convo-status"></div>
    <div class="convo-orb-wrap"><button class="convo-orb" id="convo-orb" aria-label="Sprechen">${ICON.mic}</button></div>
    <div class="convo-you" id="convo-you"></div>
    <div class="convo-vio" id="convo-vio"></div>
    <div class="convo-hint">Sprich einfach los. Zum Beenden auf ✕ tippen.</div>`;
  document.body.appendChild(el);
  $('#convo-close').onclick = closeConversation;
  $('#convo-orb').onclick = convoOrbTap;
  return el;
}
function setPhase(p) {
  convo.phase = p;
  const el = convoEl();
  el.dataset.phase = p;
  $('#convo-status').textContent = PHASE_TEXT[p] || '';
}
window.addEventListener('vio-speaking', (e) => {
  if (!convo.active) return;
  if (e.detail) setPhase('speaking');
});

function openConversation() {
  voice.unlockAudio(); // MUSS direkt beim Antippen passieren, sonst bleibt Vio auf Android stumm
  convo.active = true; convo.silence = 0;
  newConversation();
  if (location.hash !== '#/chat') location.hash = '#/chat';
  const el = convoEl(); el.hidden = false;
  $('#convo-you').textContent = ''; $('#convo-vio').textContent = '';
  document.body.classList.add('convo-open');
  if (!navigator.onLine) { setPhase('offline'); return; }
  const s = state.settings || {};
  const name = s.user_name && s.user_name !== 'du' ? s.user_name : '';
  const greet = new Date().getHours() < 11 ? `Guten Morgen${name ? ', ' + name : ''}! Was kann ich für dich tun?` : `Hey${name ? ' ' + name : ''}! Was kann ich für dich tun?`;
  $('#convo-vio').textContent = greet;
  setPhase('greeting');
  voice.sayCached(greet, s).then(() => { if (convo.active && (convo.phase === 'greeting' || convo.phase === 'speaking')) convoListen(); });
}

function closeConversation() {
  convo.active = false;
  voice.stopSpeaking(); voice.stopListening();
  if (state.recording) { state.recording.cancel(); state.recording = null; }
  const el = $('#convo'); if (el) el.hidden = true;
  document.body.classList.remove('convo-open');
  updateMic();
}

function convoOrbTap() {
  voice.unlockAudio();
  if (convo.phase === 'offline') { if (state.recording) { finishRecording(); setPhase('offline'); } else { startRecording(); $('#convo-status').textContent = '🎙️ Aufnahme läuft – tippe zum Beenden'; } return; }
  if (convo.phase === 'speaking' || convo.phase === 'greeting') { voice.stopSpeaking(); convoListen(); return; }
  if (convo.phase === 'listening') { voice.stopListening(); setPhase('idle'); return; }
  if (convo.phase === 'thinking') return;
  convo.silence = 0; convoListen();
}

function convoListen() {
  if (!convo.active) return;
  if (!voice.canListen) { setPhase('idle'); toast('Spracherkennung geht hier nicht – bitte Chrome nutzen.'); return; }
  setPhase('listening');
  voice.listen({
    onInterim: (t) => { $('#convo-you').textContent = t; },
    onFinal: async (t) => {
      convo.silence = 0;
      $('#convo-you').textContent = t; $('#convo-vio').textContent = '';
      setPhase('thinking');
      await sendMessage(t, true, { forceSpeak: true, noLoop: true, onUpdate: (txt) => { const v = $('#convo-vio'); if (v) v.textContent = txt.replace(/[*_`#]/g, ''); } });
      if (!convo.active) return;
      await voice.speechDone();
      if (convo.active) convoListen();
    },
    onEnd: (got) => {
      if (got || !convo.active || convo.phase !== 'listening') return;
      convo.silence++;
      if (convo.silence >= 2) setPhase('idle'); else convoListen(); // einmal nochmal zuhören, dann Pause
    },
    onError: (msg, code) => {
      if (!convo.active) return;
      if (code === 'network') { setPhase('offline'); return; }
      if (code === 'not-allowed') { setPhase('idle'); toast('Bitte erlaube das Mikrofon – dann auf den Kreis tippen.', 6000); return; }
      setPhase('idle'); toast(msg, 5000);
    },
  });
}

// ============================================================================
//  Ohne Netz: Warteschlange, Aufnahme, später senden; Antworten nach Rückkehr abholen
// ============================================================================
function cachedSettings() { try { return JSON.parse(localStorage.getItem('vio-settings') || 'null'); } catch { return null; } }
function cacheSettings(s) { try { localStorage.setItem('vio-settings', JSON.stringify(s)); } catch {} }

async function queueMessage(item) {
  const id = await outbox.add({ ...item, convId: state.convId || null });
  state.messages.push({ role: 'user', content: item.kind === 'audio' ? `🎙️ Sprachnachricht (${item.seconds || '?'} s)` : item.text, pending: true, outboxId: id });
  renderMessages();
  toast(navigator.onLine ? 'Wird gleich gesendet …' : 'Gespeichert – wird gesendet, sobald du Netz hast 📴');
  if (navigator.onLine) flushOutbox();
}

async function addPendingBubbles() {
  try {
    const items = (await outbox.all()).filter((i) => (i.convId || null) === (state.convId || null) || (!i.convId && state.messages.some((m) => m.outboxId === i.id)));
    for (const i of items) {
      if (state.messages.some((m) => m.outboxId === i.id)) continue;
      state.messages.push({ role: 'user', content: i.kind === 'audio' ? `🎙️ Sprachnachricht (${i.seconds || '?'} s)` : i.text, pending: true, outboxId: i.id });
    }
  } catch {}
}

async function startRecording() {
  if (!voice.canRecord) { toast('Aufnehmen wird hier nicht unterstützt.'); return; }
  try {
    state.recording = await voice.startRecording();
    updateMic();
  } catch { toast('Mikrofon nicht verfügbar – bitte Zugriff erlauben.'); state.recording = null; updateMic(); }
}
async function finishRecording() {
  const rec = state.recording; state.recording = null; updateMic();
  if (!rec) return;
  try {
    const blob = await rec.stop();
    const seconds = Math.max(1, Math.round((Date.now() - rec.started) / 1000));
    if (seconds < 1 || blob.size < 2000) { toast('Aufnahme zu kurz.'); return; }
    await queueMessage({ kind: 'audio', blob, seconds });
  } catch (e) { toast('Aufnahme fehlgeschlagen: ' + e.message); }
}

let flushing = false;
async function flushOutbox() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  const createdFor = new Map(); // Offline begonnene neue Gespräche → Server-ID
  try {
    for (const item of await outbox.all()) {
      let text = item.text;
      if (item.kind === 'audio') {
        const res = await fetch('/api/transcribe', { method: 'POST', credentials: 'same-origin', headers: { 'X-Vio': '1', 'Content-Type': 'audio/wav' }, body: item.blob });
        if (res.status === 401) throw new AuthError();
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Spracherkennung fehlgeschlagen');
        text = (await res.json()).text;
        if (!text) { await outbox.remove(item.id); dropPending(item.id); toast('Eine Sprachaufnahme war leer und wurde verworfen.'); continue; }
      }
      const convKey = item.convId || 'neu';
      let convId = item.convId || createdFor.get(convKey) || null;
      let reached = false;
      await streamChat({ text, conversationId: convId, requestId: 'q' + item.id, onEvent: (ev, data) => {
        if (ev === 'meta') { reached = true; convId = data.conversation_id; if (!item.convId) createdFor.set(convKey, convId); }
      } }).catch((e) => { if (!reached) throw e; }); // nach Ankunft beim Server arbeitet er auch ohne uns weiter
      await outbox.remove(item.id);
      toast(`✅ Gesendet: „${text.slice(0, 40)}${text.length > 40 ? '…' : ''}“`);
      // Gerade offenes Gespräch neu laden (auch wenn es offline neu begonnen wurde)
      const viewing = $('#messages') && ((state.convId || null) === (item.convId || null) || (!item.convId && state.convId === convId));
      if (viewing) {
        if (!state.convId) state.convId = convId;
        await reloadConversation();
      }
    }
  } catch (e) {
    if (e instanceof AuthError) renderLogin();
    else if (!isNetworkError(e)) toast(e.message, 5000);
  } finally { flushing = false; }
}
function dropPending(id) { const i = state.messages.findIndex((m) => m.outboxId === id); if (i >= 0) { state.messages.splice(i, 1); renderMessages(); } }

async function reloadConversation() {
  if (!state.convId) return;
  const conv = await api(`/api/conversations/${state.convId}`);
  state.convTitle = conv.title;
  state.messages = conv.messages.map((m) => ({ role: m.role, content: m.content }));
  await addPendingBubbles();
  if ($('#messages')) { renderMessages(); const h = document.querySelector('.chat-head .grow'); if (h) h.textContent = conv.title; }
  return conv;
}

let resuming = false;
async function resumeIfNeeded() {
  if (resuming || !state.resumeConv || !navigator.onLine || document.hidden) return;
  resuming = true;
  try {
    for (let i = 0; i < 60; i++) { // max. ~2 Minuten warten
      const conv = await api(`/api/conversations/${state.resumeConv}`);
      if (!conv.running) {
        if (state.convId === conv.id && !state.streaming) { await reloadConversation(); toast('Vio ist fertig ✅'); }
        state.resumeConv = null;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch {} finally { resuming = false; }
}

function updateOnlineUi() {
  const bar = $('#offline-bar'); if (bar) bar.hidden = navigator.onLine;
  if (navigator.onLine) { flushOutbox(); resumeIfNeeded(); }
}
window.addEventListener('online', updateOnlineUi);
window.addEventListener('offline', updateOnlineUi);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { flushOutbox(); resumeIfNeeded(); } });

function renderOffline(name) {
  $('#nav').hidden = false;
  if (name === 'chat' || name === '') { location.hash = '#/chat'; return renderChat(); }
  view().innerHTML = `<div class="card placeholder"><div class="ph-icon">📴</div><p>Gerade kein Netz. Du kannst Vio trotzdem schreiben oder eine Sprachnachricht aufnehmen – sie wird gesendet, sobald du wieder online bist.</p><a class="btn primary" href="#/chat">Zum Chat</a></div>`;
}

function insertEvent(reply, data) {
  const idx = state.messages.indexOf(reply);
  let ev;
  if (data.type === 'task') ev = { kind: 'allow', html: `${ICON.check.replace('<svg', '<svg class="ico-sm"')} Aufgabe notiert: ${esc(data.title)}${data.due_at ? ` · ${esc(fmtDue(data.due_at))}` : ''}${data.repeat ? ` · ${REPEAT_LABEL[data.repeat]}` : ''}` };
  else if (data.type === 'calendar') ev = {
    kind: data.conflicts?.length ? 'ask' : 'allow',
    html: `📅 Termin ${data.action === 'created' ? 'eingetragen' : 'geändert'}: <strong>${esc(data.title)}</strong> · ${esc(fmtEventTime(data))}${data.conflicts?.length ? `<br>⚠️ Überschneidung mit: ${esc(data.conflicts.join(', '))}` : ''}`,
  };
  else if (data.type === 'message') ev = { card: true, html: actionCard(data) };
  else if (data.type === 'call') ev = { card: true, html: actionCard(data) };
  else if (data.type === 'draft') ev = { card: true, html: `<div class="ac-head">✉️ E-Mail-Entwurf</div><div class="meta">An: ${esc(data.to)}<br>Betreff: ${esc(data.subject)}</div><div class="ac-body">${esc(data.body).replace(/\n/g, '<br>')}</div><div class="meta">Sag „Ja, schick ab“, wenn er so raus soll.</div>` };
  else if (data.type === 'fact') ev = data.status === 'pending'
    ? { html: `Merken? „${esc(data.text)}“ <button class="btn small primary" data-approve="${data.id}">Ja</button><button class="btn small" data-reject="${data.id}">Nein</button>` }
    : { html: `🧠 Gemerkt: ${esc(data.text)}` };
  else if (data.type === 'policy') {
    const k = { allow: 'allow', deny: 'deny', ask_user: 'ask', need_price: 'ask' }[data.decision] || '';
    const label = { allow: 'Freigegeben', deny: 'Blockiert', ask_user: 'Rückfrage nötig', need_price: 'Preis erst erfragen' }[data.decision];
    ev = { kind: k, html: `${ICON.shield.replace('<svg', '<svg class="ico-sm"')} Budget-Regel: <strong>${esc(label)}</strong> – ${esc(data.reason)}` };
  } else ev = { kind: data.kind || '', html: esc(data.label || 'Aktion ausgeführt') };
  state.messages.splice(idx, 0, { role: 'event', ...ev });
  renderMessages();
}

// ============================================================================
//  Verlauf & Suche
// ============================================================================
async function renderHistory() {
  const convs = await api('/api/conversations');
  view().innerHTML = `
    <div class="chat-head"><a class="icon-btn" href="#/chat">${ICON.back}</a><div class="grow">Verlauf</div></div>
    <input class="input" id="q" placeholder="Alte Unterhaltungen durchsuchen …" type="search">
    <div class="list mt12" id="results">
      ${convs.length ? convs.map((c) => `<div class="row"><a class="grow" href="#/chat/${c.id}"><div class="title">${esc(c.title)}</div><div class="meta">${relTime(c.updated_at)}</div></a><button class="icon-btn" data-del="${c.id}" aria-label="Löschen">${ICON.trash}</button></div>`).join('') : '<div class="empty">Noch keine Gespräche.</div>'}
    </div>`;
  const results = $('#results');
  const original = results.innerHTML;
  const bindDel = () => results.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Gespräch löschen?')) return;
    await api(`/api/conversations/${b.dataset.del}`, { method: 'DELETE' });
    if (state.convId === Number(b.dataset.del)) newConversation();
    renderHistory();
  }));
  bindDel();
  let t;
  $('#q').oninput = (e) => {
    clearTimeout(t);
    const q = e.target.value.trim();
    t = setTimeout(async () => {
      if (q.length < 2) { results.innerHTML = original; bindDel(); return; }
      const hits = await api(`/api/search?q=${encodeURIComponent(q)}`);
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      results.innerHTML = hits.length ? hits.map((h) => {
        const pos = h.content.toLowerCase().indexOf(q.toLowerCase());
        const snip = h.content.slice(Math.max(0, pos - 40), pos + 80);
        return `<a class="row" href="#/chat/${h.conversation_id}"><div class="grow"><div class="meta">${esc(h.title)} · ${h.role === 'user' ? 'Du' : 'Vio'}</div><div>${esc(snip).replace(re, (m) => `<mark>${m}</mark>`)}</div></div></a>`;
      }).join('') : '<div class="empty">Nichts gefunden.</div>';
    }, 250);
  };
}

// ============================================================================
//  Aufgaben
// ============================================================================
async function renderTasks() { await swr('/api/tasks', paintTasks); }
function paintTasks(tasks) {
  const open = tasks.filter((t) => !t.done), done = tasks.filter((t) => t.done).slice(0, 15);
  view().innerHTML = `
    <h1>Aufgaben</h1>
    <p class="sub">Sag Vio einfach, was zu tun ist – oder trag es hier ein.</p>
    <form class="ask" id="add-task">
      <input class="input" name="title" placeholder="Neue Aufgabe …" autocomplete="off">
      <input class="input" name="due" type="datetime-local" data-date>
      <button class="icon-btn send" aria-label="Hinzufügen">${ICON.plus}</button>
    </form>
    <h2>Offen (${open.length})</h2>
    <div class="list">${open.length ? open.map(taskRowWithDelete).join('') : '<div class="empty">Alles erledigt. Stark.</div>'}</div>
    ${done.length ? `<h2>Erledigt</h2><div class="list">${done.map(taskRowWithDelete).join('')}</div>` : ''}`;
  $('#add-task').onsubmit = async (e) => {
    e.preventDefault();
    const title = e.target.title.value.trim(); if (!title) return;
    await api('/api/tasks', { method: 'POST', body: { title, due_at: e.target.due.value || null } });
    renderTasks();
  };
  bindTaskRows(renderTasks);
  document.querySelectorAll('[data-deltask]').forEach((b) => (b.onclick = async () => { await api(`/api/tasks/${b.dataset.deltask}`, { method: 'DELETE' }); renderTasks(); }));
}
function taskRowWithDelete(t) { return taskRow(t).replace(/<\/div>\s*$/, `<button class="icon-btn" data-deltask="${t.id}" aria-label="Löschen" data-small>${ICON.trash}</button></div>`); }

// ============================================================================
//  Apps & Verbindungen
// ============================================================================
async function renderApps() { await swr('/api/connections', paintApps); }
function paintApps({ connections, google, telegram, tguser }) {
  if (state.query?.get('google') === 'ok') toast('Google ist verbunden 🎉');
  if (state.query?.get('google_error')) toast('Google: ' + state.query.get('google_error'), 6000);
  const LABEL = { connected: 'Verbunden', available: 'Bereit zum Verbinden', needs_setup: 'Einrichtung nötig', limited: 'Vorbereiten', missing_key: 'Schlüssel fehlt', planned: 'Geplant' };
  const DOT = { connected: 'ok', limited: 'ok', available: 'warn', missing_key: 'warn' };
  view().innerHTML = `
    <h1>Apps & Verbindungen</h1>
    <p class="sub">Hier verbindest du Vio mit deinen Diensten. Alles ehrlich: Was hier nicht grün ist, kann Vio auch nicht.</p>

    <h2>Google (Kalender & Gmail)</h2>
    <div class="card">
      ${google.connected
        ? `<div class="row-flat"><span class="dot ok"></span><div class="grow">Verbunden als <strong>${esc(google.email || 'Google-Konto')}</strong></div></div>
           <div class="btn-row"><a class="btn small" href="#/calendar">Kalender ansehen</a><button class="btn small danger" id="g-off">Trennen</button></div>`
        : google.configured
          ? `<p class="meta">Vio bekommt Zugriff auf deinen Kalender und kann Mails lesen und – nur nach deiner Zustimmung – senden.</p><button class="btn primary" id="g-on">Mit Google verbinden</button>`
          : `<p class="meta">Auf dem Server fehlen noch GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET. Die Anleitung dazu steht in docs/INSTALLATION.md (Abschnitt „Google verbinden“).</p>`}
    </div>

    <h2>Telegram</h2>
    <div class="card">
      ${telegram.linked
        ? `<div class="row-flat"><span class="dot ok"></span><div class="grow">Verknüpft${telegram.name ? ` mit <strong>${esc(telegram.name)}</strong>` : ''}. Erinnerungen und die Tagesübersicht kommen per Telegram.</div></div>
           ${telegram.groups.length ? `<p class="meta">Gruppen, in denen Vio schreiben darf: ${esc(telegram.groups.join(', '))}</p>` : '<p class="meta">Tipp: Lade deinen Bot in eine Telegram-Gruppe ein, dann kann Vio dort Nachrichten posten.</p>'}
           <div class="btn-row"><button class="btn small" id="t-test">Test-Nachricht</button><button class="btn small" id="t-brief">Tagesübersicht jetzt</button><button class="btn small danger" id="t-off">Trennen</button></div>`
        : telegram.configured
          ? `<p class="meta">Tippe auf den Knopf, Telegram öffnet sich – dort auf <strong>Starten</strong> tippen. Fertig.</p><button class="btn primary" id="t-on">Telegram verbinden</button>`
          : `<p class="meta">Auf dem Server fehlt noch TELEGRAM_BOT_TOKEN. Die Anleitung steht in docs/INSTALLATION.md (Abschnitt „Telegram verbinden“).</p>`}
    </div>

    <h2>Telegram als du (dein Konto)</h2>
    <div class="card" id="tgu-card">
      ${tguser.connected
        ? `<div class="row-flat"><span class="dot ok"></span><div class="grow">Angemeldet als <strong>${esc(tguser.name)}</strong> (${esc(tguser.phone)}). Sag z. B. „Schreib Josua auf Telegram, dass ich später komme“ – Vio schickt es sofort in deinem Namen.</div></div>
           <p class="meta">Sicherheitsgrenze: höchstens 20 Nachrichten pro Stunde. Jede gesendete Nachricht steht im Chat.</p>
           <div class="btn-row"><button class="btn small danger" id="tgu-off">Abmelden</button></div>`
        : tguser.configured
          ? `<p class="meta">Vio schreibt dann direkt aus deinem Telegram-Konto. Telegram schickt dir gleich einen Code <strong>in die Telegram-App</strong>.</p>
             <div id="tgu-step"><div class="ask"><input class="input" id="tgu-phone" type="tel" placeholder="+49 176 …" autocomplete="tel"><button class="btn primary small" id="tgu-send">Code senden</button></div></div>`
          : `<p class="meta">Der Server sieht die Zugangsdaten von my.telegram.org noch nicht:</p>
             <div class="check-list">
               <div>${tguser.has_api_id ? '✅' : '❌'} <code>TELEGRAM_API_ID</code> ${tguser.has_api_id ? 'gefunden' : 'fehlt (nur die Zahl eintragen)'}</div>
               <div>${tguser.has_api_hash ? (tguser.api_hash_ok ? '✅' : '⚠️') : '❌'} <code>TELEGRAM_API_HASH</code> ${tguser.has_api_hash ? (tguser.api_hash_ok ? 'gefunden' : 'gefunden, sieht aber falsch aus (32 Zeichen aus 0–9 und a–f)') : 'fehlt'}</div>
             </div>
             <p class="meta">In Render: Dienst „vio“ → Environment → Namen genau so schreiben → „Save, rebuild, and deploy“.</p>`}
    </div>

    <h2>Alle Verbindungen</h2>
    <div class="list">
      ${connections.map((c) => `<div class="row">
        <span class="dot ${DOT[c.status] || 'off'}"></span>
        <div class="grow"><div class="title">${esc(c.name)}</div>${c.detail ? `<div class="meta">${esc(c.detail)}</div>` : ''}</div>
        <span class="badge">${LABEL[c.status] || c.status}</span></div>`).join('')}
    </div>
    <h2>Später möglich</h2>
    <div class="status-chips">${['Selbst telefonieren (kostenpflichtig)', 'Websuche & Preisalarm', 'Google Maps', 'Google Drive', 'Spotify', 'Wetter', 'Banking (nur lesen)'].map((n) => `<span class="chip"><span class="dot off"></span>${n}</span>`).join('')}</div>`;

  $('#g-on')?.addEventListener('click', async () => { try { location.href = (await api('/api/google/connect', { method: 'POST' })).url; } catch (e) { toast(e.message); } });
  $('#g-off')?.addEventListener('click', async () => { if (!confirm('Google-Verbindung trennen?')) return; await api('/api/google/disconnect', { method: 'POST' }); renderApps(); });
  $('#t-on')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/telegram/link', { method: 'POST' });
      if (!window.open(r.url, '_blank')) location.href = r.url;
      toast('In Telegram auf „Starten“ tippen, dann hierher zurückkommen.', 7000);
      const poll = setInterval(async () => {
        if (location.hash.split('?')[0] !== '#/apps') return clearInterval(poll);
        const st = await api('/api/connections').catch(() => null);
        if (st?.telegram.linked) { clearInterval(poll); toast('Telegram ist verbunden 🎉'); renderApps(); }
      }, 3000);
    } catch (e) { toast(e.message); }
  });
  $('#t-test')?.addEventListener('click', async () => { try { await api('/api/telegram/test', { method: 'POST' }); toast('Gesendet – schau in Telegram'); } catch (e) { toast(e.message); } });
  $('#t-brief')?.addEventListener('click', async () => { try { await api('/api/briefing', { method: 'POST' }); toast('Tagesübersicht gesendet'); } catch (e) { toast(e.message); } });
  $('#tgu-off')?.addEventListener('click', async () => { if (!confirm('Vio von deinem Telegram-Konto abmelden?')) return; await api('/api/tguser/logout', { method: 'POST' }); renderApps(); });
  $('#tgu-send')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    try {
      await api('/api/tguser/start', { method: 'POST', body: { phone: $('#tgu-phone').value } });
      $('#tgu-step').innerHTML = `<p class="meta">Code ist unterwegs – schau in deine Telegram-App (Chat „Telegram“).</p>
        <div class="ask"><input class="input" id="tgu-code" inputmode="numeric" autocomplete="one-time-code" placeholder="Code"><button class="btn primary small" id="tgu-ok">Bestätigen</button></div>`;
      $('#tgu-code').focus();
      $('#tgu-ok').onclick = async (e2) => {
        e2.target.disabled = true;
        try {
          const r = await api('/api/tguser/code', { method: 'POST', body: { code: $('#tgu-code').value } });
          if (r.needs_password) {
            $('#tgu-step').innerHTML = `<p class="meta">Dein Konto hat eine zweistufige Bestätigung. Bitte dein Telegram-Passwort eingeben.</p>
              <div class="ask"><input class="input" id="tgu-pw" type="password" placeholder="Telegram-Passwort"><button class="btn primary small" id="tgu-pwok">Anmelden</button></div>`;
            $('#tgu-pwok').onclick = async (e3) => {
              e3.target.disabled = true;
              try { await api('/api/tguser/password', { method: 'POST', body: { password: $('#tgu-pw').value } }); toast('Telegram-Konto verbunden 🎉'); renderApps(); }
              catch (err) { toast(err.message, 5000); e3.target.disabled = false; }
            };
          } else { toast('Telegram-Konto verbunden 🎉'); renderApps(); }
        } catch (err) { toast(err.message, 5000); e2.target.disabled = false; }
      };
    } catch (err) { toast(err.message, 6000); ev.target.disabled = false; }
  });
  $('#t-off')?.addEventListener('click', async () => { if (!confirm('Telegram trennen?')) return; await api('/api/telegram/unlink', { method: 'POST' }); renderApps(); });
}

// ============================================================================
//  Mehr + Unterseiten
// ============================================================================
function renderMore() {
  const tiles = [
    ['calendar', ICON.cal, 'Kalender', 'Tag & Woche'],
    ['reminders', ICON.bell, 'Erinnerungen', 'Fällige Aufgaben'],
    ['phone', ICON.phone, 'Telefon', 'Anrufe vorbereiten'],
    ['apps', ICON.apps || ICON.gear, 'Apps', 'Telegram, Google & Co.'],
    ['memory', ICON.brain, 'Gedächtnis', 'Was Vio über dich weiß'],
    ['settings', ICON.gear, 'Einstellungen', 'Stimme, Budget, Sicherheit'],
    ['history', ICON.history, 'Verlauf', 'Alte Gespräche'],
  ];
  view().innerHTML = `<h1>Mehr</h1><p class="sub">Alles Weitere an einem Ort.</p>
    <div class="tiles">${tiles.map(([r, i, t, m]) => `<a class="tile" href="#/${r}">${i}<div><div>${t}</div><div class="meta">${m}</div></div></a>`).join('')}</div>
    <p class="sub center mt24"><button class="btn small" id="logout">Abmelden</button></p>
    <p class="sub center">Vio Version ${VERSION}</p>`;
  $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); clearCaches(); renderLogin(); };
}

const REPEAT_LABEL = { daily: 'täglich', weekdays: 'werktags', weekly: 'wöchentlich', monthly: 'monatlich', yearly: 'jährlich' };
const dayKey = (iso, allDay) => (allDay ? iso.slice(0, 10) : new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }));
function fmtEventTime(e) {
  if (e.all_day) return new Date(e.start + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) + ' · ganztägig';
  return new Date(e.start).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function eventRow(e) {
  const time = e.all_day ? 'ganztägig' : `${new Date(e.start).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })}–${new Date(e.end).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })}`;
  return `<div class="row"><div class="ev-time">${time}</div><div class="grow"><div class="title">${esc(e.title)}</div><div class="meta">${esc(e.all_day ? fmtEventTime(e) : new Date(e.start).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long' }))}${e.location ? ' · ' + esc(e.location) : ''}</div></div></div>`;
}

async function renderCalendar() {
  const now = new Date();
  const ymd = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const r = await api(`/api/calendar?from=${ymd(now)} 00:00&to=${ymd(new Date(Date.now() + 7 * 864e5))} 23:59`);
  const head = `<div class="chat-head"><a class="icon-btn" href="#/more">${ICON.back}</a><div class="grow">Kalender</div></div>`;
  if (!r.connected) {
    view().innerHTML = `${head}<div class="card placeholder"><div class="ph-icon">${ICON.cal}</div><p>Verbinde deinen Google Kalender, dann siehst du hier Tages- und Wochenübersicht und Vio kann Termine für dich eintragen.</p><a class="btn primary" href="#/apps">Jetzt verbinden</a></div>`;
    return;
  }
  const groups = {};
  for (const e of r.events) (groups[dayKey(e.start, e.all_day)] ||= []).push(e);
  const today = ymd(now), tomorrow = ymd(new Date(Date.now() + 864e5));
  const dayLabel = (k) => (k === today ? 'Heute' : k === tomorrow ? 'Morgen' : new Date(k + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }));
  // Überschneidungen markieren
  const overlaps = new Set();
  const timed = r.events.filter((e) => !e.all_day);
  for (let i = 0; i < timed.length; i++) for (let j = i + 1; j < timed.length; j++) {
    if (Date.parse(timed[i].start) < Date.parse(timed[j].end) && Date.parse(timed[j].start) < Date.parse(timed[i].end)) { overlaps.add(timed[i].id); overlaps.add(timed[j].id); }
  }
  view().innerHTML = `${head}
    <p class="sub">Die nächsten 7 Tage. Neue Termine? Sag es einfach Vio – z. B. „Trag mir Freitag 15 Uhr Zahnarzt ein“.</p>
    ${Object.keys(groups).length ? Object.entries(groups).map(([k, evs]) => `<h2>${dayLabel(k)}</h2><div class="list">${evs.map((e) => eventRow(e).replace('<div class="row">', `<div class="row${overlaps.has(e.id) ? ' conflict' : ''}">`)).join('')}</div>`).join('') : '<div class="empty">Keine Termine in den nächsten 7 Tagen. 🏖️</div>'}
    ${overlaps.size ? '<p class="sub mt12">⚠️ Rot markierte Termine überschneiden sich.</p>' : ''}
    <div class="btn-row mt12"><a class="btn" href="#/chat">Termin mit Vio anlegen</a></div>`;
}

function renderPhone() {
  view().innerHTML = `
    <div class="chat-head"><a class="icon-btn" href="#/more">${ICON.back}</a><div class="grow">Telefon</div></div>
    <div class="card">
      <p><strong>So hilft dir Vio beim Telefonieren:</strong></p>
      <p class="meta">Sag z. B. „Ich will bei der Werkstatt Müller einen Termin für den Ölwechsel ausmachen“. Vio schreibt dir einen kurzen Gesprächsleitfaden und gibt dir einen Knopf, der dein Telefon mit der Nummer öffnet. Danach kannst du ihm das Ergebnis sagen – er trägt den Termin ein.</p>
      <p class="meta">Dass Vio <strong>selbst</strong> anruft (als KI erkennbar, ohne heimliche Aufnahme, innerhalb deines Budgets), geht nur mit einem kostenpflichtigen Telefondienst. Das kann später eingebaut werden.</p>
      <div class="btn-row"><button class="btn primary" id="call-ask">Anruf vorbereiten</button></div>
    </div>`;
  $('#call-ask').onclick = () => { newConversation(); location.hash = '#/chat'; setTimeout(() => { const i = $('#input'); if (i) { i.value = 'Bereite einen Anruf vor: '; i.focus(); } }, 80); };
}

/** Karte für vorbereitete Nachrichten (WhatsApp/SMS) und Anrufe. */
function actionCard(d) {
  if (d.type === 'call') {
    return `<div class="ac-head">📞 Anruf vorbereitet${d.contact_name ? `: ${esc(d.contact_name)}` : ''}</div>
      ${d.purpose ? `<div class="meta">${esc(d.purpose)}</div>` : ''}
      <div class="ac-body">${esc(d.script).replace(/\n/g, '<br>')}</div>
      <div class="btn-row">${d.phone ? `<a class="btn primary small" href="tel:${esc(d.phone)}">Jetzt anrufen</a>` : '<button class="btn primary small" data-pick="tel">Kontakt wählen & anrufen</button>'}</div>`;
  }
  const app = { whatsapp: 'WhatsApp', telegram: 'Telegram', sms: 'SMS' }[d.channel] || 'SMS';
  return `<div class="ac-head">${{ whatsapp: '💬', telegram: '✈️', sms: '✉️' }[d.channel] || '✉️'} ${app}${d.contact_name ? ` an ${esc(d.contact_name)}` : ''}</div>
    ${d.channel === 'telegram' ? `<div class="meta">Telegram öffnet sich – wähl dort ${d.contact_name ? esc(d.contact_name) : 'den Kontakt'} aus und tipp auf Senden.</div>` : ''}
    <div class="ac-body">${esc(d.text).replace(/\n/g, '<br>')}</div>
    <div class="btn-row" data-text="${esc(d.text)}" data-channel="${d.channel}">
      ${d.phone || d.channel === 'telegram' ? `<a class="btn primary small" href="${esc(d.url)}" target="_blank" rel="noopener">In ${app} öffnen</a>` : `<button class="btn primary small" data-pick="${d.channel}">Kontakt wählen & öffnen</button>${d.channel === 'whatsapp' ? `<a class="btn small" href="${esc(d.url)}" target="_blank" rel="noopener">In WhatsApp wählen</a>` : ''}`}
      <button class="btn small" data-copy>Text kopieren</button>
    </div>`;
}

function bindActionCards(root) {
  root.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.closest('[data-text]').dataset.text); toast('Text kopiert'); } catch { toast('Kopieren nicht möglich'); }
  }));
  root.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = async () => {
    const kind = b.dataset.pick;
    if (!('contacts' in navigator)) { toast('Kontaktauswahl wird hier nicht unterstützt – nenne Vio die Nummer.'); return; }
    try {
      const [c] = await navigator.contacts.select(['name', 'tel'], { multiple: false });
      const tel = (c?.tel?.[0] || '').replace(/[^\d+]/g, '');
      if (!tel) { toast('Der Kontakt hat keine Nummer.'); return; }
      if (kind === 'tel') { location.href = `tel:${tel}`; return; }
      const text = b.closest('[data-text]').dataset.text;
      const intl = tel.startsWith('+') ? tel.slice(1) : tel.startsWith('00') ? tel.slice(2) : tel.startsWith('0') ? '49' + tel.slice(1) : tel;
      location.href = kind === 'whatsapp' ? `https://wa.me/${intl}?text=${encodeURIComponent(text)}` : `sms:${tel}?body=${encodeURIComponent(text)}`;
    } catch { /* abgebrochen */ }
  }));
}

async function renderReminders() {
  const tasks = (await api('/api/tasks')).filter((t) => !t.done && t.due_at);
  view().innerHTML = `
    <div class="chat-head"><a class="icon-btn" href="#/more">${ICON.back}</a><div class="grow">Erinnerungen</div></div>
    <p class="sub">Aufgaben mit Uhrzeit schickt dir Vio pünktlich per Telegram (wenn verbunden). Sag z. B. „Erinner mich jeden Montag um 7 an den Müll“.</p>
    <div class="list">${tasks.length ? tasks.map(taskRow).join('') : '<div class="empty">Keine fälligen Erinnerungen. Sag z. B. „Erinner mich Freitag an den Zahnarzt“.</div>'}</div>`;
  bindTaskRows(renderReminders);
}

async function renderMemory() {
  const facts = await api('/api/facts');
  view().innerHTML = `
    <div class="chat-head"><a class="icon-btn" href="#/more">${ICON.back}</a><div class="grow">Gedächtnis</div></div>
    <p class="sub">Das weiß Vio über dich. Du entscheidest, was bleibt.</p>
    <form class="ask" id="add-fact"><input class="input" name="t" placeholder="Etwas hinzufügen …"><button class="icon-btn send">${ICON.plus}</button></form>
    <div class="list mt12">${facts.length ? facts.map((f) => f.status === 'pending' ? factRow(f) : `
      <div class="row"><div class="grow">${esc(f.text)}<div class="meta">${esc(f.category)}</div></div><button class="icon-btn" data-reject="${f.id}" aria-label="Vergessen">${ICON.trash}</button></div>`).join('')
      : '<div class="empty">Vio weiß noch nichts über dich.</div>'}</div>`;
  $('#add-fact').onsubmit = async (e) => { e.preventDefault(); const t = e.target.t.value.trim(); if (!t) return; await api('/api/facts', { method: 'POST', body: { text: t } }); renderMemory(); };
  bindFactRows(document, renderMemory);
}

// ============================================================================
//  Einstellungen
// ============================================================================
async function renderSettings() {
  const { settings: s, protected: p, providers, active_provider: activeP, backup } = await api('/api/settings');
  state.settings = s;
  const voices = voice.germanVoices();
  const vinfo = await api('/api/voices').catch(() => ({ gemini: [], provider: null }));
  const gvoices = vinfo.gemini;
  const auto = voice.pickVoice('');
  const seg = (key, opts) => `<div class="seg" data-seg="${key}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${s[key] === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;

  view().innerHTML = `
    <div class="chat-head"><a class="icon-btn" href="#/more">${ICON.back}</a><div class="grow">Einstellungen</div></div>

    <h2>Allgemein</h2>
    <div class="settings-group">
      <div class="field"><label for="name">Wie soll Vio dich nennen?</label><input class="input" id="name" value="${esc(s.user_name)}"></div>
      <div class="field"><label>Gedächtnis</label>${seg('memory_mode', [['ask', 'Erst fragen'], ['auto', 'Automatisch'], ['off', 'Aus']])}
        <div class="hint">Ob Vio sich Infos über dich merken darf.</div></div>
    </div>

    <h2>KI-Gehirn</h2>
    <div class="settings-group">
      <div class="field"><label>Aktiv: ${esc(providers.find((x) => x.id === activeP)?.label || 'keins')}</label>
        ${providers.length > 1 ? `<div class="seg" data-seg="ai_provider">${[['auto', 'Automatisch'], ...providers.map((x) => [x.id, x.id === 'gemini' ? 'Gemini (gratis)' : 'Claude'])].map(([v, l]) => `<button type="button" data-v="${v}" class="${s.ai_provider === v ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
        <div class="hint">${providers.length ? 'Weitere KI-Gehirne werden freigeschaltet, sobald ihr Schlüssel auf dem Server hinterlegt ist.' : 'Kein Schlüssel hinterlegt. Setze GEMINI_API_KEY auf dem Server.'}${providers.some((x) => x.id === 'gemini') ? ' Hinweis: Im Gratis-Zugang darf Google Gespräche zur Verbesserung seiner Produkte verwenden.' : ''}</div></div>
    </div>

    <h2>Stimme</h2>
    <div class="settings-group">
      <div class="field"><label>Antworten vorlesen</label>${seg('tts_mode', [['voice', 'Bei Sprache'], ['always', 'Immer'], ['never', 'Nie']])}</div>
      <div class="field inline"><div><label for="hf">Freisprechmodus</label><div class="hint">Nach Vios Antwort automatisch wieder zuhören.</div></div>
        <label class="switch"><input type="checkbox" id="hf" ${s.handsfree ? 'checked' : ''}><span></span></label></div>
      <div class="field"><label>Stimme</label>${seg('voice_engine', [['gemini', vinfo.provider === 'elevenlabs' ? 'Natürlich (ElevenLabs)' : 'Natürlich'], ['device', 'Handy-Stimme']])}
        <div class="hint">„Natürlich“ klingt deutlich besser, braucht aber 1–2 Sekunden länger. Ist das Gratis-Limit erreicht, springt automatisch die Handy-Stimme ein.</div></div>
      <div class="field ${s.voice_engine === 'gemini' && vinfo.provider !== 'elevenlabs' ? '' : 'hidden-field'}" id="gv-field"><label for="gvoice">Natürliche Stimme</label>
        <select class="input" id="gvoice">${(gvoices || []).map((v) => `<option value="${esc(v.id)}" ${v.id === s.gemini_voice ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>
      <div class="field ${s.voice_engine === 'device' ? '' : 'hidden-field'}" id="dv-field"><label for="voice">Handy-Stimme</label>
        <select class="input" id="voice">
          <option value="">Automatisch${auto ? ` (${esc(auto.name)})` : ''}</option>
          ${voices.map((v) => `<option value="${esc(v.name)}" ${v.name === s.voice_name ? 'selected' : ''}>${esc(v.name)}${v.localService ? '' : ' · online'}</option>`).join('')}
        </select>
        <div class="hint">${voices.length ? 'Wähle eine männliche deutsche Stimme. Weitere Stimmen: Android-Einstellungen → System → Sprachen → Text-in-Sprache → Google → Deutsch → Stimme.' : 'Keine deutschen Stimmen gefunden – installiere sie in den Android-Einstellungen (Text-in-Sprache).'}</div></div>
      <div class="field"><label>Tempo <span class="hint" id="rate-v">${s.speech_rate.toFixed(2)}</span></label><input type="range" id="rate" min="0.6" max="1.6" step="0.05" value="${s.speech_rate}"></div>
      <div class="field ${s.voice_engine === 'device' ? '' : 'hidden-field'}" id="pitch-field"><label>Stimmhöhe <span class="hint" id="pitch-v">${s.speech_pitch.toFixed(2)}</span></label><input type="range" id="pitch" min="0.5" max="1.5" step="0.05" value="${s.speech_pitch}">
        <div class="hint">Etwas tiefer klingt männlicher.</div></div>
      <div class="field"><button class="btn" id="test-voice">${ICON.speaker} Stimme testen</button></div>
    </div>

    <h2>Erinnerungen</h2>
    <div class="settings-group">
      <div class="field inline"><div><label for="tgrem">Erinnerungen per Telegram</label><div class="hint">Aufgaben mit Uhrzeit kommen pünktlich als Telegram-Nachricht.</div></div>
        <label class="switch"><input type="checkbox" id="tgrem" ${s.telegram_reminders ? 'checked' : ''}><span></span></label></div>
      <div class="field inline"><div><label for="bgn">Antwort per Telegram, wenn ich weg bin</label><div class="hint">Verlässt du die App, bevor Vio fertig ist, schickt er dir die Antwort per Telegram.</div></div>
        <label class="switch"><input type="checkbox" id="bgn" ${s.notify_background ? 'checked' : ''}><span></span></label></div>
      <div class="field"><label for="brief">Tagesübersicht am Morgen</label>
        <select class="input" id="brief">${['', '06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00'].map((t) => `<option value="${t}" ${s.morning_briefing === t ? 'selected' : ''}>${t ? t + ' Uhr' : 'Aus'}</option>`).join('')}</select>
        <div class="hint">Termine und Aufgaben des Tages per Telegram.</div></div>
    </div>

    <h2>Budget & Sicherheit</h2>
    <div class="settings-group">
      <div class="field"><label>Feste Budget-Obergrenze pro Auftrag</label>
        <div class="big-num">${p.max_budget_eur.toFixed(2).replace('.', ',')} €</div>
        <div class="hint">Vio überschreitet diese Grenze nie – egal, was im Chat gesagt wird. Bezahlen, Überweisen, Online-Kauf, Abos und Verträge sind immer gesperrt.</div>
        <div class="ask mt8"><input class="input" id="cap" type="number" min="0" max="1000" step="1" placeholder="Neue Grenze €"><input class="input" id="cap-pw" type="password" placeholder="Passwort"><button class="btn small" id="cap-save">Ändern</button></div></div>
      <div class="field"><label>Passwort ändern</label>
        <input class="input" id="pw-cur" type="password" placeholder="Aktuelles Passwort" autocomplete="current-password">
        <input class="input" id="pw-new" type="password" placeholder="Neues Passwort (min. 10 Zeichen)" autocomplete="new-password">
        <button class="btn small start" id="pw-save">Passwort ändern</button></div>
      <div class="field"><label>Datensicherung</label><div class="hint">${backup ? '✓ Automatische Sicherung in Supabase ist aktiv.' : 'Aus – Daten liegen nur auf dem Server-Speicher.'}</div></div>
    </div>`;

  const save = async (patch) => { state.settings = (await api('/api/settings', { method: 'PUT', body: patch })).settings; cacheSettings(state.settings); };
  $('#name').onchange = (e) => save({ user_name: e.target.value.trim() || 'du' }).then(() => toast('Gespeichert'));
  document.querySelectorAll('[data-seg]').forEach((g) => g.querySelectorAll('button').forEach((b) => (b.onclick = async () => {
    g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    await save({ [g.dataset.seg]: b.dataset.v });
    if (g.dataset.seg === 'ai_provider' || g.dataset.seg === 'voice_engine') renderSettings();
  })));
  $('#hf').onchange = (e) => save({ handsfree: e.target.checked });
  $('#voice').onchange = (e) => save({ voice_name: e.target.value });
  $('#gvoice')?.addEventListener('change', (e) => save({ gemini_voice: e.target.value }));
  $('#brief')?.addEventListener('change', (e) => save({ morning_briefing: e.target.value }).then(() => toast(e.target.value ? `Tagesübersicht um ${e.target.value}` : 'Tagesübersicht aus')));
  $('#tgrem')?.addEventListener('change', (e) => save({ telegram_reminders: e.target.checked }));
  $('#bgn')?.addEventListener('change', (e) => save({ notify_background: e.target.checked }));
  $('#rate').oninput = (e) => ($('#rate-v').textContent = Number(e.target.value).toFixed(2));
  $('#rate').onchange = (e) => save({ speech_rate: Number(e.target.value) });
  $('#pitch').oninput = (e) => ($('#pitch-v').textContent = Number(e.target.value).toFixed(2));
  $('#pitch').onchange = (e) => save({ speech_pitch: Number(e.target.value) });
  $('#test-voice').onclick = () => {
    const cur = { ...state.settings, voice_name: $('#voice').value, gemini_voice: $('#gvoice')?.value || state.settings.gemini_voice, speech_rate: Number($('#rate').value), speech_pitch: Number($('#pitch').value) };
    voice.stopSpeaking(); voice.say(`Hey ${cur.user_name}, ich bin Vio. So klinge ich gerade. Passt das?`, cur);
  };
  $('#cap-save').onclick = async () => {
    try {
      await api('/api/settings/protected', { method: 'PUT', body: { password: $('#cap-pw').value, max_budget_eur: Number($('#cap').value) } });
      toast('Obergrenze geändert'); renderSettings();
    } catch (e) { toast(e.message); }
  };
  $('#pw-save').onclick = async () => {
    try {
      await api('/api/settings/password', { method: 'PUT', body: { current: $('#pw-cur').value, next: $('#pw-new').value } });
      toast('Passwort geändert – bitte neu anmelden'); renderLogin();
    } catch (e) { toast(e.message); }
  };
  if (!voices.length && voice.canSpeak) speechSynthesis.onvoiceschanged = () => { if (location.hash === '#/settings') renderSettings(); };
}

// ============================================================================
//  Installation (PWA)
// ============================================================================
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); state.installPrompt = e;
  if (!location.hash || location.hash === '#/') route();
});
async function doInstall() {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null; route();
}
window.addEventListener('appinstalled', () => toast('Vio ist installiert 🎉'));

// ============================================================================
//  Start
// ============================================================================
async function boot() {
  try {
    const me = await api('/api/settings');
    state.settings = me.settings;
    cacheSettings(me.settings);
  } catch (e) {
    if (e instanceof AuthError) return renderLogin();
    const cached = cachedSettings();
    if (isNetworkError(e) && cached) { state.settings = cached; $('#nav').hidden = false; return renderOffline(location.hash.replace(/^#\/?/, '').split('/')[0]); }
    view().innerHTML = `<div class="empty">Server nicht erreichbar: ${esc(e.message)}</div>`;
    return;
  }
  setTimeout(flushOutbox, 1500);
  $('#nav').hidden = false;
  await route();
  // Shortcut „Mit Vio sprechen“ vom Startbildschirm
  if (new URLSearchParams(location.search).get('voice') === '1') {
    history.replaceState(null, '', '/#/chat');
    setTimeout(startListening, 300);
  }
}

$('#nav-aura').onclick = () => openConversation();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
