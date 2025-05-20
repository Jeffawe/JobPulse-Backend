import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import os from 'os';

dotenv.config();

db_state = process.env.DB_STATE;
let dbPath;

if (db_state === 'local') {
  dbPath = '../db/database.sqlite';
} else {
  const homeDir = os.homedir(); // "/home/somua"
  dbPath = path.resolve(homeDir, 'sqldb/database.sqlite');
}

let dbInstance;

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
  if (!dbInstance) {
    dbInstance = await open({
      filename: path.resolve(dbPath),
      driver: sqlite3.Database,
    });
  }
  return dbInstance;
};

const ensureDBFolderExists = () => {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const initTestUserLimitsDB = async () => {
  ensureDBFolderExists();

  const db = await connectDB();

  await db.exec(`
    CREATE TABLE IF NOT EXISTS test_user_limits (
      ip_address TEXT PRIMARY KEY,
      count INTEGER DEFAULT 1,
      first_created_at TEXT DEFAULT (datetime('now')),
      last_created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
};

// New function to track and limit test user creation
export const canCreateTestUser = async (ipAddress) => {
  const db = await connectDB();

  try {
    // First, check system-wide limit
    const { count: totalTestUsers } = await db.get(
      'SELECT COUNT(*) as count FROM users WHERE isTestUser = 1'
    );

    const SYSTEM_LIMIT = 500; // Adjust as needed
    if (totalTestUsers >= SYSTEM_LIMIT) {
      return { allowed: false, reason: 'system_limit' };
    }

    // Then check IP-specific limit
    await db.run(`
      INSERT INTO test_user_limits (ip_address, count)
      VALUES (?, 1)
      ON CONFLICT(ip_address) DO UPDATE SET
        count = count + 1,
        last_created_at = datetime('now')
    `, [ipAddress]);

    const result = await db.get(
      'SELECT count, first_created_at FROM test_user_limits WHERE ip_address = ?',
      [ipAddress]
    );

    const IP_LIMIT = 5; // Adjust as needed
    const IP_DAILY_LIMIT = 2; // Adjust as needed

    // Check total limit per IP
    if (result.count > IP_LIMIT) {
      return { allowed: false, reason: 'ip_total_limit' };
    }

    // Check daily limit per IP
    const dayAgo = new Date();
    dayAgo.setDate(dayAgo.getDate() - 1);
    const dayAgoStr = dayAgo.toISOString();

    const { count: recentCount } = await db.get(
      `SELECT COUNT(*) as count FROM test_user_limits 
       WHERE ip_address = ? AND datetime(last_created_at) > datetime(?)`,
      [ipAddress, dayAgoStr]
    );

    if (recentCount > IP_DAILY_LIMIT) {
      return { allowed: false, reason: 'ip_daily_limit' };
    }

    return { allowed: true };
  } catch (error) {
    console.error('[ERROR] Failed to check test user limits:', error);
    // If there's an error, be conservative and disallow
    return { allowed: false, reason: 'error' };
  }
};