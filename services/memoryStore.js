import { Server } from 'socket.io';
import crypto from 'crypto';
import { sendToDiscord, saveToSupabase } from '../controllers/jobController.js';
import { connectDB } from '../db/database.js';
import { getTestUserEmails } from './testUserEmail.js';
import { cacheUtils } from '../config/cacheConfig.js';
import { decryptMultipleFields } from './encryption.js';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const possibleUpdates = [];
const BOT_URL = process.env.BOT_URL;

const emailUpdatesStore = {
  emailsById: new Map(),
  queue: [],
  connections: new Map(),
  io: null,
  // Add a timestamp for when the cache was last refreshed from permanent storage
  lastRefreshed: null
};

// Cache expiration time in milliseconds (e.g., 30 minutes)
const CACHE_EXPIRATION = 30 * 60 * 1000;

export const initializeSocketServer = (server) => {
  emailUpdatesStore.io = new Server(server);

  emailUpdatesStore.io.on('connection', (socket) => {
    socket.on('register', async (userId) => {
      emailUpdatesStore.connections.set(userId, socket);

      // Check if cache needs refreshing when a user connects
      await refreshCacheIfNeeded(userId);

      // Send cached data to the newly connected user
      const userEmails = getEmailsFromCache(userId);
      socket.emit('initialEmails', userEmails);

      socket.on('disconnect', () => {
        emailUpdatesStore.connections.delete(userId);
      });
    });
  });
};

function getEmailsFromCache(userId) {
  const latestEmailByFingerprint = new Map();

  for (let i = emailUpdatesStore.queue.length - 1; i >= 0; i--) {
    const email = emailUpdatesStore.queue[i];
    if (email.metadata?.userId === userId) {
      // Only process entries with both job_title and company_name
      if (email.job_title && email.company_name) {
        const fingerprint = generateFingerprint(email.job_title, email.company_name);

        // Only keep the latest email for each job application
        if (!latestEmailByFingerprint.has(fingerprint)) {
          latestEmailByFingerprint.set(fingerprint, email);
        }
      }
    }
  }

  return Array.from(latestEmailByFingerprint.values());
}

// Function to check if cache needs refreshing and do so if needed
async function refreshCacheIfNeeded(userId) {
  const now = Date.now();
  const needsRefresh = !emailUpdatesStore.lastRefreshed ||
    (now - emailUpdatesStore.lastRefreshed) > CACHE_EXPIRATION;

  if (needsRefresh) {
    let retries = 0;
    const MAX_RETRIES = 3;

    while (retries < MAX_RETRIES) {
      try {
        // Clear existing cache for this user
        clearUserCache(userId);

        let webhook = await cacheUtils.getCache(`discord_webhook:${userId}`)

        if (!webhook) {
          const db = await connectDB()
          const user = await db.get(
            `SELECT credentials_encrypted_data, credentials_iv, credentials_auth_tag, isTestUser FROM users WHERE id = ?`,
            [userId]
          );

          if (!user || user.isTestUser) {
            break;
          }

          const { discord_webhook } = decryptMultipleFields(
            user.credentials_encrypted_data,
            user.credentials_iv,
            user.credentials_auth_tag
          );

          webhook = discord_webhook
        }

        // Fetch fresh data from permanent storage
        const freshData = await GetDataFromBot(userId, user.isTestUser, webhook);

        if (!Array.isArray(freshData)) {
          throw new Error('GetDataFromBot did not return an array');
        }

        await addManyToEmailUpdates(freshData, userId, webhook, user.isTestUser);

        emailUpdatesStore.lastRefreshed = now;
        break; // Success, exit retry loop
      } catch (error) {
        retries++;
        console.error(`Failed to refresh cache from storage (attempt ${retries}):`, error);

        if (retries >= MAX_RETRIES) {
          console.error('Max retries reached for cache refresh');
        } else {
          // Wait before retrying (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retries)));
        }
      }
    }
  }
}

