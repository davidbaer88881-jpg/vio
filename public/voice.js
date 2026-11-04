// Sprache: Erkennung (Mikrofon → Text) und Ausgabe (Text → Stimme).
// Nutzt die in Chrome/Android eingebauten Sprachdienste (Google-Spracherkennung, Android-Sprachausgabe).

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = !!SR;
export const canSpeak = 'speechSynthesis' in window;

// ---------- Spracherkennung ----------
let rec = null;
export function listen({ onInterim, onFinal, onEnd, onError }) {
  if (!SR) { onError?.('Spracherkennung wird von diesem Browser nicht unterstützt. Bitte Chrome verwenden.'); return; }
  stopListening();
  stopSpeaking();
  rec = new SR();
  rec.lang = 'de-DE';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    onInterim?.((finalText + ' ' + interim).trim());
  };
  rec.onerror = (e) => {
    const map = {
      'not-allowed': 'Mikrofon-Zugriff verweigert. Erlaube das Mikrofon in den Chrome-Website-Einstellungen.',
      'no-speech': null, 'aborted': null,
      'network': 'Spracherkennung braucht eine Internetverbindung.',
      'audio-capture': 'Kein Mikrofon gefunden – oder eine andere App benutzt es gerade.',
      'service-not-allowed': 'Die Google-Spracherkennung ist blockiert. Prüfe im Play Store, ob „Speech Services by Google“ installiert und aktuell ist.',
      'language-not-supported': 'Deutsch ist für die Spracherkennung nicht verfügbar. Installiere Deutsch in „Speech Services by Google“.',
    };
    const msg = e.error in map ? map[e.error] : `Spracherkennung: ${e.error}`;
    if (msg) onError?.(msg, e.error);
  };
  rec.onend = () => {
    rec = null;
    const t = finalText.trim();
    if (t) onFinal?.(t);
    onEnd?.(!!t);
  };
  try { rec.start(); } catch (e) { rec = null; onError?.(`Mikrofon konnte nicht starten: ${e.message}`); }
}
export function stopListening() { try { rec?.abort(); } catch {} rec = null; }
export const isListening = () => !!rec;

// ---------- Sprachausgabe ----------
let voices = [];
function loadVoices() { voices = canSpeak ? speechSynthesis.getVoices() : []; }
if (canSpeak) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

export function germanVoices() {
  loadVoices();
  return voices.filter((v) => v.lang?.toLowerCase().startsWith('de'));
}

// Bekannte männliche Stimmen (Android/Google, Microsoft, Apple) – Bevorzugung, falls vorhanden.
const MALE_HINT = /(male|männlich|mann|hans|markus|stefan|conrad|florian|killian|yannick|ralf|jonas|christoph|klaus|de-de-x-deb|de-de-x-deg|de-de-x-nfh)/i;
const FEMALE_HINT = /(female|weiblich|anna|petra|katja|hedda|helena|marlene|vicki|amala|de-de-x-dea|de-de-x-nfb)/i;

export function pickVoice(preferredName) {
  const de = germanVoices();
  if (preferredName) { const v = de.find((x) => x.name === preferredName); if (v) return v; }
  return de.find((v) => MALE_HINT.test(v.name) && !FEMALE_HINT.test(v.name))
    || de.find((v) => !FEMALE_HINT.test(v.name) && v.localService)
    || de[0] || null;
}

