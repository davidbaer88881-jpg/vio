// Sprachaufnahme → Text (für Aufnahmen, die ohne Netz gemacht und später hochgeladen werden).
// Nutzt Gemini mit Audio-Eingabe (läuft mit dem Gratis-Schlüssel).
import { config } from './config.js';

export async function transcribe(audio, mimeType = 'audio/wav') {
  if (!config.geminiKey) throw Object.assign(new Error('Kein Gemini-Schlüssel für die Spracherkennung.'), { status: 503 });
  const models = [config.geminiModel, ...config.geminiFallbacks.filter((m) => m !== config.geminiModel)];
  let lastErr;
  for (const model of models) {
    const res = await fetch(`${config.geminiBase}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { inlineData: { mimeType, data: Buffer.from(audio).toString('base64') } },
          { text: 'Schreibe wörtlich auf, was in dieser deutschen Sprachaufnahme gesagt wird. Gib NUR den gesprochenen Text zurück, ohne Anführungszeichen oder Kommentare. Wenn nichts Verständliches gesagt wird, gib exakt LEER zurück.' },
        ] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1000 },
      }),
    });
    if (!res.ok) { lastErr = Object.assign(new Error(`Spracherkennung fehlgeschlagen (${res.status})`), { status: res.status }); continue; }
    const json = await res.json();
    const text = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    return text === 'LEER' ? '' : text;
  }
  throw lastErr;
}
