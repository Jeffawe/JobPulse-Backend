import { google } from 'googleapis';
import { connectDB } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';
import { NLPProcessor } from '../services/nlpProcessor.js';
import { addManyToEmailUpdates } from '../services/memoryStore.js';
import { getOAuth2Client } from '../services/googleClient.js';
import { cacheUtils } from '../config/cacheConfig.js';
import { encryptMultipleFields, decryptMultipleFields } from '../services/encryption.js';

// Setup Gmail push notifications for a user
export const setupGmailPushNotifications = async (req, res) => {
  try {
    const { userId } = req;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await connectDB();

    // Fix variable declaration issues
    let user = await cacheUtils.getCache(`userbasic:${userId}`);

    if (!user) {
      user = await db.get('SELECT id, label_id FROM users WHERE id = ?', [userId]);

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
    }

    if (!user.label_id) {
      return res.status(400).json({ error: 'No Gmail label configured for this user' });
    }

    // Get OAuth2 client for the user
    const oauth2Client = await getOAuth2Client(userId);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Validate environment variables
    if (!process.env.GOOGLE_CLOUD_PROJECT_ID || !process.env.PUBSUB_TOPIC_NAME) {
      return res.status(500).json({ error: 'Google Cloud configuration missing' });
    }


    // Create a Pub/Sub topic if you don't have one already
    // Note: You must create this topic in Google Cloud Console first
    const topicName = `projects/${process.env.GOOGLE_CLOUD_PROJECT_ID}/topics/${process.env.PUBSUB_TOPIC_NAME}`;

    // Generate a unique label for this watch request
    const labelId = `mail-watch-${uuidv4()}`;

    // Use transaction for database updates
    await db.run('BEGIN TRANSACTION');

    try {
      // Set up the watch request
      const response = gmail.users.watch({
        userId: 'me',
        requestBody: {
          topicName,
          labelIds: [user.label_id], // You can filter by label if needed
          labelFilterAction: 'include',
          labelFilterBehavior: 'exactMatch',
          userId: 'me'
        }
      });

      // Store the watch expiration and historyId for the user
      const { historyId, expiration } = response.data;
      await db.run(
        'UPDATE users SET gmail_history_id = ?, gmail_watch_label = ?, gmail_watch_expiration = ? WHERE id = ?',
        [historyId, labelId, expiration, userId]
      );

      await db.run('COMMIT');
      await cacheUtils.deleteCache(`userbasic:${userId}`);

      return res.status(200).json({
        success: true,
        message: 'Gmail push notifications set up successfully',
        expiration: new Date(parseInt(expiration)).toISOString()
      });
    } catch (error) {
      await db.run('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error setting up Gmail push notifications:', error);
    return res.status(500).json({ error: 'Failed to set up Gmail push notifications' });
  }
};

// Handle push notifications from Gmail via Pub/Sub
export const handleGmailPushNotification = async (req, res) => {
  try {
    const message = req.body.message;

    if (!message || !message.data) {
      return res.status(400).json({ error: 'Invalid Pub/Sub message format' });
    }

    // Safely parse message data
    let data;
    try {
      data = JSON.parse(Buffer.from(message.data, 'base64').toString());
    } catch (parseError) {
      console.error('Error parsing Pub/Sub message data:', parseError);
      return res.status(400).json({ error: 'Invalid message data format' });
    }

    const { emailAddress, historyId } = data;

    if (!emailAddress || !historyId) {
      console.error('Missing required fields in push notification data');
      return res.status(200).end(); // Acknowledge message to avoid retries
    }

    const db = await connectDB();

    // Start transaction
    await db.run('BEGIN TRANSACTION');

    try {
      const user = await db.get('SELECT id, gmail_history_id, discord_webhook, label_id FROM users WHERE email = ?', [emailAddress]);

      if (!user) {
        console.log(`No user found for email: ${emailAddress}`);
        await db.run('ROLLBACK');
        return res.status(200).end();
      }

      let webhook = cacheUtils.getCache(`discord_webhook:${user.id}`);

      if (!webhook) {
        const activeuser = await db.get(
          `SELECT credentials_encrypted_data, credentials_iv, credentials_auth_tag FROM users WHERE id = ?`,
          [user.id]
        );

        if (!activeuser) return null;

        const { discord_webhook } = decryptMultipleFields(
          activeuser.credentials_encrypted_data,
          activeuser.credentials_iv,
          activeuser.credentials_auth_tag
        );

        webhook = discord_webhook;
        cacheUtils.setCache(`discord_webhook:${user.id}`, webhook, CACHE_DURATIONS.DISCORD_WEBHOOK);
      }

      const oauth2Client = await getOAuth2Client(user.id);
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      const { data: historyData } = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: user.gmail_history_id,
        historyTypes: ['messageAdded'],
        labelId: user.label_id // Filter to only this label
      });

      const jobEmails = [];

      if (historyData.history?.length > 0) {
        for (const history of historyData.history) {
          for (const messageAdded of history.messagesAdded || []) {
            const { id } = messageAdded.message;

            const { data: messageData } = await gmail.users.messages.get({
              userId: 'me',
              id,
              format: 'full'
            });

            const processedEmail = NLPProcessor(messageData);

            if (processedEmail?.isJobEmail) {
              jobEmails.push(processedEmail);
            }
          }
        }
      }

      // Batch process valid job emails
      if (jobEmails.length > 0) {
        await addManyToEmailUpdates(jobEmails, user.id, webhook);
      }

      // Update last processed Gmail history ID
      await db.run('UPDATE users SET gmail_history_id = ? WHERE id = ?', [historyId, user.id]);

      await db.run('COMMIT');
      return res.status(200).end();
    } catch (error) {
      await db.run('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error handling Gmail push notification:', error);
    return res.status(200).end(); // still acknowledge to prevent retries
  }
};

