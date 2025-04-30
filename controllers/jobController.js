import { addToEmailUpdates } from '../memoryStore.js';
import { NLPProcessor } from '../nlpProcessor.js';
import { getOAuth2Client } from '../services/googleClient.js';
import { createClient } from '@supabase/supabase-js';
import { connectDB } from '../db/database.js';
import { google } from 'googleapis';
import { createGmailFilter } from './authController.js';
import { cacheUtils, CACHE_DURATIONS } from '../config/cacheConfig.js';

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
    const { userId } = req;
    let storageLoc = 'discord';

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await connectDB();

    // Get user info
    const user = await db.get('SELECT email, discord_webhook, label_id FROM users WHERE id = ?', [userId]);

    if (!user.label_id) {
      return res.status(400).json({ error: 'No Gmail label configured for this user.' });
    }

    // Get OAuth2 client
    const oauth2Client = await getOAuth2Client(userId);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    let filterExists = await checkFilterExists();

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
    const jobEmails = [];

    console.log(`Found ${messages.length} emails in the last ${pollIntervalMinutes} minutes`);

    // Process each email
    for (const message of messages) {
      const emailData = await gmail.users.messages.get({
        userId: 'me',
        id: message.id,
        format: 'full'
      });

      // Process email with NLP to check if it's a job email
      const { subject, from, body, date } = extractEmailFields(emailData.data);

      const processedEmail = NLPProcessor({ subject, from, body, date });

      if (processedEmail.isJobEmail) {
        jobEmails.push(processedEmail);

        // Add to shared queue for frontend updates
        addToEmailUpdates(processedEmail);

        // Send to appropriate notification channel
        if (user.discord_webhook) {
          await sendToDiscord(user.discord_webhook, processedEmail);
        } else {
          storageLoc = 'supabase';
          await saveToSupabase(userId, processedEmail);
        }
      }
    }

    return res.status(200).json({ success: true, count: jobEmails.length, storage: storageLoc });
  } catch (error) {
    console.error('Error polling emails:', error);
    return res.status(500).json({ error: 'Failed to poll emails' });
  }
};

export const checkFilterExists = async () => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await connectDB();
    const oauth2Client = await getOAuth2Client(userId);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const labelsRes = await gmail.users.labels.list({ userId: 'me' });
    const existingLabelIds = labelsRes.data.labels.map(label => label.id);

    if (!existingLabelIds.includes(user.label_id)) {
      // Label was deleted manually — reset label_id in DB/cache
      await db.run(`UPDATE users SET label_id = NULL WHERE id = ?`, [userId]);
      await cacheUtils.deleteCache(`userbasic:${userId}`);

      return false;
    }

    return true;
  } catch (error) {
    console.error('Error checking filter:', error);
  }
}

export const migrateOldMessages = async (req, res) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await connectDB();

    const user = await db.get(`SELECT email, label_id FROM users WHERE id = ?`, [userId]);

    if (!user?.label_id) {
      return res.status(400).json({ error: 'No label configured for this user.' });
    }

    const oauth2Client = await getOAuth2Client(userId);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const oldMatches = await gmail.users.messages.list({
      userId: 'me',
      q: 'subject:(interview OR job OR opportunity)',
      maxResults: 100,
    });

    const matchedMessages = oldMatches.data.messages || [];

    for (const msg of matchedMessages) {
      await gmail.users.messages.modify({
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
    console.error('Error migrating messages:', error);
    return res.status(500).json({ error: 'Failed to migrate old messages' });
  }
};


// Function to send email updates to Discord webhook
export const sendToDiscord = async (webhookUrl, emailData) => {
  try {
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

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Discord webhook failed: ${response.status}`);
    }
  } catch (error) {
    console.error('Error sending to Discord:', error);
    throw error;
  }
};


export const saveToSupabase = async (userId, emailData) => {
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
      throw error;
    }

    return data;
  } catch (error) {
    console.error('Error saving to Supabase:', error);
    throw error;
  }
};
