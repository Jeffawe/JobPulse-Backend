import { addManyToEmailUpdates } from '../services/memoryStore.js';
import { NLPProcessor } from '../services/nlpProcessor.js';
import { getOAuth2Client } from '../services/googleClient.js';
import { createClient } from '@supabase/supabase-js';
import { connectDB } from '../db/database.js';
import { google } from 'googleapis';
import { createGmailFilter } from './authController.js';
import { cacheUtils, CACHE_DURATIONS } from '../config/cacheConfig.js';
import { getTestUserEmails } from '../services/testUserEmail.js';

const extractEmailFields = (email) => {
  const headers = email.payload.headers;

  const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

  const subject = getHeader('Subject');
  const from = getHeader('From');
  const date = getHeader('Date');

  let body = '';

  if (email.payload.parts) {
    // If multipart, find the plain/text part
    const part = email.payload.parts.find(p => p.mimeType === 'text/plain');
    if (part && part.body && part.body.data) {
      body = Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
  } else if (email.payload.body && email.payload.body.data) {
    // Singlepart email
    body = Buffer.from(email.payload.body.data, 'base64').toString('utf-8');
  }

  return { subject, from, body, date };
}

export const pollEmails = async (req, res) => {
  try {
    const { userId, testUser } = req;
    let storageLoc = 'discord';
    const jobEmails = [];

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (testUser) {
      const emails = await getTestUserEmails(userId);

      try {
        for (const email of emails) {
          const { subject, from, body, date } = extractEmailFields(email);
          const processedEmail = NLPProcessor({ subject, from, body, date });

          if (processedEmail.isJobEmail) {
            jobEmails.push(processedEmail);
          }
        }

        if (jobEmails.length > 0) {
          try {
            await db.run('BEGIN TRANSACTION');
            await addManyToEmailUpdates(jobEmails, userId, webhook, true);
            await db.run('COMMIT');
          } catch (error) {
            await db.run('ROLLBACK');
            console.error('Transaction failed during email processing:', error);
            throw error; // Re-throw to be caught by the outer catch block
          }
        }

        return res.status(200).json({ success: true, count: jobEmails.length, storage: storageLoc });
      } catch (error) {
        console.error('Error getting test user emails:', error);
      }
      return res.status(200).json({ success: true, emails });
    }

    const db = await connectDB();

    let user = await cacheUtils.getCache(`userbasic:${userId}`);

    if (!user) {
      user = await db.get(`SELECT id, email, name, notification_value, notification_channel, notification_status, email_addresses, label_id, isTestUser FROM users WHERE id = ?`, [userId]);
    }

    if (!user.label_id) {
      return res.status(400).json({ error: 'No Gmail label configured for this user.' });
    }

    let webhook = await cacheUtils.getCache(`discord_webhook:${userId}`);

    if (!webhook) {
      const activeuser = await db.get(
        `SELECT credentials_encrypted_data, credentials_iv, credentials_auth_tag FROM users WHERE id = ?`,
        [userId]
      );

      if (!activeuser) return res.status(401).json({ error: 'No Authorized User Found' });

      const { discord_webhook } = decryptMultipleFields(
        activeuser.credentials_encrypted_data,
        activeuser.credentials_iv,
        activeuser.credentials_auth_tag
      );

      webhook = discord_webhook;
      await cacheUtils.setCache(`discord_webhook:${userId}`, webhook, CACHE_DURATIONS.DISCORD_WEBHOOK);
    }

    // Get OAuth2 client
    const oauth2Client = await getOAuth2Client(userId);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    let filterExists = await checkFilterExists(userId, user.label_id);

    if (!filterExists) {
      const { success, labelId } = await createGmailFilter(oauth2Client);
      if (success && labelId) {
        await db.run(`UPDATE users SET label_id = ? WHERE id = ?`, [labelId, userId]);
      }
    }

    const pollIntervalMinutes = parseInt(process.env.EMAIL_POLL_INTERVAL_MINUTES || '60');

    // Get emails from the last interval period
    const intervalMilliseconds = pollIntervalMinutes * 60 * 1000;
    const timeAgo = new Date(Date.now() - intervalMilliseconds).getTime() / 1000;
    const query = `after:${Math.floor(timeAgo)}`;

    const { data } = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      labelIds: user.label_id,
      maxResults: 100
    });

    const messages = data.messages || [];

    console.log(`Found ${messages.length} emails in the last ${pollIntervalMinutes} minutes`);

    // Process each email
    const messagePromises = messages.map(msg =>
      gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full'
      })
    );

    const messageResponses = await Promise.all(messagePromises);

    for (const message of messageResponses) {
      const { subject, from, body, date } = extractEmailFields(message.data);
      const processedEmail = NLPProcessor({ subject, from, body, date });

      if (processedEmail.isJobEmail) {
        jobEmails.push(processedEmail);
      }
    }

    // Process all valid job emails in one go
    if (jobEmails.length > 0) {
      try {
        await db.run('BEGIN TRANSACTION');
        await addManyToEmailUpdates(jobEmails, userId, webhook);
        await db.run('COMMIT');
      } catch (error) {
        await db.run('ROLLBACK');
        console.error('Transaction failed during email processing:', error);
        throw error; // Re-throw to be caught by the outer catch block
      }
    }

    return res.status(200).json({ success: true, count: jobEmails.length, storage: storageLoc });
  } catch (error) {
    console.error('Error polling emails:', error);
    return res.status(500).json({ error: 'Failed to poll emails' });
  }
};

