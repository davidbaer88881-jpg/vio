// Datensicherung in Supabase Storage (kostenlos).
// Gratis-Server wie Render Free haben keinen festen Speicher: Nach Neustart oder Ruhephase wäre
// die Datenbank leer. Deshalb lädt Vio beim Start die letzte Sicherung herunter und lädt nach jeder
// Änderung (gebündelt, nach wenigen Sekunden) eine frische Kopie hoch.
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from './config.js';

const OBJECT = 'vio.db';
export const backupEnabled = () => !!(config.supabaseUrl && config.supabaseKey);

function headers(extra = {}) {
  const h = { apikey: config.supabaseKey, ...extra };
  if (config.supabaseKey.startsWith('eyJ')) h.Authorization = `Bearer ${config.supabaseKey}`; // alter service_role-JWT
  return h;
}

/** Beim Start: Bucket sicherstellen und letzte Sicherung wiederherstellen. */
export async function restoreBackup(dbPath = config.dbPath) {
  if (!backupEnabled()) return 'disabled';
  const base = `${config.supabaseUrl}/storage/v1`;
  await fetch(`${base}/bucket`, {
    method: 'POST', headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ id: config.backupBucket, name: config.backupBucket, public: false }),
  }).catch(() => {}); // existiert schon → egal

  const res = await fetch(`${base}/object/${config.backupBucket}/${OBJECT}`, { headers: headers() });
  if (res.status === 404 || res.status === 400) return 'none';
  if (!res.ok) throw new Error(`Sicherung konnte nicht geladen werden (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dbPath), { recursive: true });
  for (const ext of ['-wal', '-shm']) await rm(dbPath + ext, { force: true });
  await writeFile(dbPath, buf);
  return 'restored';
}

let timer = null;
let running = null;
let dirty = false;
let dbRef = null;

async function upload() {
  if (!dbRef) return;
  dirty = false;
  const snap = join(tmpdir(), `vio-snap-${process.pid}.db`);
  await rm(snap, { force: true });
  dbRef.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`); // konsistente Momentaufnahme
  const body = await readFile(snap);
  await rm(snap, { force: true });
  const res = await fetch(`${config.supabaseUrl}/storage/v1/object/${config.backupBucket}/${OBJECT}`, {
    method: 'POST', headers: headers({ 'content-type': 'application/octet-stream', 'x-upsert': 'true' }), body,
  });
  if (!res.ok) throw new Error(`Sicherung fehlgeschlagen (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

/** Nach einer Änderung aufrufen – sichert gebündelt nach ein paar Sekunden. */
export function scheduleBackup(db, delayMs = 4000) {
  if (!backupEnabled()) return;
  dbRef = db; dirty = true;
  clearTimeout(timer);
  timer = setTimeout(flushBackup, delayMs);
}

export async function flushBackup() {
  clearTimeout(timer); timer = null;
  if (!dirty || !backupEnabled()) return;
  if (running) { await running; if (!dirty) return; }
  running = upload().catch((e) => { dirty = true; console.error(e.message); }).finally(() => { running = null; });
  await running;
}
