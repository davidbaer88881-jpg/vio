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

async function* streamGemini({ system, contents, tools, signal }) {
  const url = `${config.geminiBase}/v1beta/models/${encodeURIComponent(config.geminiModel)}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: toGeminiTools(tools),
      generationConfig: { maxOutputTokens: config.maxTokens * 2 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = body;
    try { msg = JSON.parse(body).error?.message || body; } catch {}
    const hint = res.status === 429 ? ' (Gratis-Limit erreicht – kurz warten oder morgen wieder)'
      : res.status === 404 ? ` (Modell „${config.geminiModel}“ nicht gefunden – setze VIO_GEMINI_MODEL auf ein aktuelles Flash-Modell aus aistudio.google.com)` : '';
    const err = new Error(`Gemini API ${res.status}${hint}: ${String(msg).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

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
