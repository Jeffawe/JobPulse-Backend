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
    // Start a transaction to ensure both operations succeed or fail together
    await db.run('BEGIN TRANSACTION');

    // First, get the IDs of test users that will be deleted
    const testUsersToDelete = await db.all(
      `SELECT id FROM users 
       WHERE email LIKE '%@testing.com' 
       AND isTestUser = 1 
       AND datetime(created_at) < datetime(?)`,
      threshold
    );

    const userIds = testUsersToDelete.map(user => user.id);
    const emails = testUsersToDelete.map(user => user.email);

    // If there are users to delete, remove their application tracking data
    let appTrackingDeleted = 0;
    let testUserLimitsDeleted = 0;

    if (userIds.length > 0) {
      const userIdsStr = userIds.join(',');

      // Delete application tracking records
      const appTrackingResult = await db.run(
        `DELETE FROM application_tracking WHERE user_id IN (${userIdsStr})`
      );
      appTrackingDeleted = appTrackingResult.changes || 0;

      // Delete test_user_limits records by email
      if (emails.length > 0) {
        const emailPlaceholders = emails.map(() => '?').join(',');
        const testLimitsResult = await db.run(
          `DELETE FROM test_user_limits WHERE email IN (${emailPlaceholders})`,
          emails
        );
        testUserLimitsDeleted = testLimitsResult.changes || 0;
      }
    }

    // Delete the test users
    const userResult = await db.run(
      `DELETE FROM users
       WHERE email LIKE '%@testing.com'
       AND isTestUser = 1
       AND datetime(created_at) < datetime(?)`,
      threshold
    );

    await db.run('COMMIT');

    console.log(`[CRON] Deleted ${userResult.changes || 0} old test users, ${appTrackingDeleted} application tracking records, and ${testUserLimitsDeleted} test user limit records.`);
  } catch (error) {
    await db.run('ROLLBACK');
    console.error('[CRON ERROR] Failed during test user cleanup:', error);
  } finally {
    await db.close();
  }
});