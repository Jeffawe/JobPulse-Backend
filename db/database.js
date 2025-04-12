import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';
import path from 'path';

const dbPath = './db/database.sqlite';

export const initDB = async () => {
  ensureDBFolderExists();

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
    filename: dbPath,
    driver: sqlite3.Database
  });
};

const ensureDBFolderExists = () => {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}