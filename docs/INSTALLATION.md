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

---

# Ab Version 0.3: Apps verbinden

Alles hier ist **optional** und **kostenlos**. Neue Werte trägst du in Render ein: Dienst **vio** → **Environment** → **Add Environment Variable** → **Save Changes**. Render startet Vio danach automatisch neu.

Trag zuerst einmal ein:

| Name | Wert |
|---|---|
| `PUBLIC_URL` | deine Vio-Adresse, z. B. `https://vio-i6j2.onrender.com` (ohne `/` am Ende) |

## A) Telegram verbinden (5 Min.) – für Erinnerungen aufs Handy

1. Öffne **Telegram** und suche nach **@BotFather** (blauer Haken).
2. Tippe auf **Starten** und schicke `/newbot`.
3. Name: `Vio`. Benutzername: z. B. `VioDavid_bot`. Er muss auf `bot` enden und darf noch nicht vergeben sein.
4. BotFather schickt dir einen **Token** (`123456789:AA…`). Das ist ein Passwort, schick ihn niemandem.
5. Trag ihn in Render als `TELEGRAM_BOT_TOKEN` ein und speichere.
6. Warte, bis Render wieder „Deployed“ zeigt. Dann in Vio: **Apps → Telegram verbinden**. Telegram öffnet sich, dort auf **Starten** tippen.
7. Zurück in Vio auf **Test-Nachricht** tippen. Sie sollte in Telegram ankommen.

**Gruppen:** Lade deinen Bot in eine Telegram-Gruppe ein, dann kann Vio dort auf deinen Wunsch Nachrichten posten. Vor dem Senden fragt er dich immer.

## B) Google Kalender & Gmail verbinden (15 Min., am besten am PC)

1. Öffne **console.cloud.google.com** und melde dich mit deinem Google-Konto an.
2. Klicke oben auf die Projektauswahl → **Neues Projekt** → Name `Vio` → **Erstellen**. Wähl das Projekt danach oben aus.
3. **APIs aktivieren:** Suche oben nach **„Google Calendar API“** → **Aktivieren**. Dasselbe für **„Gmail API“**.
4. **Zustimmungsbildschirm:** Suche nach **„Google Auth Platform“** (oder „OAuth-Zustimmungsbildschirm“) → **Jetzt starten**:
   - App-Name `Vio`, deine E-Mail als Support-Adresse
   - Zielgruppe: **Extern**
   - Kontakt-E-Mail: deine Adresse → **Erstellen**
5. **Zielgruppe (Audience):** Füge unter **Testnutzer** deine Gmail-Adresse hinzu.
6. **Clients:** **Client erstellen** → Typ **Webanwendung** → Name `Vio`.
   Unter **Autorisierte Weiterleitungs-URIs** trägst du ein: `https://vio-i6j2.onrender.com/api/google/callback` (mit deiner Adresse) → **Erstellen**.
7. Kopiere **Client-ID** und **Clientschlüssel** und trag sie in Render als `GOOGLE_CLIENT_ID` und `GOOGLE_CLIENT_SECRET` ein.
8. Warte, bis Render wieder „Deployed“ zeigt. Dann in Vio: **Apps → Mit Google verbinden**.
   Google warnt **„Google hat diese App nicht überprüft“**. Das ist normal, die App gehört ja dir. Tippe auf **Erweitert → Weiter zu Vio**, setze alle Haken und tippe auf **Weiter**.

**Wichtig:** Solange die App bei Google im **Testmodus** ist, läuft die Verbindung **nach 7 Tagen ab**. Dann musst du in Vio auf „Mit Google verbinden“ tippen. Damit sie dauerhaft hält: In der Google Auth Platform unter **Zielgruppe** auf **App veröffentlichen** tippen (Status „In Produktion“). Für deine eigene Nutzung ist keine Google-Prüfung nötig, die Warnung beim Verbinden bleibt aber. Lässt Google das Veröffentlichen nicht zu, bleib im Testmodus und verbinde einfach alle 7 Tage neu.

## C) Vio wach halten (für pünktliche Erinnerungen)

Der Gratis-Server schläft nach 15 Minuten ohne Besuch, und schlafend kann er keine Erinnerungen schicken. Abhilfe schafft ein kostenloser Weck-Dienst:

1. Öffne **cron-job.org** und erstelle ein kostenloses Konto.
2. Klicke **Create cronjob**. Titel: `Vio`, URL: `https://vio-i6j2.onrender.com/api/health`, Ausführung: **alle 10 Minuten** → **Create**.

Render Free hat 750 Stunden pro Monat. Das reicht genau für einen Dienst, der rund um die Uhr läuft.

## Was Vio jetzt kann

