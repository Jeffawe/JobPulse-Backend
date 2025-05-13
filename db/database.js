import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';
import path from 'path';

const dbPath = '../db/database.sqlite';

export const addColumns = async () => {
  const db = await connectDB();

  await db.exec(`ALTER TABLE users ADD COLUMN created_at TEXT DEFAULT (datetime('now'));`);
};

export const deleteDB = async () => {
  ensureDBFolderExists();

  const db = await connectDB();

  await db.exec(`DROP TABLE IF EXISTS users;`);
};

export const initDB = async () => {
  ensureDBFolderExists();

  const db = await connectDB();

  await db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    credentials_encrypted_data TEXT,
    credentials_iv TEXT,
    credentials_auth_tag TEXT,
    discord_webhook BOOLEAN DEFAULT false,
    notification_channel TEXT,
    notification_value TEXT,
    gmail_watch_label TEXT,
    gmail_history_id TEXT,
    gmail_watch_expiration TEXT,
    notification_status TEXT,
    email_addresses TEXT,
    discord_id TEXT,
    guild_id TEXT,
    label_id TEXT,
    isTestUser BOOLEAN DEFAULT false,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

  return db;
};

export const initApplicationDB = async () => {
  ensureDBFolderExists();

  const db = await connectDB();

  await db.exec(`
    CREATE TABLE IF NOT EXISTS application_tracking (
      hash TEXT PRIMARY KEY,               
      fingerprint TEXT,                    
      email_address TEXT,                          
      application_id TEXT,                 
      company_name TEXT,                   
      job_title TEXT,                      
      discord_msg_id TEXT,                 
      current_status TEXT,                    
      last_updated TEXT,
      user_id INTEGER               
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