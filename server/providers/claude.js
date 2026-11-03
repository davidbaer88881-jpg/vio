import { config } from '../config.js';

/**
 * Streamt eine Antwort der Claude Messages API.
 * Liefert Events: { type: 'text', text } … und am Ende { type: 'final', content, stop_reason }.
 */
export async function* streamClaude({ system, messages, tools, signal }) {
  const res = await fetch(`${config.apiBase}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: config.model, max_tokens: config.maxTokens, system, messages, tools, stream: true }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = body;
    try { msg = JSON.parse(body).error?.message || body; } catch {}
    const err = new Error(`Claude API ${res.status}: ${msg.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  const blocks = [];
  let stopReason = null;
  const decoder = new TextDecoder();
  let buf = '';

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      let ev;
      try { ev = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }

      switch (ev.type) {
        case 'content_block_start': {
          const b = ev.content_block;
          blocks[ev.index] = b.type === 'tool_use'
            ? { type: 'tool_use', id: b.id, name: b.name, _json: '' }
            : b.type === 'text' ? { type: 'text', text: '' } : { ...b };
          break;
        }
        case 'content_block_delta': {
          const b = blocks[ev.index];
          if (ev.delta.type === 'text_delta') { b.text += ev.delta.text; yield { type: 'text', text: ev.delta.text }; }
          else if (ev.delta.type === 'input_json_delta') b._json += ev.delta.partial_json;
          break;
        }
        case 'content_block_stop': {
          const b = blocks[ev.index];
          if (b?.type === 'tool_use') { try { b.input = b._json ? JSON.parse(b._json) : {}; } catch { b.input = {}; } delete b._json; }
          break;
        }
        case 'message_delta':
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          break;
        case 'error':
          throw new Error(`Claude API Stream-Fehler: ${ev.error?.message || 'unbekannt'}`);
      }
    }
  }

  // Leere Textblöcke entfernen (API akzeptiert sie im Verlauf nicht)
  const content = blocks.filter((b) => b && !(b.type === 'text' && !b.text));
  yield { type: 'final', content, stop_reason: stopReason };
}

/**
 * Kompletter Gesprächszug mit Werkzeug-Schleife (gleiche Schnittstelle wie gemini.js).
 * messages: [{ role: 'user'|'assistant', content: string }]
 */
export async function run({ system, messages, tools, signal, onText, runTool, maxRounds = 6 }) {
  const msgs = messages.map((m) => ({ role: m.role, content: m.content }));
  for (let round = 0; round < maxRounds; round++) {
    let final;
    for await (const ev of streamClaude({ system, messages: msgs, tools, signal })) {
      if (ev.type === 'text') onText(ev.text);
      else if (ev.type === 'final') final = ev;
    }
    msgs.push({ role: 'assistant', content: final.content });
    if (final.stop_reason !== 'tool_use') return;
    const results = [];
    for (const block of final.content.filter((b) => b.type === 'tool_use')) {
      results.push({ type: 'tool_result', tool_use_id: block.id, content: runTool(block.name, block.input || {}) });
    }
    msgs.push({ role: 'user', content: results });
  }
}
