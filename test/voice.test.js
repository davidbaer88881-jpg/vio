// v0.7: ElevenLabs zuerst, bei Fehler Gemini; gleiche Sätze aus dem Zwischenspeicher.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let mock, hits = { eleven: 0, gemini: 0 }, failEleven = false, tts;
before(async () => {
  mock = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    if (req.url.startsWith('/v1/text-to-speech/')) {
      hits.eleven++;
      assert.equal(req.headers['xi-api-key'], 'el-key');
      const b = JSON.parse(raw);
      assert.equal(b.language_code, 'de');
      if (failEleven) { res.writeHead(401); return res.end('quota'); }
      res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(Buffer.from('ID3-mp3-daten'));
    }
    hits.gemini++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: Buffer.alloc(480).toString('base64') } }] } }] }));
  });
  await new Promise((r) => mock.listen(0, r));
  const mb = `http://127.0.0.1:${mock.address().port}`;
  Object.assign(process.env, { ELEVENLABS_API_KEY: 'el-key', ELEVENLABS_BASE_URL: mb, GEMINI_API_KEY: 'g', GEMINI_BASE_URL: mb, VIO_GEMINI_TTS_MODELS: 'tts' });
  tts = await import('../server/tts.js');
});
after(() => mock.close());

test('ElevenLabs ist die erste Wahl und liefert MP3', async () => {
  assert.equal(tts.ttsProvider(), 'elevenlabs');
  const a = await tts.synthesize('Hallo David', 'Puck');
  assert.equal(a.type, 'audio/mpeg');
  assert.equal(hits.eleven, 1);
});

test('Gleicher Satz nochmal → aus dem Zwischenspeicher, keine neue Anfrage', async () => {
  await tts.synthesize('Hallo David', 'Puck');
  assert.equal(hits.eleven, 1);
});

test('ElevenLabs fällt aus (z. B. Guthaben leer) → automatisch Gemini-Stimme', async () => {
  failEleven = true;
  const a = await tts.synthesize('Neuer Satz', 'Puck');
  assert.equal(a.type, 'audio/wav');
  assert.equal(a.data.subarray(0, 4).toString(), 'RIFF');
  assert.equal(hits.gemini, 1);
});
