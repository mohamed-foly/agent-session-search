import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config';

export function openDb(): Database.Database {
  fs.mkdirSync(path.dirname(config.indexDbPath), { recursive: true });
  const db = new Database(config.indexDbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT NOT NULL,
      agent TEXT NOT NULL,
      cwd TEXT,
      file_path TEXT NOT NULL,
      display_path TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      ended_at TEXT,
      indexed_mtime_ms INTEGER NOT NULL,
      PRIMARY KEY (agent, id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      session_agent TEXT NOT NULL,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT,
      timestamp TEXT,
      text TEXT NOT NULL,
      PRIMARY KEY (session_agent, session_id, seq)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      content='messages',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;
  `);

  // Migration for indexes created before display_path existed.
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'display_path')) {
    db.exec("ALTER TABLE sessions ADD COLUMN display_path TEXT NOT NULL DEFAULT ''");
  }

  return db;
}
