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

export async function synthesize(text, voice = 'Puck', signal) {
  if (!config.geminiKey) throw Object.assign(new Error('Kein Gemini-Schlüssel'), { status: 503 });
  const clean = String(text).slice(0, 1500);
  const voiceName = GEMINI_VOICES.some((v) => v.id === voice) ? voice : 'Puck';
  let lastErr;
  for (const model of config.geminiTtsModels) {
    const res = await fetch(`${config.geminiBase}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `Sprich locker, freundlich und natürlich auf Deutsch:\n${clean}` }] }],
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
    if (mime.includes('wav') || buf.subarray(0, 4).toString() === 'RIFF') return buf;
    const rate = Number(mime.match(/rate=(\d+)/)?.[1]) || 24000;
    return pcmToWav(buf, rate);
  }
  throw lastErr;
}
