// Zentrale Konfiguration – alle Geheimnisse kommen ausschließlich aus Umgebungsvariablen.
// Nichts davon wird jemals an das Frontend ausgeliefert.

export const config = {
  port: Number(process.env.PORT) || 3000,
  dbPath: process.env.VIO_DB_PATH || './data/vio.db',

  // KI-Gehirn 1: Google Gemini (kostenloser Zugang über aistudio.google.com)
  geminiKey: process.env.GEMINI_API_KEY || '',
  geminiBase: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, ''),
  geminiModel: process.env.VIO_GEMINI_MODEL || 'gemini-flash-latest',

  // KI-Gehirn 2: Claude (kostenpflichtig, Guthaben auf console.anthropic.com)
  apiKey: process.env.ANTHROPIC_API_KEY || '',
  apiBase: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
  model: process.env.VIO_MODEL || 'claude-sonnet-5-5',

  maxTokens: Number(process.env.VIO_MAX_TOKENS) || 1500,

  // Optionale Datenbank-Sicherung in Supabase Storage (für Gratis-Server ohne festen Speicher)
  supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
  supabaseKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  backupBucket: process.env.VIO_BACKUP_BUCKET || 'vio-backup',

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
