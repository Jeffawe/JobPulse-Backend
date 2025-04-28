import { google } from 'googleapis';
import { connectDB } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';
import { NLPProcessor } from '../nlpProcessor.js';
import { addToEmailUpdates } from '../memoryStore.js';
import { sendToDiscord, saveToSupabase } from './jobController.js';
import { getOAuth2Client } from '../services/googleClient.js';

// Setup Gmail push notifications for a user
export const setupGmailPushNotifications = async (req, res) => {
  try {
    const { userId } = req;
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Get OAuth2 client for the user
    const oauth2Client = await getOAuth2Client(userId);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    
    // Create a Pub/Sub topic if you don't have one already
    // Note: You must create this topic in Google Cloud Console first
    const topicName = `projects/${process.env.GOOGLE_CLOUD_PROJECT_ID}/topics/${process.env.PUBSUB_TOPIC_NAME}`;
    
    // Generate a unique label for this watch request
    const labelId = `mail-watch-${uuidv4()}`;

    const db = await connectDB();
    
    // Store the label in your user record for later use
    await db.run('UPDATE users SET gmail_watch_label = ? WHERE id = ?', [labelId, userId]);
    
    // Set up the watch request
    const response = gmail.users.watch({
        userId: 'me',
        requestBody: {
            topicName,
            labelIds: ['INBOX'], // You can filter by label if needed
            labelFilterAction: 'include',
            labelFilterBehavior: 'exactMatch',
            userId: 'me'
        }
    });
    
    // Store the watch expiration and historyId for the user
    const { historyId, expiration } = response.data;
    await db.run(
      'UPDATE users SET gmail_history_id = ?, gmail_watch_expiration = ? WHERE id = ?',
      [historyId, expiration, userId]
    );
    
    return res.status(200).json({ 
      success: true, 
      message: 'Gmail push notifications set up successfully',
      expiration: new Date(parseInt(expiration)).toISOString()
    });
  } catch (error) {
    console.error('Error setting up Gmail push notifications:', error);
    return res.status(500).json({ error: 'Failed to set up Gmail push notifications' });
  }
};

// Handle push notifications from Gmail via Pub/Sub
export const handleGmailPushNotification = async (req, res) => {
  try {
    // Pub/Sub notifications come as base64-encoded messages
    const message = req.body.message;
    
    if (!message || !message.data) {
      return res.status(400).json({ error: 'Invalid Pub/Sub message format' });
    }
    
    // Decode the message data
    const data = JSON.parse(Buffer.from(message.data, 'base64').toString());
    
    // Extract the email address and historyId
    const { emailAddress, historyId } = data;
    
    const db = await connectDB();

    // Find the user with this email
    const user = await db.get('SELECT id, gmail_history_id, discord_webhook FROM users WHERE email = ?', [emailAddress]);
    
    if (!user) {
      console.log(`No user found for email: ${emailAddress}`);
      return res.status(200).end(); // Acknowledge the message even if user not found
    }
    
    // Get the last processed historyId for this user
    const lastHistoryId = user.gmail_history_id;
    
    // Fetch email changes since last historyId
    const oauth2Client = await getOAuth2Client(user.id);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    
    const { data: historyData } = await gmail.users.history.list({
      userId: 'me',
      startHistoryId: lastHistoryId,
      historyTypes: ['messageAdded']
    });
    
    // Process each new message
    if (historyData.history && historyData.history.length > 0) {
      for (const history of historyData.history) {
        if (history.messagesAdded) {
          for (const messageAdded of history.messagesAdded) {
            const { id } = messageAdded.message;
            
            // Get the full message
            const { data: messageData } = await gmail.users.messages.get({
              userId: 'me',
              id: id,
              format: 'full'
            });
            
            // Process the email through your NLP system
            const processedEmail = await NLPProcessor(messageData);
            
            if (processedEmail.isJobEmail) {
              // Add to shared queue for frontend updates
              addToEmailUpdates(processedEmail);
              
              // Send to appropriate notification channel
              if (user.discord_webhook) {
                await sendToDiscord(user.discord_webhook, processedEmail);
              } else {
                await saveToSupabase(user.id, processedEmail);
              }
            }
          }
        }
      }
    }
    
    // Update the last processed historyId for this user
    await db.run('UPDATE users SET gmail_history_id = ? WHERE id = ?', [historyId, user.id]);
    
    return res.status(200).end(); // Acknowledge the Pub/Sub message
  } catch (error) {
    console.error('Error handling Gmail push notification:', error);
    return res.status(200).end(); // Still acknowledge the message to prevent redelivery
  }
};

// Function to refresh watch notifications (needs to be called before they expire, typically every 7 days)
export const refreshGmailWatch = async (userId) => {
  try {
    const db = await connectDB();
    
    // Get user watch expiration
    const user = await db.get('SELECT gmail_watch_expiration FROM users WHERE id = ?', [userId]);
    
    if (!user || !user.gmail_watch_expiration) {
      return false;
    }
    
    const expiration = parseInt(user.gmail_watch_expiration);
    const now = Date.now();
    
    // Check if expiration is coming up soon (within 24 hours)
    if (expiration - now < 24 * 60 * 60 * 1000) {
      // Re-establish the watch
      const oauth2Client = await getOAuth2Client(userId);
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      
      const topicName = `projects/${process.env.GOOGLE_CLOUD_PROJECT_ID}/topics/${process.env.PUBSUB_TOPIC_NAME}`;
      
      const response = await gmail.users.watch({
        userId: 'me',
        requestBody: {
          topicName,
          labelIds: ['INBOX'],
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
      
      return true;
    }
    
    return false; // No refresh needed
  } catch (error) {
    console.error(`Error refreshing Gmail watch for user ${userId}:`, error);
    return false;
  }
};