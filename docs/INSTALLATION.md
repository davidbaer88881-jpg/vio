# Vio kostenlos auf dein Pixel 8 bringen – Schritt für Schritt

**Kostenloser Aufbau:**

| Teil | Dienst | Kosten |
|---|---|---|
| KI-Gehirn | Google Gemini (Gratis-Zugang) | 0 € |
| Server (HTTPS) | Render (Free-Plan) | 0 € |
| Datensicherung | Supabase Storage (Free-Plan) | 0 € |
| Code | GitHub (privates Repo) | 0 € |

Für keinen der Dienste wird eine Kreditkarte verlangt, solange du im Gratis-Rahmen bleibst. Prüfe das beim Anmelden selbst, Tarife können sich ändern.

**Was du wissen solltest:**
- **Gemini gratis:** Im Gratis-Zugang darf Google deine Gespräche zur Verbesserung seiner Produkte verwenden. Es gibt außerdem Limits pro Minute und Tag. Für den privaten Gebrauch reichen sie meist.
- **Render gratis:** Nach ca. 15 Minuten ohne Nutzung legt sich der Server schlafen. Die erste Anfrage danach dauert dann bis zu einer Minute, danach geht es wieder flott.
- **Supabase gratis:** Ein Projekt, das eine Woche lang gar nicht benutzt wird, wird pausiert. Du kannst es im Supabase-Dashboard mit einem Klick wieder aufwecken. Bei täglicher Nutzung passiert das nicht.

---

## 1. Gemini-Schlüssel holen (3 Min.)

1. Öffne **aistudio.google.com** und melde dich mit deinem Google-Konto an.
2. Klicke links auf **„Get API key“**, dann auf **„Create API key“**.
3. Kopiere den Schlüssel (`AIza…`) und bewahre ihn sicher auf. Gib ihn niemandem weiter.

## 2. Supabase für die Datensicherung (5 Min.)

1. Öffne **supabase.com**, klicke **„Start your project“** und melde dich mit GitHub an.
2. Klicke **New project**. Name: `vio`, Region: **Frankfurt (eu-central-1)**. Ein Datenbank-Passwort wird automatisch erzeugt, das brauchst du nicht.
3. Warte, bis das Projekt bereit ist.
4. Gehe auf **Project Settings → Data API** (oder **API**) und kopiere die **Project URL** (`https://xxxx.supabase.co`).
5. Gehe auf **Project Settings → API Keys** und kopiere unter **Secret keys** den Schlüssel `sb_secret_…`.
   ⚠️ Das ist ein Generalschlüssel für das Projekt. Er gehört nur auf den Server, nie in Chats oder in den Code.
   (Steht bei dir nur der ältere **service_role**-Schlüssel `eyJ…`, funktioniert der genauso.)

Den Speicher-Ordner (Bucket) legt Vio beim ersten Start selbst an.

## 3. Code auf GitHub (5 Min.)

1. Öffne **github.com → New repository**. Name: `vio`, **Private** auswählen und **Create** klicken.
2. Klicke **„uploading an existing file“**, ziehe den **Inhalt** des entpackten `vio`-Ordners hinein (nicht den Ordner selbst) und klicke **Commit changes**.
   Tipp: Auf dem Handy geht das schlecht, nimm dafür einen PC.

## 4. Auf Render starten (10 Min.)

1. Öffne **render.com** und klicke **Get Started → GitHub**.
2. Klicke **New + → Blueprint** und wähle dein `vio`-Repo. Render liest die Datei `render.yaml` und schlägt einen **Free**-Web-Service vor.
3. Render fragt nach diesen Werten:
   | Name | Wert |
   |---|---|
   | `GEMINI_API_KEY` | dein Schlüssel aus Schritt 1 |
   | `SUPABASE_URL` | Project URL aus Schritt 2 |
   | `SUPABASE_SECRET_KEY` | Secret key aus Schritt 2 |
   | `VIO_INITIAL_PASSWORD` | ein langes Passwort (min. 10 Zeichen), das ist dein Vio-Login |
