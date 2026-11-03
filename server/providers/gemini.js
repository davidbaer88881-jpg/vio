import { config } from '../config.js';

// Wandelt die Werkzeug-Beschreibungen (JSON-Schema im Claude-Format) ins Gemini-Format um.
function toGeminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  let type = s.type;
  if (Array.isArray(type)) {
    if (type.includes('null')) out.nullable = true;
    type = type.find((t) => t !== 'null');
  }
  if (type) out.type = String(type).toUpperCase();
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum.map(String);
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  if (s.required) out.required = s.required;
  if (s.items) out.items = toGeminiSchema(s.items);
  return out;
}
export function toGeminiTools(tools) {
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.input_schema) })) }];
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('abgebrochen'), { name: 'AbortError' })); }, { once: true });
});

/**
 * Öffnet die Verbindung zu Gemini. Bei Überlastung (503) oder Gratis-Limit (429):
 * erst kurz warten und neu versuchen, dann auf ein Ausweich-Modell wechseln.
 * Das passiert, bevor Text gestreamt wird – der Nutzer sieht keine halben Antworten.
 */
async function openStream(body, signal) {
  const models = [config.geminiModel, ...config.geminiFallbacks.filter((m) => m !== config.geminiModel)];
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${config.geminiBase}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
        body,
      });
      if (res.ok) return res;
      lastErr = await toError(res, model);
      if (res.status === 404) break;                 // Modell gibt's nicht → nächstes Modell
      if (!RETRYABLE.has(res.status)) throw lastErr; // z. B. falscher Schlüssel → sofort melden
      if (res.status === 429) break;                 // Limit gilt pro Modell → gleich nächstes Modell
      if (attempt < 2) await sleep(config.retryDelayMs * (attempt + 1), signal);
    }
  }
  throw lastErr;
}

async function toError(res, model) {
  const body = await res.text().catch(() => '');
  let msg = body;
  try { msg = JSON.parse(body).error?.message || body; } catch {}
  const friendly = {
    429: 'Das Gratis-Limit von Gemini ist gerade erreicht. Warte eine Minute – oder morgen ist es wieder frei.',
    503: 'Gemini ist gerade überlastet (das passiert bei den Gratis-Modellen manchmal). Versuch es in ein paar Sekunden nochmal.',
    500: 'Bei Gemini ist gerade ein Fehler aufgetreten. Versuch es gleich nochmal.',
    404: `Das Modell „${model}“ gibt es nicht (mehr). Setze in Render VIO_GEMINI_MODEL auf ein aktuelles Flash-Modell.`,
    400: `Gemini hat die Anfrage abgelehnt: ${String(msg).slice(0, 200)}`,
    401: 'Der Gemini-Schlüssel ist ungültig. Prüfe GEMINI_API_KEY in Render.',
    403: 'Der Gemini-Schlüssel hat keine Berechtigung. Prüfe GEMINI_API_KEY in Render.',
  }[res.status];
  const err = new Error(friendly || `Gemini-Fehler ${res.status}: ${String(msg).slice(0, 200)}`);
  err.status = res.status;
  return err;
}

async function* streamGemini({ system, contents, tools, signal }) {
  const res = await openStream(JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents,
    tools: toGeminiTools(tools),
    generationConfig: { maxOutputTokens: config.maxTokens * 2 },
  }), signal);

  const parts = [];
  const decoder = new TextDecoder();
  let buf = '';
  let blocked = null;
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.promptFeedback?.blockReason) blocked = ev.promptFeedback.blockReason;
      for (const p of ev.candidates?.[0]?.content?.parts || []) {
        parts.push(p); // unverändert aufheben (inkl. thoughtSignature) – Gemini braucht sie im Verlauf
        if (typeof p.text === 'string' && !p.thought) yield { type: 'text', text: p.text };
      }
    }
  }
  if (blocked && !parts.length) throw new Error(`Gemini hat die Anfrage blockiert (${blocked}).`);
  yield { type: 'final', parts };
}

/** Kompletter Gesprächszug mit Werkzeug-Schleife (gleiche Schnittstelle wie claude.js). */
export async function run({ system, messages, tools, signal, onText, runTool, maxRounds = 6 }) {
  const contents = messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  for (let round = 0; round < maxRounds; round++) {
    let final;
    for await (const ev of streamGemini({ system, contents, tools, signal })) {
      if (ev.type === 'text') onText(ev.text);
      else final = ev;
    }
    if (!final.parts.length) return;
    contents.push({ role: 'model', parts: final.parts });
    const calls = final.parts.filter((p) => p.functionCall);
    if (!calls.length) return;
    contents.push({
      role: 'user',
      parts: calls.map(({ functionCall: fc }) => ({
        functionResponse: { ...(fc.id ? { id: fc.id } : {}), name: fc.name, response: { result: runTool(fc.name, fc.args || {}) } },
      })),
    });
  }
}