// Function to refresh watch notifications (needs to be called before they expire, typically every 7 days)
export const refreshGmailWatch = async (userId) => {
  try {
    const db = await connectDB();

    // Start transaction
    await db.run('BEGIN TRANSACTION');

    try {
      // Get user watch expiration
      const user = await db.get('SELECT gmail_watch_expiration, label_id FROM users WHERE id = ?', [userId]);

      if (!user || !user.gmail_watch_expiration || !user.label_id) {
        await db.run('ROLLBACK');
        return false;
      }

      const expiration = parseInt(user.gmail_watch_expiration);
      const now = Date.now();

      // Check if expiration is coming up soon (within 24 hours)
      if (expiration - now < 24 * 60 * 60 * 1000) {
        // Re-establish the watch
        const oauth2Client = await getOAuth2Client(userId);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        if (!process.env.GOOGLE_CLOUD_PROJECT_ID || !process.env.PUBSUB_TOPIC_NAME) {
          console.error('Google Cloud configuration missing');
          await db.run('ROLLBACK');
          return false;
        }

        const topicName = `projects/${process.env.GOOGLE_CLOUD_PROJECT_ID}/topics/${process.env.PUBSUB_TOPIC_NAME}`;

        const response = gmail.users.watch({
          userId: 'me',
          requestBody: {
            topicName,
            labelIds: [user.label_id],
            labelFilterAction: 'include',
            labelFilterBehavior: 'exactMatch',
            userId: 'me'
          }
        });

        // Update expiration and historyId
        const { historyId, expiration: newExpiration } = response.data;
        await db.run(
          'UPDATE users SET gmail_history_id = ?, gmail_watch_expiration = ? WHERE id = ?',
          [historyId, newExpiration, userId]
        );

        await db.run('COMMIT');
        await cacheUtils.deleteCache(`userbasic:${userId}`);
        return true;
      }

      await db.run('COMMIT');
      return false; // No refresh needed
    } catch (error) {
      await db.run('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error(`Error refreshing Gmail watch for user ${userId}:`, error);
    return false;
  }
};