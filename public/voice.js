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
    if (msg) onError?.(msg);
  };
  rec.onend = () => {
    rec = null;
    const t = finalText.trim();
    if (t) onFinal?.(t);
    onEnd?.(!!t);
  };
  rec.start();
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
export function speak(text, settings = {}) {
  if (!canSpeak) return;
  const clean = cleanForSpeech(text);
  if (!clean) return;
  const u = new SpeechSynthesisUtterance(clean);
  const v = pickVoice(settings.voice_name);
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'de-DE';
  u.rate = settings.speech_rate || 1;
  u.pitch = settings.speech_pitch ?? 0.85; // etwas tiefer = männlicher Klang
  queue++;
  window.dispatchEvent(new CustomEvent('vio-speaking', { detail: true }));
  const finish = () => {
    queue = Math.max(0, queue - 1);
    if (queue === 0) {
      window.dispatchEvent(new CustomEvent('vio-speaking', { detail: false }));
      const cb = onIdle; onIdle = null; cb?.();
    }
  };
  u.onend = finish; u.onerror = finish;
  speechSynthesis.speak(u);
}
export function whenSpeechDone(cb) { if (queue === 0) cb(); else onIdle = cb; }
export function stopSpeaking() {
  if (!canSpeak) return;
  onIdle = null; queue = 0;
  speechSynthesis.cancel();
  window.dispatchEvent(new CustomEvent('vio-speaking', { detail: false }));
}
export const isSpeaking = () => queue > 0;

/** Liest gestreamten Text satzweise vor, damit Vio schon spricht, während er noch „denkt“. */
export class SentenceSpeaker {
  constructor(settings) { this.settings = settings; this.buf = ''; }
  push(delta) {
    this.buf += delta;
    let i;
    // Satzende = . ! ? … gefolgt von Leerzeichen/Zeilenumbruch (nicht "z.B." mitten im Wort)
    while ((i = this.buf.search(/[.!?…]\s/)) !== -1) {
      const sentence = this.buf.slice(0, i + 1);
      this.buf = this.buf.slice(i + 2);
      if (sentence.trim().length > 1) speak(sentence, this.settings);
    }
  }
  flush() { if (this.buf.trim()) speak(this.buf, this.settings); this.buf = ''; }
}