- **Natürliche Männerstimme:** Mehr → Einstellungen → Stimme → „Natürlich (Gemini)“ → Stimme wählen → **Stimme testen**. Ist das Gratis-Limit erreicht, springt automatisch die Handy-Stimme ein.
- **Kalender:** „Was steht morgen an?“, „Trag mir Freitag 15 Uhr Zahnarzt ein“. Vio warnt bei Überschneidungen.
- **Erinnerungen:** „Erinner mich um 18 Uhr ans Altglas“ oder „jeden Montag um 7 an den Müll“. Die Erinnerung kommt per Telegram.
- **Tagesübersicht:** jeden Morgen per Telegram, Uhrzeit unter Einstellungen → Erinnerungen.
- **Gmail:** „Hab ich neue Mails?“, „Fass mir die Mail von Amazon zusammen“, „Antworte Tom, dass Samstag passt“. Vio zeigt dir immer erst den Entwurf. Senden kann er technisch erst, nachdem du in einer neuen Nachricht zugestimmt hast.
- **Mit Vio in Telegram schreiben:** einfach dem Bot schreiben. Er antwortet nur dir, Fremde werden abgewiesen.
- **WhatsApp/SMS:** „Schreib Lisa, dass ich später komme“. Vio formuliert die Nachricht, und ein Knopf öffnet WhatsApp mit dem fertigen Text. Abschicken tust du selbst, weil es keine offizielle Schnittstelle für private Nummern gibt.
- **Telefon:** „Ich will bei der Werkstatt einen Termin ausmachen“. Vio schreibt einen Gesprächsleitfaden, und der Knopf öffnet dein Telefon. Dass Vio selbst anruft, geht nur über einen kostenpflichtigen Telefondienst.

## D) Telegram als dein Konto (Vio schreibt direkt in deinem Namen)

Damit sagst du nur „Schreib Josua auf Telegram, dass ich später komme“, und Vio schickt es sofort aus **deinem** Telegram-Konto ab.

**1. Zugangsdaten bei Telegram holen (am besten am PC):**
1. Öffne **my.telegram.org** und gib deine Telefonnummer ein (`+49…`).
2. Telegram schickt dir einen Code **in die Telegram-App** (nicht per SMS). Gib ihn ein.
3. Klicke auf **„API development tools“**.
4. Fülle das Formular aus: App title `Vio`, Short name `vioapp` (nur Buchstaben), Platform **Android**. Den Rest kannst du leer lassen. Dann **Create application**.
5. Du bekommst **App api_id** (eine Zahl) und **App api_hash** (lange Zeichenkette).
   Kommt nur „ERROR“: VPN/Werbeblocker ausschalten, einen anderen Browser nehmen oder es später nochmal versuchen. Das ist ein bekanntes Problem bei Telegram.

**2. In Render eintragen** (Dienst vio → Environment → Add variable):
| Name | Wert |
|---|---|
| `TELEGRAM_API_ID` | die Zahl |
| `TELEGRAM_API_HASH` | die Zeichenkette |
Dann **Save, rebuild, and deploy**. Diesmal dauert das Bauen etwas länger, weil Render die Telegram-Bibliothek installiert.

**3. In Vio anmelden:**
Öffne **Apps** und scrolle zu **„Telegram als du (dein Konto)“**. Gib deine Nummer ein, tippe auf **Code senden** und trag den Code aus der Telegram-App ein. Hast du eine zweistufige Bestätigung (Cloud-Passwort), gibst du danach dein Telegram-Passwort ein.

**Gut zu wissen:**
- Die Anmeldung ist wie ein weiteres Gerät. Du siehst sie in Telegram unter **Einstellungen → Geräte** und kannst sie dort jederzeit beenden.
- Sicherheitsgrenze: höchstens **20 Nachrichten pro Stunde**. Massennachrichten sind nicht möglich, weil Telegram Konten bei Spam sperrt.
- Gibt es mehrere Treffer (z. B. zwei „Lisa“), fragt Vio nach, statt zu raten.
- Die Sitzung liegt verschlüsselt in der Datenbank. Mit „Abmelden“ in Vio wird sie gelöscht und bei Telegram beendet.

## Ab Version 0.5: schneller, im Hintergrund, ohne Netz

- **Schneller:** Gemini antwortet ohne langes Vorab-„Nachdenken“. Mit der natürlichen Stimme spricht Vio den ersten Satz, sobald er fertig ist. Wer lieber gründlichere Antworten will, setzt in Render `VIO_GEMINI_THINKING` auf `low` oder `medium`.
- **App verlassen:** Vio arbeitet auf dem Server weiter und speichert die Antwort. Kommst du zurück, erscheint sie im Chat. Bist du dann noch weg, kommt sie per Telegram (abschaltbar unter Einstellungen → Erinnerungen).
- **Kein Netz:** Getippte Nachrichten und Sprachaufnahmen (Mikro-Knopf) werden auf dem Handy gespeichert, auch wenn du die App schließt. Sobald wieder Netz da ist, schickt Vio sie automatisch ab.
- **Größter Bremsklotz bleibt der Gratis-Server:** Nach 15 Minuten ohne Besuch schläft er, und die erste Antwort dauert dann bis zu einer Minute. Dagegen hilft der Weck-Dienst aus Abschnitt C (cron-job.org).
