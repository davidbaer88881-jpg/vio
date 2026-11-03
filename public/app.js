import { api, streamChat, AuthError } from './api.js';
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
export const VERSION = '0.2.3';
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
  const [, name = '', arg] = location.hash.replace(/^#/, '').split('/');
  const fn = routes[name] || renderHome;
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const n = a.dataset.nav;
    a.classList.toggle('active', n === (name || 'home') || (n === 'more' && ['calendar', 'phone', 'reminders', 'memory', 'settings'].includes(name)) || (n === 'chat' && name === 'history'));
  });
  if (name !== 'chat') { voice.stopListening(); }
  try {
    await fn(arg);
  } catch (e) {
    if (e instanceof AuthError) return renderLogin();
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
async function renderHome() {
  const data = await api('/api/home');
  state.settings = data.settings;
  const name = data.settings.user_name || 'du';
  const quip = QUIPS[Math.floor(Math.random() * QUIPS.length)];
  const brain = data.connections.find((c) => c.id === 'ai');

  view().innerHTML = `
    <section class="hero">
      <div class="greet">${esc(greeting(name))} 👋</div>
      <h1>Ich bin Vio.</h1>
      <p class="sub">${esc(quip)}</p>
      <div class="orb-wrap"><button class="orb" id="orb" aria-label="Mit Vio sprechen">${ICON.mic}</button></div>
      <form class="ask" id="ask">
        <input class="input" name="q" placeholder="Oder schreib mir …" autocomplete="off" enterkeyhint="send">
        <button class="icon-btn send" aria-label="Senden">${ICON.send}</button>
      </form>
      ${brain.status !== 'connected' ? `<div class="empty warn-box">Kein KI-Schlüssel auf dem Server – Vio kann noch nicht antworten. Setze GEMINI_API_KEY (kostenlos).</div>` : ''}
    </section>

    ${state.installPrompt ? `<div class="card install-banner"><div class="avatar">V</div><div class="grow">Vio als App auf dem Startbildschirm installieren?</div><button class="btn primary small" id="install">Installieren</button></div>` : ''}

    ${data.pending_facts.length ? `
      <h2>Soll ich mir das merken?</h2>
      <div class="list">${data.pending_facts.map(factRow).join('')}</div>` : ''}

    <h2>Nächste Termine</h2>
    <a class="empty block" href="#/calendar">${ICON.cal.replace('<svg', '<svg class="ico-inline"')}Google Kalender ist noch nicht verbunden.</a>

    <h2>Offene Aufgaben</h2>
    <div class="list">
      ${data.tasks.length ? data.tasks.map(taskRow).join('') : '<div class="empty">Nichts offen. Sag z. B. „Erinner mich, Milch zu kaufen“.</div>'}
    </div>

    <h2>Letzte Unterhaltungen</h2>
    <div class="list">
      ${data.conversations.length ? data.conversations.map((c) => `
        <a class="row" href="#/chat/${c.id}"><div class="grow"><div class="title">${esc(c.title)}</div><div class="meta">${relTime(c.updated_at)}</div></div></a>`).join('')
        : '<div class="empty">Noch keine Gespräche.</div>'}
    </div>

    <h2>Meine Apps</h2>
    <div class="status-chips">${data.connections.map(connChip).join('')}</div>
  `;

  // Mikrofon SOFORT im Tipp starten (Android erlaubt das nur direkt bei der Berührung), dann zum Chat wechseln
  $('#orb').onclick = () => { newConversation(); startListening(); location.hash = '#/chat'; };
  $('#ask').onsubmit = (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim(); if (!q) return;
    newConversation(); location.hash = '#/chat';
    setTimeout(() => sendMessage(q, false), 60);
  };
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
    <div class="grow"><div class="title ${t.done ? 'done-text' : ''}">${esc(t.title)}</div>${t.due_at ? `<div class="meta">${esc(fmtDue(t.due_at))}</div>` : ''}</div>
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
    const conv = await api(`/api/conversations/${Number(id)}`);
    state.convId = conv.id; state.convTitle = conv.title;
    state.messages = conv.messages.map((m) => ({ role: m.role, content: m.content }));
  }
  if (!state.settings) state.settings = (await api('/api/settings')).settings;

  view().innerHTML = `
    <section class="chat-view">
      <div class="chat-head">
        <div class="avatar">V</div>
        <div class="grow">${esc(state.convTitle || 'Vio')}</div>
        <a class="icon-btn" href="#/history" aria-label="Verlauf">${ICON.history}</a>
        <button class="icon-btn" id="new-chat" aria-label="Neues Gespräch">${ICON.plus}</button>
      </div>
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
    if (m.role === 'event') return `<div class="event ${m.kind || ''}">${m.html}</div>`;
    if (m.role === 'user') return `<div class="msg user">${esc(m.content).replace(/\n/g, '<br>')}</div>`;
    return `<div class="msg assistant ${m.typing ? 'typing' : ''}" data-i="${i}">${md(m.content)}${!m.typing && m.content ? `<button class="speak" data-speak="${i}" aria-label="Vorlesen">${ICON.speaker}</button>` : ''}</div>`;
  }).join('');
  box.querySelectorAll('[data-speak]').forEach((b) => (b.onclick = () => { voice.stopSpeaking(); voice.speak(state.messages[b.dataset.speak].content, state.settings); }));
  bindFactRows(box, () => {});
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
  m.classList.toggle('listening', voice.isListening());
  m.classList.toggle('speaking', !voice.isListening() && voice.isSpeaking());
  const hint = $('#hint');
  if (hint) hint.textContent = voice.isListening() ? 'Ich höre zu …' : voice.isSpeaking() ? 'Vio spricht – tippe aufs Mikro zum Unterbrechen' : state.handsfreeActive ? 'Freisprechmodus aktiv' : '';
}
window.addEventListener('vio-speaking', updateMic);

function stopAll() {
  state.streaming?.abort();
  voice.stopSpeaking(); voice.stopListening();
  state.handsfreeActive = false;
  updateMic();
}

function startListening() {
  if (!voice.canListen) { toast('Spracherkennung geht hier nicht – bitte Chrome auf Android nutzen.'); return; }
  state.handsfreeActive = !!state.settings?.handsfree;
  voice.listen({
    onInterim: (t) => { const i = $('#input'); if (i) i.value = t; },
    onFinal: (t) => { const i = $('#input'); if (i) i.value = ''; sendMessage(t, true); },
    onEnd: (gotText) => { if (!gotText) state.handsfreeActive = false; updateMic(); },
    onError: (msg) => { toast(msg, 5000); state.handsfreeActive = false; updateMic(); },
  });
  updateMic();
}

async function sendMessage(text, viaVoice) {
  if (state.streaming) return;
  if (!$('#messages')) { location.hash = '#/chat'; await renderChat(); }
  voice.stopSpeaking();

  const s = state.settings || {};
  const shouldSpeak = s.tts_mode === 'always' || (s.tts_mode !== 'never' && viaVoice);
  const speaker = shouldSpeak ? new voice.SentenceSpeaker(s) : null;

  state.messages.push({ role: 'user', content: text });
  const reply = { role: 'assistant', content: '', typing: true };
  state.messages.push(reply);
  renderMessages();

  const ac = new AbortController();
  state.streaming = ac; updateSendBtn();

  let pending = '';
  let raf = 0;
  const flush = () => { raf = 0; const el = document.querySelector(`.msg[data-i="${state.messages.indexOf(reply)}"]`); if (el) { el.innerHTML = md(reply.content); window.scrollTo({ top: document.body.scrollHeight }); } };

  try {
    await streamChat({
      text, conversationId: state.convId, signal: ac.signal,
      onEvent: (ev, data) => {
        if (ev === 'meta') { state.convId = data.conversation_id; if (!state.convTitle) state.convTitle = text.slice(0, 60); }
        else if (ev === 'delta') { reply.content += data.text; speaker?.push(data.text); if (!raf) raf = requestAnimationFrame(flush); }
        else if (ev === 'tool') { insertEvent(reply, data); }
        else if (ev === 'error') { reply.content += (reply.content ? '\n\n' : '') + '⚠️ ' + data.message; }
      },
    });
  } catch (e) {
    if (e instanceof AuthError) return renderLogin();
    if (e.name !== 'AbortError') reply.content += (reply.content ? '\n\n' : '') + '⚠️ Verbindung unterbrochen: ' + e.message;
    else reply.content += reply.content ? ' …' : '(abgebrochen)';
  } finally {
    reply.typing = false;
    state.streaming = null;
    speaker?.flush();
    renderMessages(); updateSendBtn();
    const head = document.querySelector('.chat-head .grow'); if (head) head.textContent = state.convTitle || 'Vio';
    if (history.replaceState && state.convId) history.replaceState(null, '', `#/chat/${state.convId}`);
  }

  // Freisprechmodus: nach Vios Antwort automatisch wieder zuhören
  if (viaVoice && state.handsfreeActive) voice.whenSpeechDone(() => { if (state.handsfreeActive && $('#mic')) startListening(); });
}

