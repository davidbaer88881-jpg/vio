// Kleine API-Hülle. Der API-Schlüssel liegt NUR auf dem Server – hier gibt es keine Geheimnisse.
export class AuthError extends Error {}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Vio': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== '/api/auth/login' && !path.startsWith('/api/settings/')) throw new AuthError();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

/** Streamt eine Chat-Antwort (Server-Sent Events über fetch). */
export async function streamChat({ text, conversationId, signal, onEvent }) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-Vio': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, conversation_id: conversationId || null }),
    signal,
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok || !res.body) throw new Error(`Fehler ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      if (ev && data) onEvent(ev, JSON.parse(data));
    }
  }
}
