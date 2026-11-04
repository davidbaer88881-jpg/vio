# Vio – persönlicher KI-Assistent

PWA (installierbare Web-App) + sicheres Node-Backend. KI-Gehirn: Google Gemini (gratis) oder Claude – in den Einstellungen umschaltbar.
Version 0.1 = Phase 1–6 (Grundgerüst, Oberfläche, Claude-Anbindung, Datenbank, Sprache, Budget-Regeln).

## Architektur

```
Pixel 8 (Chrome / installierte PWA)
   │  HTTPS, Session-Cookie (HttpOnly, SameSite=Strict)
   ▼
Vio-Server (Node 22, keine externen Pakete)
   ├─ Login (scrypt-Passwort, Sitzungen, Brute-Force-Sperre, CSRF-Header)
   ├─ Chat → providers/gemini.js | providers/claude.js (Streaming, Werkzeuge)  ← Schlüssel NUR hier
   ├─ Werkzeuge: Aufgaben, Gedächtnis, check_paid_action
   ├─ policy.js: feste Budget-/Zahlungsregeln (Code, nicht Prompt)
   ├─ SQLite (eingebaut): Gespräche, Aufgaben, Gedächtnis, Einstellungen, Aktions-Protokoll
   └─ backup.js: Sicherung der Datenbank in Supabase Storage (für Gratis-Server)
```

| Ordner | Inhalt |
|---|---|
| `server/` | Backend: `index.js` (HTTP/API), `chat.js` (Gesprächsablauf), `providers/` (Gemini, Claude), `backup.js`, `tools.js`, `policy.js`, `persona.js`, `auth.js`, `db.js`, `connections.js` |
| `public/` | PWA: `index.html`, `app.js` (Ansichten), `voice.js` (Sprache), `api.js`, `sw.js`, Manifest, Icons |
| `test/` | Tests für Budget-Regeln + kompletter API-Ablauf mit simuliertem Claude |

## Lokal starten

```bash
GEMINI_API_KEY=AIza... VIO_INITIAL_PASSWORD=mein-langes-passwort npm run dev
# → http://localhost:3000
npm test   # 50 Tests
```

## Was funktioniert (v0.1) – und was nicht

**Echt implementiert:** Login, Startseite, Chat mit Streaming, Gesprächsverlauf + Suche, Mikrofon (deutsche Spracherkennung), Vorlesen (inkl. Unterbrechen, Freisprechmodus), Vio-Persönlichkeit, Gedächtnis mit Bestätigung, Aufgaben (auch automatisch aus Nachrichten), Einstellungen, passwortgeschützte Budget-Obergrenze, Budget-/Zahlungsregeln mit Protokoll, PWA-Installation.

**Noch nicht angebunden (nur als „Geplant“ angezeigt):** Google Kalender, Push-Benachrichtigungen, Telegram, Gmail, WhatsApp, SMS/Kontakte, Telefonie, Websuche/Preisvergleich. `check_paid_action` prüft die Regeln, führt aber noch nichts aus.

Details zur Inbetriebnahme: [`docs/INSTALLATION.md`](docs/INSTALLATION.md)
