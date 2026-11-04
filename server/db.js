import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

export const DEFAULT_SETTINGS = {
  user_name: config.userName,
  ai_provider: 'auto',      // 'auto' | 'gemini' | 'claude'
  memory_mode: 'ask',        // 'ask' = Vio fragt vor dem Merken, 'auto' = merkt selbst, 'off' = nie
  tts_mode: 'voice',        // 'voice' = vorlesen, wenn per Sprache gefragt; 'always'; 'never'
  voice_name: '',
  speech_rate: 1.0,
  speech_pitch: 0.85,
  handsfree: false,
  voice_engine: 'gemini',    // 'gemini' = natürliche Stimme vom Server, 'device' = Handy-Stimme
  gemini_voice: 'Puck',
  morning_briefing: '07:30', // Uhrzeit der Tagesübersicht per Telegram, '' = aus
  telegram_reminders: true,
  last_briefing: '',
  notify_background: true, // Antwort per Telegram, wenn du die App vorher verlassen hast
};

// Geschützte Einstellungen: nur mit Passwort änderbar, niemals per Chat.
export const DEFAULT_PROTECTED = {
  max_budget_eur: 50,         // absolute Obergrenze pro Auftrag, egal was im Chat steht
};

export function openDb(path = config.dbPath) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, user_agent TEXT);

    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS protected_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')), content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY, text TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'allgemein',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')));

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, notes TEXT, due_at TEXT,
      done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), done_at TEXT);

    CREATE TABLE IF NOT EXISTS integrations (name TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS telegram_chats (
      chat_id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));

    CREATE TABLE IF NOT EXISTS action_log (
      id INTEGER PRIMARY KEY, action_type TEXT NOT NULL, payload TEXT NOT NULL,
      decision TEXT NOT NULL, reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  // Spätere Erweiterungen (bestehende Datenbanken werden automatisch nachgerüstet)
  for (const sql of [
    "ALTER TABLE tasks ADD COLUMN repeat TEXT",         // daily | weekdays | weekly | monthly
    "ALTER TABLE tasks ADD COLUMN reminded_at TEXT",
  ]) { try { db.exec(sql); } catch {} }
  return db;
}

function readKv(db, table, defaults) {
  const out = { ...defaults };
  for (const row of db.prepare(`SELECT key, value FROM ${table}`).all()) {
    if (row.key in defaults) out[row.key] = JSON.parse(row.value);
  }
  return out;
}

export const getSettings = (db) => readKv(db, 'settings', DEFAULT_SETTINGS);
export const getProtected = (db) => readKv(db, 'protected_settings', DEFAULT_PROTECTED);

export function saveSettings(db, patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) stmt.run(k, JSON.stringify(v));
}

export function saveProtected(db, patch) {
  const stmt = db.prepare('INSERT INTO protected_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) stmt.run(k, JSON.stringify(v));
}