const GetDataFromBot = async (userId, isTestUser, webhookUrl) => {
  if (isTestUser) {
    return await getTestUserEmails(userId);
  }

  if (!webhookUrl) {
    return [];
  }

  try {
    // Fetch messages from the bot API (with today’s date for filtering)
    const today = new Date().toISOString().split('T')[0];

    const res = await fetch(`${BOT_URL}/discord/messages?date=${today}&page=1&limit=20`, {
      method: 'GET',
      headers: {
        'X-Discord-Webhook': webhookUrl,
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BOT_SECRET}`
      }
    });
    
    if (!res.ok) {
      const error = await res.text();
      console.error(`Failed to fetch from Discord endpoint: ${error}`);
      return [];
    }

    const data = await res.json();

    // Optional: map messages to match your internal format
    const formatted = data.messages.map(msg => {
      const embed = msg.embeds[0] || {};
      return {
        subject: embed.title?.replace('Job Update: ', '') || msg.content || 'No Subject',
        from: embed.fields?.find(f => f.name === 'From')?.value || 'Unknown',
        status: embed.fields?.find(f => f.name === 'Status')?.value || 'Unknown',
        date: embed.fields?.find(f => f.name === 'Date')?.value || msg.timestamp,
        body: embed.description || 'No snippet available.',
      };
    });

    return formatted;
  } catch (err) {
    console.error('Error fetching real user data from bot:', err);
    return [];
  }
};

// Clear cache for specific user
function clearUserCache(userId) {
  // Get IDs of emails to remove
  const userEmailIds = [];
  emailUpdatesStore.queue.forEach(email => {
    if (email.metadata?.userId === userId) {
      userEmailIds.push(email.id);
    }
  });

  // Remove from queue
  emailUpdatesStore.queue = emailUpdatesStore.queue.filter(
    email => email.metadata?.userId !== userId
  );

  // Remove from ID tracking
  userEmailIds.forEach(id => {
    emailUpdatesStore.emailsById.delete(id);
  });
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function generateFingerprint(jobTitle, companyName) {
  const base = `${jobTitle.toLowerCase().trim()}_${companyName.toLowerCase().trim()}`;
  return hashContent(base);
}

export const addManyToEmailUpdates = async (emails, userId, discord_webhook, isTestUser = false) => {
  const updatedEmails = [];
  const processedEmailIds = new Set();

  const BATCH_SIZE = 50;
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);

    for (const email of batch) {
      // Generate a hash to identify this email if no ID exists
      if (!email.id) {
        const emailHash = hashContent(email.body);
        email.id = `email-${emailHash.substring(0, 8)}`;
      }

      // Skip if we've already processed this email in this batch
      if (processedEmailIds.has(email.id)) continue;

      const added = await addToEmailUpdates(email, userId, discord_webhook, isTestUser);
      if (added) {
        updatedEmails.push(email);
        processedEmailIds.add(email.id);
      }
    }
  }

  // Send batch update to client socket if any were added
  if (updatedEmails.length > 0 && emailUpdatesStore.connections.has(userId)) {
    const socket = emailUpdatesStore.connections.get(userId);
    socket.emit('newEmails', updatedEmails);
  }

  // Process any updates to existing records in Discord
  if (possibleUpdates.length > 0) {
    try {
      await fetch(`${process.env.BOT_URL}/updateMessages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.BOT_SECRET}`
        },
        body: JSON.stringify(possibleUpdates)
      });
      // Clear the updates after processing
      possibleUpdates.length = 0;
    } catch (error) {
      console.error('Failed to update Discord messages:', error);
    }
  }

  return updatedEmails.length;
};

export const addToEmailUpdates = async (email, userId, discord_webhook, isTestUser = false) => {
  const {
    body,
    from,
    application_id,
    company_name,
    job_title,
    jobStatus,
    date
  } = email;

  // Generate identifiers first
  const emailHash = hashContent(body);
  const fingerprint = generateFingerprint(job_title, company_name);

  // Generate a consistent ID for this email if not provided
  const emailId = email.id || `email-${emailHash.substring(0, 8)}`;

  if (emailUpdatesStore.emailsById.has(emailId)) {
    return false;
  }

  if (isTestUser) {
    try {
      email.id = emailId;
      email.metadata = {
        receivedAt: new Date().toISOString(),
        source: 'new',
        storageLocation: 'storage',
        userId
      };

      // Update in-memory storage
      emailUpdatesStore.emailsById.set(emailId, email);

      // Only keep a reasonable number of items in the queue (e.g., latest 1000)
      const MAX_QUEUE_SIZE = 1000;
      if (emailUpdatesStore.queue.length >= MAX_QUEUE_SIZE) {
        const oldestEmail = emailUpdatesStore.queue.shift();
        // Remove from Map if it's not referenced elsewhere
        if (oldestEmail && oldestEmail.id) {
          emailUpdatesStore.emailsById.delete(oldestEmail.id);
        }
      }

      emailUpdatesStore.queue.push(email);
      return true
    }
    catch (error) {
      console.error('Failed to add email to memory store:', error);
      return false;
    }
  }

  const db = connectDB();
  if (!db) return false;

  try {
    // Use transaction for database consistency
    await db.run('BEGIN TRANSACTION');

    // Check if this exact email exists
    const existing = await db.get(
      `SELECT * FROM application_tracking WHERE hash = ?`,
      [emailHash]
    );

    if (existing) {
      await db.run('COMMIT');
      return false; // Email already exists
    }

    const possibleUpdate = await db.get(`
      SELECT * FROM application_tracking 
      WHERE (
        (application_id = ? AND company_name = ?) OR 
        (fingerprint = ? AND application_id = ?) OR 
        (job_title = ? AND company_name = ?)
      ) AND user_id = ?
    `, [application_id, company_name, fingerprint, application_id, job_title, company_name, userId]);

    let success = false;
    let discord_id = possibleUpdate?.discord_msg_id ?? null;

    if (possibleUpdate) {
      success = true;
    } else {
      // Handle external storage (Discord or Supabase)
      if (discord_webhook && discord_webhook !== "NULL") {
        const result = await sendToDiscord(discord_webhook, email);
        if (result.success) {
          success = true;
          discord_id = result.messageId;
        }

      } else {
        success = await saveToSupabase(userId, email);
      }
    }

    if (success) {
      // If this is an update to an existing application
      if (possibleUpdate) {
        possibleUpdates.push({
          discord_msg_id: possibleUpdate.discord_msg_id,
          discord_webhook: discord_webhook,
          newStatus: jobStatus,
          jobTitle: job_title,
          companyName: company_name,
          emailSnippet: body.slice(0, 300)
        });

        await db.run(`
          UPDATE application_tracking 
          SET current_status = ?, last_updated = ? 
          WHERE hash = ?
        `, [jobStatus, date, possibleUpdate.hash]);
      } else {
        // Insert the new email record
        await db.run(`
        INSERT INTO application_tracking 
        (hash, user_id, fingerprint, email_address, application_id, company_name, job_title, discord_msg_id, current_status, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
          emailHash,
          userId,
          fingerprint,
          from,
          application_id,
          company_name,
          job_title,
          discord_id,
          jobStatus,
          date
        ]);
      }

      // Add to memory cache with appropriate metadata
      email.id = emailId;
      email.metadata = {
        receivedAt: new Date().toISOString(),
        source: possibleUpdate ? 'update' : 'new',
        storageLocation: 'database',
        userId
      };

      // Update in-memory storage
      emailUpdatesStore.emailsById.set(emailId, email);

      // Only keep a reasonable number of items in the queue (e.g., latest 1000)
      const MAX_QUEUE_SIZE = 1000;
      if (emailUpdatesStore.queue.length >= MAX_QUEUE_SIZE) {
        const oldestEmail = emailUpdatesStore.queue.shift();
        // Remove from Map if it's not referenced elsewhere
        if (oldestEmail && oldestEmail.id) {
          emailUpdatesStore.emailsById.delete(oldestEmail.id);
        }
      }

      emailUpdatesStore.queue.push(email);

      await db.run('COMMIT');
      return true;
    } else {
      await db.run('ROLLBACK');
      return false;
    }
  } catch (error) {
    await db.run('ROLLBACK');
    console.error('Error in addToEmailUpdates:', error);
    return false;
  }
};


// API endpoint to get emails with optional refresh from permanent storage
export const getEmails = async (req, res) => {
  const { userId } = req;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { refresh } = req.query;

  if (refresh === 'true') {
    await refreshCacheIfNeeded(userId);
  }

  const emails = getEmailsFromCache(userId);
  res.json({ success: true, emails });
};