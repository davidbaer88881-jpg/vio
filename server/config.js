// Zentrale Konfiguration – alle Geheimnisse kommen ausschließlich aus Umgebungsvariablen.
// Nichts davon wird jemals an das Frontend ausgeliefert.

export const config = {
  port: Number(process.env.PORT) || 3000,
  dbPath: process.env.VIO_DB_PATH || './data/vio.db',

  // KI-Gehirn 1: Google Gemini (kostenloser Zugang über aistudio.google.com)
  geminiKey: process.env.GEMINI_API_KEY || '',
  geminiBase: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, ''),
  geminiModel: process.env.VIO_GEMINI_MODEL || 'gemini-flash-latest',
  // Ausweich-Modelle, falls das Hauptmodell überlastet ist oder das Gratis-Limit erreicht hat
  geminiFallbacks: (process.env.VIO_GEMINI_FALLBACKS ?? 'gemini-flash-lite-latest').split(',').map((s) => s.trim()).filter(Boolean),
  geminiTtsModels: (process.env.VIO_GEMINI_TTS_MODELS ?? 'gemini-3.8-flash-tts,gemini-3.8-flash-lite-tts,gemini-3.1-flash-tts-preview,gemini-2.5-flash-preview-tts')
    .split(',').map((s) => s.trim()).filter(Boolean),
  retryDelayMs: Number(process.env.VIO_RETRY_DELAY_MS ?? 1500),

  // KI-Gehirn 2: Claude (kostenpflichtig, Guthaben auf console.anthropic.com)
  apiKey: process.env.ANTHROPIC_API_KEY || '',
  apiBase: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
  model: process.env.VIO_MODEL || 'claude-sonnet-5-5',

  maxTokens: Number(process.env.VIO_MAX_TOKENS) || 1500,

  // Optionale Datenbank-Sicherung in Supabase Storage (für Gratis-Server ohne festen Speicher)
  supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
  supabaseKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  backupBucket: process.env.VIO_BACKUP_BUCKET || 'vio-backup',

  // Öffentliche Adresse (für Google-Login-Rückleitung und Telegram-Webhook), z. B. https://vio-xxxx.onrender.com
  // Render setzt RENDER_EXTERNAL_URL automatisch.
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, ''),

  // Google (Kalender + Gmail) – OAuth-Client aus der Google Cloud Console
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleApiBase: (process.env.GOOGLE_API_BASE || 'https://www.googleapis.com').replace(/\/$/, ''),
  googleTokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  googleAuthUrl: process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',

  // Telegram-Bot (von @BotFather)
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  // Telegram als eigenes Konto (my.telegram.org → API development tools)
  telegramApiId: process.env.TELEGRAM_API_ID || '',
  telegramApiHash: process.env.TELEGRAM_API_HASH || '',
  telegramApiBase: (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, ''),

  // Schlüssel zum Verschlüsseln gespeicherter Zugangsdaten (Google-Token) in der Datenbank
  encryptionSecret: process.env.VIO_ENCRYPTION_KEY || process.env.GOOGLE_CLIENT_SECRET || process.env.SUPABASE_SECRET_KEY || '',

  // Erstes Passwort (nur beim allerersten Start, wenn noch kein Benutzer existiert)
  initialPassword: process.env.VIO_INITIAL_PASSWORD || '',
  userName: process.env.VIO_USER_NAME || 'David',

  // Cookies nur über HTTPS – für lokale Entwicklung abschaltbar
  secureCookies: process.env.VIO_INSECURE_COOKIES !== '1',
  sessionDays: 30,

  timezone: 'Europe/Berlin',
};

export const availableProviders = () => [
  ...(config.geminiKey ? ['gemini'] : []),
  ...(config.apiKey ? ['claude'] : []),
];
