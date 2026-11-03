// Setzt (oder ändert) das Vio-Passwort direkt auf dem Server.
// Aufruf:  npm run set-password -- "mein-sehr-langes-passwort"
import { openDb } from '../server/db.js';
import { setPassword } from '../server/auth.js';

const pw = process.argv[2] || '';
if (pw.length < 10) {
  console.error('Bitte ein Passwort mit mindestens 10 Zeichen angeben:  npm run set-password -- "dein-passwort"');
  process.exit(1);
}
setPassword(openDb(), pw);
console.log('Passwort gesetzt. Alle Geräte wurden abgemeldet.');
