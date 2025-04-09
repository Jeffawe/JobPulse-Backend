import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const initDB = async () => {
  const db = await connectDB();

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      refresh_token TEXT NOT NULL,
      discord_webhook TEXT NOT NULL,
      notification_channel TEXT,
      notification_value TEXT,
      gmail_watch_label TEXT,
      gmail_history_id TEXT,
      gmail_watch_expiration TEXT
    );
  `);

  return db;
};

export const connectDB = async () => {
    return open({
      filename: './db/database.sqlite',
      driver: sqlite3.Database
    });
  };