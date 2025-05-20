import { Server } from 'socket.io';
import crypto from 'crypto';
import { sendToDiscord, saveToSupabase, pollEmailsCore } from '../controllers/jobController.js';
import { connectDB } from '../db/database.js';
import { getTestUserEmails } from './testUserEmail.js';
import { cacheUtils } from '../config/cacheConfig.js';
import { decryptMultipleFields } from './secrets/encryption.js';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { NLPProcessor } from './secrets/nlpProcessor.js';

dotenv.config();

let possibleUpdates = [];
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
    socket.on('register', async (userId, isTestUser) => {
      emailUpdatesStore.connections.set(userId, socket);

      // Check if cache needs refreshing when a user connects
      await refreshCacheIfNeeded(userId, isTestUser);

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
async function refreshCacheIfNeeded(userId, isTestUser = false) {
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

        if (!webhook && !isTestUser) {
          const db = await connectDB()
          const user = await db.get(
            `SELECT credentials_encrypted_data, credentials_iv, credentials_auth_tag, isTestUser FROM users WHERE id = ?`,
            [userId]
          );

          if (!user) {
            break;
          }

          if (user.isTestUser) {
            isTestUser = true
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
        const freshData = await GetDataFromBot(userId, isTestUser, webhook);

        if (!Array.isArray(freshData)) {
          throw new Error('GetDataFromBot did not return an array');
        }

        await addManyToEmailUpdates(freshData, userId, webhook, isTestUser);

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
    const rawEmails = await getTestUserEmails(userId);
    const structuredEmails = rawEmails.map(NLPProcessor);
    return structuredEmails;
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

    return formatted.map(email => NLPProcessor(email));
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
  if (typeof content !== 'string') {
    content = String(content ?? '');
  }
  return crypto.createHash('sha256').update(content).digest('hex');
}

function generateFingerprint(jobTitle, companyName) {
  const safeJobTitle = (jobTitle ?? '').toLowerCase().trim();
  const safeCompanyName = (companyName ?? '').toLowerCase().trim();
  const base = `${safeJobTitle}_${safeCompanyName}`;
  return hashContent(base);
}

/**
 * Process multiple emails in batches and add to tracking system
 * @param {Array} emails - Array of email objects to process
 * @param {string} userId - User identifier
 * @param {string} discord_webhook - Discord webhook URL
 * @param {boolean} isTestUser - Whether this is a test user
 * @returns {Promise<number>} - Number of emails successfully processed
 */
export const addManyToEmailUpdates = async (emails, userId, discord_webhook, isTestUser = false) => {
  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    console.log('No valid emails to process');
    return 0;
  }

  if (!userId) {
    console.error('Missing userId parameter');
    return 0;
  }

  // Reset possibleUpdates array for this batch
  possibleUpdates = [];

  const updatedEmails = [];
  const processedEmailIds = new Set();

  // Use smaller batch size for better responsiveness
  const BATCH_SIZE = 20;

  try {
    // Process emails in batches to avoid overwhelming the database
    for (let i = 0; i < emails.length; i += BATCH_SIZE) {
      const batch = emails.slice(i, i + BATCH_SIZE);

      // Process emails sequentially to avoid SQLite locking issues
      for (const email of batch) {
        // Generate a hash to identify this email if no ID exists
        if (!email.id) {
          const emailHash = hashContent(email.body);
          email.id = `email-${emailHash.substring(0, 8)}`;
        }

        // Skip if we've already processed this email in this batch
        if (processedEmailIds.has(email.id)) continue;

        try {
          const added = await addToEmailUpdates(email, userId, discord_webhook, isTestUser);
          if (added) {
            processedEmailIds.add(email.id);
            updatedEmails.push(email);
          }
        } catch (error) {
          console.error(`Error processing email ${email.id}:`, error);
          console.log('Failed to add email', email.id);
        }
      }
    }

    // Send batch update to client socket if any were added
    if (updatedEmails.length > 0 && emailUpdatesStore.connections?.has(userId)) {
      const socket = emailUpdatesStore.connections.get(userId);
      socket.emit('newEmails', updatedEmails);
    }

    // Process any updates to existing records in Discord
    if (possibleUpdates.length > 0) {
      try {
        const response = await fetch(`${process.env.BOT_URL}/updateMessages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.BOT_SECRET}`
          },
          body: JSON.stringify(possibleUpdates)
        });

        if (!response.ok) {
          throw new Error(`Discord update failed with status: ${response.status}`);
        }

        // Clear the updates after processing
        possibleUpdates = [];
      } catch (error) {
        console.error('Failed to update Discord messages:', error);
      }
    }

    return updatedEmails.length;
  } catch (error) {
    console.error('Error in addManyToEmailUpdates:', error);
    return updatedEmails.length; // Return how many we processed successfully before error
  }
};

/**
 * Process a single email and add to tracking system
 * @param {Object} email - Email object to process
 * @param {string} userId - User identifier
 * @param {string} discord_webhook - Discord webhook URL
 * @param {boolean} isTestUser - Whether this is a test user
 * @returns {Promise<boolean>} - Whether email was successfully processed
 */
export const addToEmailUpdates = async (email, userId, discord_webhook, isTestUser = false) => {
  // Validate required fields
  if (!email || !email.body || !userId) {
    console.error('Missing required parameters for addToEmailUpdates');
    return false;
  }

  const {
    body,
    from = '',
    application_id = '',
    company_name = '',
    job_title = '',
    jobStatus = '',
    date = new Date().toISOString()
  } = email;

  // Generate identifiers first
  const emailHash = hashContent(body);
  const fingerprint = generateFingerprint(job_title, company_name);

  // Generate a consistent ID for this email if not provided
  const emailId = email.id || `email-${emailHash.substring(0, 8)}`;

  // Check if we've already processed this email
  if (emailUpdatesStore.emailsById?.has(emailId)) {
    return false;
  }

  // Get DB connection with error handling
  let db;
  try {
    db = await connectDB();

    // Verify db connection has required methods
    if (!db || typeof db.run !== 'function' || typeof db.get !== 'function') {
      throw new Error('Invalid database connection - missing required methods');
    }
  } catch (error) {
    console.error('Failed to connect to database:', error);
    return false;
  }

  let possibleUpdate = null;
  let discord_id = null;

  try {
    // Use transaction for database consistency
    await db.run('BEGIN TRANSACTION');
    let success = false;

    // Check if this exact email exists
    const existing = await db.get(
      `SELECT * FROM application_tracking WHERE hash = ? AND user_id = ?`,
      [emailHash, userId]
    );

    if (!existing) {
      // Look for a possible update to an existing application
      possibleUpdate = await db.get(`
        SELECT * FROM application_tracking 
        WHERE (
          (application_id = ? AND company_name = ?) OR 
          (fingerprint = ? AND application_id = ?) OR 
          (job_title = ? AND company_name = ?)
        ) AND user_id = ?
      `, [application_id, company_name, fingerprint, application_id, job_title, company_name, userId]);

      discord_id = possibleUpdate?.discord_msg_id ?? null;

      if (possibleUpdate) {
        success = true;
      } else if (discord_webhook && discord_webhook !== "NULL") {
        // Only send to Discord if we don't have an existing record
        try {
          const result = await sendToDiscord(discord_webhook, email);
          if (result?.success) {
            success = true;
            discord_id = result.messageId;
          }
        } catch (discordError) {
          console.error('Discord send failed:', discordError);
        }
      } else if (isTestUser && discord_webhook === "NULL" || !discord_webhook) {
        success = true;
      }
    } else {
      // Email already exists in database
      success = true;
    }

    if (success) {
      if (possibleUpdate) {
        // Add to updates queue for Discord processing
        possibleUpdates.push({
          discord_msg_id: possibleUpdate.discord_msg_id,
          discord_webhook: discord_webhook,
          newStatus: jobStatus,
          jobTitle: job_title,
          companyName: company_name,
          emailSnippet: body.slice(0, 300)
        });

        // Update status and timestamp
        await db.run(`
          UPDATE application_tracking 
          SET current_status = ?, last_updated = ? 
          WHERE hash = ?
        `, [jobStatus, date, possibleUpdate.hash]);
      } else if (!existing) {
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

      // Safely update in-memory storage
      if (emailUpdatesStore.emailsById) {
        emailUpdatesStore.emailsById.set(emailId, email);

        // Only keep a reasonable number of items in the queue
        const MAX_QUEUE_SIZE = 1000;
        if (emailUpdatesStore.queue && emailUpdatesStore.queue.length >= MAX_QUEUE_SIZE) {
          const oldestEmail = emailUpdatesStore.queue.shift();
          // Remove from Map if it's not referenced elsewhere
          if (oldestEmail && oldestEmail.id) {
            emailUpdatesStore.emailsById.delete(oldestEmail.id);
          }
        }

        if (emailUpdatesStore.queue) {
          emailUpdatesStore.queue.push(email);
        }
      }

      await db.run('COMMIT');
      return true;
    } else {
      await db.run('ROLLBACK');
      return false;
    }
  } catch (error) {
    // Ensure transaction is rolled back on error
    try {
      await db.run('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed:', rollbackError);
    }
    console.error('Error in addToEmailUpdates:', error);
    return false;
  }
};


// API endpoint to get emails with optional refresh from permanent storage
export const getEmails = async (req, res) => {
  try {
    const { userId, testUser } = req;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { refresh } = req.query;
    let result = true;

    if (refresh === 'true') {
      await refreshCacheIfNeeded(userId, testUser);
    } else {
      if (testUser) {
        await refreshCacheIfNeeded(userId, testUser);
      } else {
        result = await pollEmailsCore(userId, testUser);
      }
    }

    const emails = getEmailsFromCache(userId);
    res.json({ success: result, emails });
  } catch (error) {
    console.error('Error in getEmails:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};