// Warteschlange für Nachrichten ohne Netz (Text und Sprachaufnahmen), gespeichert in IndexedDB.
// Bleibt auch erhalten, wenn die App geschlossen wird – und wird gesendet, sobald wieder Netz da ist.
const DB = 'vio-outbox', STORE = 'items';
function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const res = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(res?.result ?? res);
    t.onerror = () => reject(t.error);
  });
}
export const add = (item) => tx('readwrite', (s) => s.put({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, created: Date.now(), ...item }));
export const all = async () => (await tx('readonly', (s) => s.getAll())).sort((a, b) => a.created - b.created);
export const remove = (id) => tx('readwrite', (s) => s.delete(id));
export const count = async () => (await all()).length;