export const checkFilterExists = async (userId, labelId) => {
  try {
    if (!userId || !labelId) {
      return false;
    }

    const db = await connectDB();
    const oauth2Client = await getOAuth2Client(userId);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const labelsRes = await gmail.users.labels.list({ userId: 'me' });
    const existingLabelIds = labelsRes.data.labels.map(label => label.id);

    if (!existingLabelIds.includes(labelId)) {
      // Label was deleted manually — reset label_id in DB/cache
      await db.run(`UPDATE users SET label_id = NULL WHERE id = ?`, [userId]);
      await cacheUtils.deleteCache(`userbasic:${userId}`);

      return false;
    }

    return true;
  } catch (error) {
    console.error('Error checking filter:', error);
    return false;
  }
};

export const migrateOldMessages = async (req, res) => {
  try {
    const userId = req.userId;

    if (req.testUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await connectDB();

    await db.run('BEGIN TRANSACTION');

    try {
      const user = await db.get(`SELECT email, label_id, isTestUser FROM users WHERE id = ?`, [userId]);

      if (!user?.label_id) {
        await db.run('ROLLBACK');
        return res.status(400).json({ error: 'No label configured for this user.' });
      }

      const oauth2Client = await getOAuth2Client(userId);
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      // Validate the label still exists
      const filterExists = await checkFilterExists(userId, user.label_id);
      if (!filterExists) {
        await db.run('ROLLBACK');
        return res.status(400).json({ error: 'Label no longer exists. Please reconfigure your Gmail filter.' });
      }

      const oldMatches = await gmail.users.messages.list({
        userId: 'me',
        q: 'subject:(interview OR job OR opportunity)',
        maxResults: 100,
      });

      const matchedMessages = oldMatches.data.messages || [];

      await db.run('COMMIT');

      // Process messages (this doesn't need to be in the transaction)
      for (const msg of matchedMessages) {
        gmail.users.messages.modify({
          userId: 'me',
          id: msg.id,
          requestBody: {
            addLabelIds: [user.label_id],
            removeLabelIds: ['INBOX'], // optional: skip if you want to keep them in Inbox too
          },
        });
      }

      return res.status(200).json({ success: true, moved: matchedMessages.length });
    } catch (error) {
      await db.run('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error migrating messages:', error);
    return res.status(500).json({ error: 'Failed to migrate old messages' });
  }
};


// Function to send email updates to Discord webhook
export const sendToDiscord = async (webhookUrl, emailData) => {
  if (!webhookUrl || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
    console.error('Invalid Discord webhook URL');
    return { success: false, error: 'Invalid webhook URL' };
  }

  try {
    const urlWithWait = webhookUrl.includes('?')
      ? `${webhookUrl}&wait=true`
      : `${webhookUrl}?wait=true`;

    const payload = {
      content: null,
      embeds: [
        {
          title: `Job Update: ${emailData.subject || "No Subject"}`,
          description: emailData.snippet || "No snippet available.",
          color: 5814783,
          fields: [
            {
              name: "From",
              value: emailData.from || "Unknown",
              inline: true
            },
            {
              name: "Status",
              value: emailData.jobStatus || "New",
              inline: true
            },
            {
              name: "Date",
              value: emailData.date
                ? new Date(emailData.date).toLocaleString()
                : "Unknown Date",
              inline: true
            }
          ],
          footer: {
            text: "Job Application Tracker"
          }
        }
      ]
    };

    const response = await fetch(urlWithWait, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Discord webhook failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return { success: true, messageId: data.id };
  } catch (error) {
    console.error('Error sending to Discord:', error);
    return { success: false, error: error.message };
  }
};


export const saveToSupabase = async (userId, emailData) => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('Supabase credentials not configured');
    return false;
  }

  if (!userId || !emailData) {
    console.error('Missing required parameters for Supabase save');
    return false;
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY
    );

    const { data, error } = await supabase
      .from('job_updates')
      .insert([
        {
          user_id: userId,
          email_id: emailData.id,
          subject: emailData.subject || "No Subject",
          from: emailData.from || "Unknown",
          snippet: emailData.snippet || "No snippet available.",
          job_status: emailData.jobStatus || "New",
          date: emailData.date || new Date().toISOString(),
          full_content: emailData.body || "No content"
        }
      ]);

    if (error) {
      console.error('Error saving to Supabase:', error);
      return false
    }

    return data;
  } catch (error) {
    console.error('Error saving to Supabase:', error);
    return false
  }
};