export function cleanForSpeech(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' (Code siehe Bildschirm) ')
    .replace(/[*_`#>]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'Link')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

let queue = 0;
let onIdle = null;
let currentAudio = null;
let ttsAbort = null;

function begin() { queue++; window.dispatchEvent(new CustomEvent('vio-speaking', { detail: true })); }
function finish() {
  queue = Math.max(0, queue - 1);
  if (queue === 0) {
    window.dispatchEvent(new CustomEvent('vio-speaking', { detail: false }));
    const cb = onIdle; onIdle = null; cb?.();
  }
}

/** Natürliche Stimme (Gemini über den Server). Fällt bei Problemen auf die Handy-Stimme zurück.
 *  Mehrere Teile werden parallel vorgeladen, aber streng nacheinander abgespielt. */
let generation = 0;
let playChain = Promise.resolve();
async function fetchTts(text, settings, signal, timeoutMs = 9000) {
  // Kommt die natürliche Stimme nicht schnell genug (z. B. Server wacht gerade auf), spricht die Handy-Stimme
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  signal?.addEventListener('abort', () => ac.abort(), { once: true });
  const res = await fetch('/api/tts', {
    method: 'POST', signal: ac.signal, credentials: 'same-origin',
    headers: { 'X-Vio': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 1500), voice: settings.gemini_voice }),
  });
  clearTimeout(t);
  if (!res.ok) throw new Error('tts ' + res.status);
  return res.blob();
}

// ---------- Lautsprecher „entsperren“ ----------
// Android spielt Ton nur ab, wenn er direkt durch Antippen gestartet wurde. Wir starten deshalb beim
// Antippen einmal ein stummes Audio und benutzen dieses Element danach für alle Antworten.
let sharedAudio = null;
function silentWavUrl() {
  const n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
/** MUSS direkt im Tipp-Handler aufgerufen werden. */
export function unlockAudio() {
  try {
    if (!sharedAudio) sharedAudio = new Audio();
    sharedAudio.src = silentWavUrl();
    sharedAudio.play().catch(() => {});
  } catch {}
  try { if (canSpeak) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } } catch {}
}
function playBlob(blob, settings) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = sharedAudio || new Audio();
    let settled = false;
    const done = (ok) => {
      if (settled) return; settled = true;
      audio.onended = audio.onerror = audio.onpause = null;
      URL.revokeObjectURL(url); if (currentAudio === audio) currentAudio = null; resolve(ok);
    };
    audio.onended = () => done(true);
    audio.onerror = () => done(false);
    audio.onpause = () => { if (!audio.ended && currentAudio === audio) done(true); };
    audio.src = url;
    audio.playbackRate = settings.speech_rate || 1;
    currentAudio = audio;
    audio.play().catch(() => done(false));
  });
}
export function speakNatural(text, settings = {}) {
  const clean = cleanForSpeech(text);
  if (!clean) return Promise.resolve();
  const myGen = generation;
  if (!ttsAbort || ttsAbort.signal.aborted) ttsAbort = new AbortController();
  const audioPromise = (settings._cachedBlob ? Promise.resolve(settings._cachedBlob) : fetchTts(clean, settings, ttsAbort.signal, settings._timeoutMs)).catch(() => null); // sofort vorladen
  begin();
  playChain = playChain.then(async () => {
    if (myGen !== generation) return;
    const blob = await audioPromise;
    if (myGen !== generation) return;
    const ok = blob ? await playBlob(blob, settings) : false;
    if (myGen !== generation) return;
    finish();
    if (!ok) speak(text, settings); // Handy-Stimme als Ersatz
  });
  return playChain;
}

/** Spricht mit der eingestellten Stimme. */
export function say(text, settings = {}) {
  if (settings.voice_engine === 'gemini') return speakNatural(text, settings);
  return speak(text, settings);
}

export function speak(text, settings = {}) {
  if (!canSpeak) return;
  const clean = cleanForSpeech(text);
  if (!clean) return;
  const u = new SpeechSynthesisUtterance(clean);
  const v = pickVoice(settings.voice_name);
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'de-DE';
  u.rate = settings.speech_rate || 1;
  u.pitch = settings.speech_pitch ?? 0.85; // etwas tiefer = männlicher Klang
  begin();
  // Android-Chrome feuert „onend“ manchmal nicht → Sicherheits-Timer, damit das Gespräch nicht hängen bleibt
  let ended = false;
  const myGen = generation;
  const end = () => { if (ended) return; ended = true; clearTimeout(safety); if (myGen === generation) finish(); };
  const safety = setTimeout(end, 4000 + clean.length * 90);
  u.onend = end; u.onerror = end;
  speechSynthesis.speak(u);
}

/** Promise, die erfüllt wird, wenn Vio fertig gesprochen hat. */
export function speechDone() { return new Promise((r) => whenSpeechDone(r)); }

/** Begrüßung: einmal erzeugt, danach aus dem Zwischenspeicher → sofort hörbar. */
export async function sayCached(text, settings = {}) {
  if (settings.voice_engine !== 'gemini' || !('caches' in window)) { speak(text, settings); return speechDone(); }
  const key = `/tts-cache/${encodeURIComponent(settings.gemini_voice || 'Puck')}/${encodeURIComponent(text)}`;
  try {
    const cache = await caches.open('vio-tts-v1');
    const hit = await cache.match(key);
    if (hit) { speakNatural(text, { ...settings, _cachedBlob: await hit.blob() }); return speechDone(); }
    const blob = await fetchTts(cleanForSpeech(text), settings, null, 3500); // max. 3,5 s warten
    cache.put(key, new Response(blob, { headers: { 'content-type': 'audio/wav' } })).catch(() => {});
    speakNatural(text, { ...settings, _cachedBlob: blob });
  } catch {
    speak(text, settings); // zu langsam / Limit → Handy-Stimme
  }
  return speechDone();
}
export function whenSpeechDone(cb) { if (queue === 0) cb(); else onIdle = cb; }
export function stopSpeaking() {
  generation++;
  playChain = Promise.resolve();
  onIdle = null; queue = 0;
  try { ttsAbort?.abort(); } catch {}
  if (currentAudio) { try { currentAudio.pause(); } catch {} currentAudio = null; }
  if (canSpeak) speechSynthesis.cancel();
  window.dispatchEvent(new CustomEvent('vio-speaking', { detail: false }));
}
export const isSpeaking = () => queue > 0;

/** Liest gestreamten Text satzweise vor, damit Vio schon spricht, während er noch „denkt“. */
export class SentenceSpeaker {
  constructor(settings) { this.settings = settings; this.buf = ''; }
  push(delta) {
    this.buf += delta;
    if (this.settings.voice_engine === 'gemini') {
      // Natürliche Stimme: ersten Satz sofort sprechen (schnellere Reaktion), den Rest am Stück (spart Anfragen)
      if (this.firstDone) return;
      const i = this.buf.search(/[.!?…]\s/);
      if (i !== -1 && i > 8) { this.firstDone = true; say(this.buf.slice(0, i + 1), this.settings); this.buf = this.buf.slice(i + 2); }
      return;
    }
    let i;
    // Satzende = . ! ? … gefolgt von Leerzeichen/Zeilenumbruch (nicht "z.B." mitten im Wort)
    while ((i = this.buf.search(/[.!?…]\s/)) !== -1) {
      const sentence = this.buf.slice(0, i + 1);
      this.buf = this.buf.slice(i + 2);
      if (sentence.trim().length > 1) speak(sentence, this.settings);
    }
  }
  flush() { if (this.buf.trim()) say(this.buf, this.settings); this.buf = ''; }
}

// ---------- Sprachaufnahme ohne Netz (wird später hochgeladen und in Text umgewandelt) ----------
export const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
let recorder = null;

/** Startet eine Aufnahme. Gibt { stop(): Promise<Blob WAV> , cancel() } zurück. */
export async function startRecording() {
  stopSpeaking();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const chunks = [];
  const rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start(250);
  recorder = rec;
  const started = Date.now();
  const autoStop = setTimeout(() => rec.state === 'recording' && rec.stop(), 3 * 60e3); // max. 3 Minuten
  const finished = new Promise((resolve) => (rec.onstop = resolve));
  const cleanup = () => { clearTimeout(autoStop); stream.getTracks().forEach((t) => t.stop()); recorder = null; };
  return {
    started,
    async stop() {
      if (rec.state === 'recording') rec.stop();
      await finished; cleanup();
      return toWav(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
    },
    cancel() { try { rec.state === 'recording' && rec.stop(); } catch {} cleanup(); },
  };
}
export const isRecording = () => !!recorder;

/** Wandelt die Aufnahme (webm/opus) in eine kleine WAV-Datei (16 kHz, mono) um – die versteht Gemini sicher. */
async function toWav(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close?.();
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = offline.createBufferSource();
  src.buffer = decoded; src.connect(offline.destination); src.start();
  const pcm = (await offline.startRendering()).getChannelData(0);
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}
