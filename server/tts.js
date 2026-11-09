// Natürliche Sprachausgabe über Gemini TTS (läuft mit dem Gratis-Schlüssel, solange Google das anbietet).
// Fällt das aus (Limit, Überlastung), nutzt die App automatisch die Handy-Stimme.
import { config } from './config.js';

// Männlich klingende Gemini-Stimmen (Google beschreibt nur den Charakter, nicht das Geschlecht)
export const GEMINI_VOICES = [
  { id: 'Puck', label: 'Puck – locker & gut gelaunt' },
  { id: 'Achird', label: 'Achird – freundlich' },
  { id: 'Charon', label: 'Charon – ruhig & sachlich' },
  { id: 'Orus', label: 'Orus – fest & klar' },
  { id: 'Fenrir', label: 'Fenrir – lebhaft' },
  { id: 'Iapetus', label: 'Iapetus – klar' },
  { id: 'Algieba', label: 'Algieba – weich' },
  { id: 'Algenib', label: 'Algenib – rau' },
  { id: 'Sadachbia', label: 'Sadachbia – lebendig' },
  { id: 'Zubenelgenubi', label: 'Zubenelgenubi – lässig' },
  { id: 'Umbriel', label: 'Umbriel – entspannt' },
  { id: 'Schedar', label: 'Schedar – ausgeglichen' },
];

/** Verpackt rohes 16-bit-PCM (mono) in eine WAV-Datei. */
export function pcmToWav(pcm, sampleRate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Kleiner Zwischenspeicher: gleiche Sätze (Begrüßung, „Erledigt!“ …) kommen sofort
const cache = new Map();
const CACHE_MAX = 60;
export function ttsProvider() { return config.elevenKey ? 'elevenlabs' : config.geminiKey ? 'gemini' : null; }

export async function synthesize(text, voice = 'Puck', signal) {
  const clean = String(text).slice(0, 1500);
  const key = `${ttsProvider()}|${voice}|${clean}`;
  if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; }
  let audio;
  if (config.elevenKey) {
    try { audio = await elevenlabs(clean, signal); } catch (e) { if (!config.geminiKey) throw e; console.error('ElevenLabs:', e.message); }
  }
  if (!audio) audio = await gemini(clean, voice, signal);
  cache.set(key, audio);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return audio;
}

async function elevenlabs(text, signal) {
  const res = await fetch(`${config.elevenBase}/v1/text-to-speech/${encodeURIComponent(config.elevenVoiceId)}?output_format=mp3_44100_64&optimize_streaming_latency=3`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'xi-api-key': config.elevenKey, accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: config.elevenModel, language_code: 'de', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true } }),
  });
  if (!res.ok) throw Object.assign(new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 150)}`), { status: res.status });
  return { data: Buffer.from(await res.arrayBuffer()), type: 'audio/mpeg' };
}

async function gemini(clean, voice, signal) {
  if (!config.geminiKey) throw Object.assign(new Error('Kein Gemini-Schlüssel'), { status: 503 });
  const voiceName = GEMINI_VOICES.some((v) => v.id === voice) ? voice : 'Puck';
  let lastErr;
  for (const model of config.geminiTtsModels) {
    const res = await fetch(`${config.geminiBase}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `Lies den folgenden Text auf Deutsch vor – wie ein gut gelaunter, entspannter Kumpel Mitte dreißig: natürliches Tempo, warme Stimme, keine Übertreibung. Nur den Text sprechen.\n\n${clean}` }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
      }),
    });
    if (!res.ok) {
      lastErr = Object.assign(new Error(`Gemini TTS ${res.status} (${model}): ${(await res.text()).slice(0, 200)}`), { status: res.status });
      continue; // nächstes Modell probieren (404 = Name veraltet, 429 = Limit, 503 = überlastet)
    }
    const json = await res.json();
    const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) { lastErr = new Error('Gemini TTS lieferte kein Audio'); continue; }
    const buf = Buffer.from(part.inlineData.data, 'base64');
    const mime = String(part.inlineData.mimeType || '');
    if (mime.includes('wav') || buf.subarray(0, 4).toString() === 'RIFF') return { data: buf, type: 'audio/wav' };
    const rate = Number(mime.match(/rate=(\d+)/)?.[1]) || 24000;
    return { data: pcmToWav(buf, rate), type: 'audio/wav' };
  }
  throw lastErr;
}