4. Klicke **Apply** und warte, bis der Status **Live** ist. Das dauert ein paar Minuten.
5. Oben steht deine Adresse, z. B. `https://vio-xxxx.onrender.com`.
6. Zum Testen im Browser `https://DEINE-ADRESSE/api/health` öffnen. Erwartet wird: `{"ok":true,"setup":true,"ai":["gemini"],"backup":true}`.

Falls „Blueprint“ nicht angeboten wird: Wähle **New + → Web Service**, nimm das Repo, Runtime **Docker**, Instance Type **Free**, und trag die Variablen von oben unter **Environment** ein.

## 5. Auf dem Pixel 8 installieren (2 Min.)

1. Öffne **Chrome**. Andere Browser können Spracherkennung und Installation nicht zuverlässig.
2. Rufe `https://DEINE-ADRESSE` auf und melde dich an.
3. Tippe auf der Startseite auf **„Vio installieren“**. Alternativ: Chrome-Menü **⋮ → Zum Startbildschirm hinzufügen → Installieren**.
4. Vio liegt jetzt als App-Icon auf deinem Startbildschirm. Wenn du lange auf das Icon drückst, findest du den Shortcut **„Mit Vio sprechen“**.

## 6. Mikrofon und männliche Stimme

1. Beim ersten Tipp aufs Mikrofon fragt Android nach der Erlaubnis. Wähle **Bei Nutzung der App zulassen**.
2. Stimme laden: **Einstellungen → System → Sprachen → Text-in-Sprache-Ausgabe → Google-Sprachausgabe (Zahnrad) → Sprachdaten installieren → Deutsch (Deutschland)**. Wähle dort eine männliche Stimme aus.
3. In Vio: **Mehr → Einstellungen → Stimme**. Stimme auswählen und auf **Stimme testen** tippen.

## Später auf Claude umsteigen (optional)

Auf console.anthropic.com Guthaben aufladen und einen Schlüssel erstellen. In Render unter **Environment** `ANTHROPIC_API_KEY` hinzufügen. Danach kannst du in Vio unter **Einstellungen → KI-Gehirn** zwischen Gemini und Claude umschalten.

## Wenn etwas nicht klappt

- **„Gratis-Limit erreicht“:** Du hast die Gemini-Limits ausgeschöpft. Warte kurz oder versuch es am nächsten Tag wieder.
- **„Modell nicht gefunden“:** Google hat das Modell umbenannt. Such in AI Studio den aktuellen Namen eines **Flash**-Modells und setze ihn in Render als `VIO_GEMINI_MODEL`.
- **Server startet nicht, im Log steht „Sicherung konnte nicht geladen werden“:** Dein Supabase-Projekt ist pausiert oder der Schlüssel stimmt nicht. Weck das Projekt im Supabase-Dashboard auf. Vio startet absichtlich nicht, damit er deine Sicherung nicht mit einer leeren Datenbank überschreibt.
- **Passwort vergessen:** In Supabase unter **Storage → vio-backup** die Datei `vio.db` löschen. Dabei gehen auch alle gespeicherten Daten verloren. Dann in Render `VIO_INITIAL_PASSWORD` neu setzen und **Manual Deploy** klicken.

## Sicherheit in Kürze

- Alle Schlüssel liegen nur als Umgebungsvariablen auf dem Server, nie im Frontend. Das prüft ein automatischer Test.
- Dein Passwort wird verschlüsselt (scrypt) gespeichert. Das Sitzungs-Cookie ist HttpOnly, Secure und SameSite=Strict. Nach 5 Fehlversuchen ist der Login 15 Minuten gesperrt.
- Die Sicherung liegt in einem privaten Bucket und ist nur mit dem Secret Key erreichbar.
- Die Budget-Obergrenze lässt sich nur mit deinem Passwort ändern. Zahlungen, Überweisungen, Online-Käufe, Abos und Verträge sind im Code gesperrt, egal welches KI-Gehirn aktiv ist.