function insertEvent(reply, data) {
  const idx = state.messages.indexOf(reply);
  let ev;
  if (data.type === 'task') ev = { kind: 'allow', html: `${ICON.check.replace('<svg', '<svg class="ico-sm"')} Aufgabe notiert: ${esc(data.title)}` };
  else if (data.type === 'fact') ev = data.status === 'pending'
    ? { html: `Merken? „${esc(data.text)}“ <button class="btn small primary" data-approve="${data.id}">Ja</button><button class="btn small" data-reject="${data.id}">Nein</button>` }
    : { html: `🧠 Gemerkt: ${esc(data.text)}` };
  else if (data.type === 'policy') {
    const k = { allow: 'allow', deny: 'deny', ask_user: 'ask', need_price: 'ask' }[data.decision] || '';
    const label = { allow: 'Freigegeben', deny: 'Blockiert', ask_user: 'Rückfrage nötig', need_price: 'Preis erst erfragen' }[data.decision];
    ev = { kind: k, html: `${ICON.shield.replace('<svg', '<svg class="ico-sm"')} Budget-Regel: <strong>${esc(label)}</strong> – ${esc(data.reason)}` };
  } else ev = { html: esc(data.label || 'Aktion ausgeführt') };
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
async function renderTasks() {
  const tasks = await api('/api/tasks');
  const open = tasks.filter((t) => !t.done), done = tasks.filter((t) => t.done).slice(0, 15);
  view().innerHTML = `
    <h1>Aufgaben</h1>
    <p class="sub">Sag Vio einfach, was zu tun ist – oder trag es hier ein.</p>
    <form class="ask" id="add-task">
      <input class="input" name="title" placeholder="Neue Aufgabe …" autocomplete="off">
      <input class="input" name="due" type="date" data-date>
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
async function renderApps() {
  const conns = await api('/api/connections');
  const label = { connected: 'Verbunden', missing_key: 'Schlüssel fehlt', planned: 'Geplant' };
  view().innerHTML = `
    <h1>Apps & Verbindungen</h1>
    <p class="sub">Hier siehst du ehrlich, was Vio schon kann – und was noch kommt.</p>
    <div class="list">
      ${conns.map((c) => `<div class="row">
        <span class="dot ${c.status === 'connected' ? 'ok' : c.status === 'missing_key' ? 'warn' : 'off'}"></span>
        <div class="grow"><div class="title">${esc(c.name)}</div><div class="meta">${c.status === 'planned' ? `Kommt in Phase ${c.phase}` : label[c.status]}</div></div>
        <span class="badge">${label[c.status]}</span></div>`).join('')}
    </div>
    <h2>Später geplant</h2>
    <div class="status-chips">${['Google Maps', 'Google Drive', 'Google Tasks', 'Google Keep', 'Spotify', 'Amazon (nur Suche)', 'Wetter', 'Banking (nur lesen)'].map((n) => `<span class="chip"><span class="dot off"></span>${n}</span>`).join('')}</div>`;
}

// ============================================================================
//  Mehr + Unterseiten
// ============================================================================
function renderMore() {
  const tiles = [
    ['calendar', ICON.cal, 'Kalender', 'Phase 7'],
    ['reminders', ICON.bell, 'Erinnerungen', 'Fällige Aufgaben'],
    ['phone', ICON.phone, 'Telefon', 'Phase 9'],
    ['memory', ICON.brain, 'Gedächtnis', 'Was Vio über dich weiß'],
    ['settings', ICON.gear, 'Einstellungen', 'Stimme, Budget, Sicherheit'],
    ['history', ICON.history, 'Verlauf', 'Alte Gespräche'],
  ];
  view().innerHTML = `<h1>Mehr</h1><p class="sub">Alles Weitere an einem Ort.</p>
    <div class="tiles">${tiles.map(([r, i, t, m]) => `<a class="tile" href="#/${r}">${i}<div><div>${t}</div><div class="meta">${m}</div></div></a>`).join('')}</div>
    <p class="sub center mt24"><button class="btn small" id="logout">Abmelden</button></p>
    <p class="sub center">Vio Version ${VERSION}</p>`;
  $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); renderLogin(); };
}

function placeholder(title, icon, text, phase) {
  view().innerHTML = `
    <div class="chat-head"><a class="icon-btn" href="#/more">${ICON.back}</a><div class="grow">${title}</div></div>
    <div class="card placeholder">
      <div class="ph-icon">${icon}</div>
      <p>${text}</p>
      <span class="badge">Noch nicht verbunden · Phase ${phase}</span>
    </div>`;
}
function renderCalendar() { return placeholder('Kalender', ICON.cal, 'Hier erscheinen bald deine Google-Kalender-Termine mit Tages- und Wochenübersicht und Kollisionswarnungen.', 7); }
function renderPhone() { return placeholder('Telefon', ICON.phone, 'Hier kann Vio bald für dich anrufen – als KI erkennbar, ohne heimliche Aufnahme, streng innerhalb deines Budgets.', 9); }

async function renderReminders() {
  const tasks = (await api('/api/tasks')).filter((t) => !t.done && t.due_at);
  view().innerHTML = `
    <div class="chat-head"><a class="icon-btn" href="#/more">${ICON.back}</a><div class="grow">Erinnerungen</div></div>
    <p class="sub">Aufgaben mit Fälligkeit. Push-Benachrichtigungen aufs Handy folgen mit dem Kalender-Modul (Phase 7).</p>
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
      <div class="field"><label for="voice">Stimme</label>
        <select class="input" id="voice">
          <option value="">Automatisch${auto ? ` (${esc(auto.name)})` : ''}</option>
          ${voices.map((v) => `<option value="${esc(v.name)}" ${v.name === s.voice_name ? 'selected' : ''}>${esc(v.name)}${v.localService ? '' : ' · online'}</option>`).join('')}
        </select>
        <div class="hint">${voices.length ? 'Wähle eine männliche deutsche Stimme. Weitere Stimmen: Android-Einstellungen → System → Sprachen → Text-in-Sprache → Google → Deutsch → Stimme.' : 'Keine deutschen Stimmen gefunden – installiere sie in den Android-Einstellungen (Text-in-Sprache).'}</div></div>
      <div class="field"><label>Tempo <span class="hint" id="rate-v">${s.speech_rate.toFixed(2)}</span></label><input type="range" id="rate" min="0.6" max="1.6" step="0.05" value="${s.speech_rate}"></div>
      <div class="field"><label>Stimmhöhe <span class="hint" id="pitch-v">${s.speech_pitch.toFixed(2)}</span></label><input type="range" id="pitch" min="0.5" max="1.5" step="0.05" value="${s.speech_pitch}">
        <div class="hint">Etwas tiefer klingt männlicher.</div></div>
      <div class="field"><button class="btn" id="test-voice">${ICON.speaker} Stimme testen</button></div>
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

  const save = async (patch) => { state.settings = (await api('/api/settings', { method: 'PUT', body: patch })).settings; };
  $('#name').onchange = (e) => save({ user_name: e.target.value.trim() || 'du' }).then(() => toast('Gespeichert'));
  document.querySelectorAll('[data-seg]').forEach((g) => g.querySelectorAll('button').forEach((b) => (b.onclick = async () => {
    g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    await save({ [g.dataset.seg]: b.dataset.v });
    if (g.dataset.seg === 'ai_provider') renderSettings();
  })));
  $('#hf').onchange = (e) => save({ handsfree: e.target.checked });
  $('#voice').onchange = (e) => save({ voice_name: e.target.value });
  $('#rate').oninput = (e) => ($('#rate-v').textContent = Number(e.target.value).toFixed(2));
  $('#rate').onchange = (e) => save({ speech_rate: Number(e.target.value) });
  $('#pitch').oninput = (e) => ($('#pitch-v').textContent = Number(e.target.value).toFixed(2));
  $('#pitch').onchange = (e) => save({ speech_pitch: Number(e.target.value) });
  $('#test-voice').onclick = () => {
    const cur = { ...state.settings, voice_name: $('#voice').value, speech_rate: Number($('#rate').value), speech_pitch: Number($('#pitch').value) };
    voice.stopSpeaking(); voice.speak(`Hey ${cur.user_name}, ich bin Vio. So klinge ich gerade. Passt das?`, cur);
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
  } catch (e) {
    if (e instanceof AuthError) return renderLogin();
    view().innerHTML = `<div class="empty">Server nicht erreichbar: ${esc(e.message)}</div>`;
    return;
  }
  $('#nav').hidden = false;
  await route();
  // Shortcut „Mit Vio sprechen“ vom Startbildschirm
  if (new URLSearchParams(location.search).get('voice') === '1') {
    history.replaceState(null, '', '/#/chat');
    setTimeout(startListening, 300);
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
