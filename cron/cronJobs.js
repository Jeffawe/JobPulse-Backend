import cron from 'node-cron';
import { connectDB } from '../db/database.js';

// Runs every Sunday at midnight
cron.schedule('0 0 * * 0', async () => {
  console.log('[CRON] Running weekly cleanup for test users...');

  const db = await connectDB();

  const threeWeeksAgo = new Date();
  threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21);
  const threshold = threeWeeksAgo.toISOString(); // e.g., "2025-04-22T12:00:00.000Z"

  try {
    const result = await db.run(
      `
      DELETE FROM users
      WHERE email LIKE '%@testing.com'
      AND isTestUser = 1
      AND datetime(created_at) < datetime(?)
    `,
      threshold
    );

    console.log(`[CRON] Deleted ${result.changes || 0} old test users.`);
  } catch (error) {
    console.error('[CRON ERROR] Failed to delete old test users:', error);
  }
});
