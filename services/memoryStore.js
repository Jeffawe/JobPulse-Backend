import { Server } from 'socket.io';
import crypto from 'crypto';
import { sendToDiscord, saveToSupabase } from '../controllers/jobController';
import { connectDB } from '../db/database';

const possibleUpdates = [];

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
      const userEmails = getEmailUpdates(userId);
      socket.emit('initialEmails', userEmails);

      socket.on('disconnect', () => {
        emailUpdatesStore.connections.delete(userId);
      });
    });
  });
};

// Function to check if cache needs refreshing and do so if needed
async function refreshCacheIfNeeded(userId) {
  const now = Date.now();
  const needsRefresh = !emailUpdatesStore.lastRefreshed ||
    (now - emailUpdatesStore.lastRefreshed) > CACHE_EXPIRATION;

  if (needsRefresh) {
    try {
      // Clear existing cache for this user
      clearUserCache(userId);

      // Fetch fresh data from permanent storage
      const freshData = await GetDataFromBot(userId);

      // Add fresh data to cache with 'storage' source
      freshData.forEach(email => {
        addToEmailUpdates(email, userId, null);
      });

      emailUpdatesStore.lastRefreshed = now;
    } catch (error) {
      console.error('Failed to refresh cache from permanent storage:', error);
    }
  }
}

const GetDataFromBot = async (userId) => {
  return []
}

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

export const addManyToEmailUpdates = async (emails, userId, discord_webhook) => {
  const updatedEmails = [];

  for (const email of emails) {
    const added = await addToEmailUpdates(email, userId, discord_webhook);
    if (added) updatedEmails.push(email);
  }

  // Batch WebSocket emit
  if (updatedEmails.length && emailUpdatesStore.connections.has(userId)) {
    const socket = emailUpdatesStore.connections.get(userId);
    socket.emit('newEmails', updatedEmails);
  }

  if (possibleUpdates.length > 0) {
    await fetch(`${process.env.BOT_URL}/updateMessages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BOT_SECRET}`
      },
      body: JSON.stringify(possibleUpdates)
    });
  }

  return updatedEmails.length;
};

export const addToEmailUpdates = async (email, userId, discord_webhook) => {
  const {
    body,
    from,
    application_id,
    company_name,
    job_title,
    jobStatus,
    date
  } = email;

  const emailHash = hashContent(body);
  const fingerprint = generateFingerprint(job_title, company_name);

  const db = connectDB();
  if (!db) return false;

  const existing = await db.get(
    `SELECT * FROM application_tracking WHERE hash = ?`,
    [emailHash]
  );

  if (!existing) {
    const possibleUpdate = await db.get(`
      SELECT * FROM application_tracking 
      WHERE (
        (application_id = ? AND company_name = ?) OR 
        (fingerprint = ? AND application_id = ?) OR 
        (job_title = ? AND company_name = ?)
      ) AND user_id = ?
    `, [application_id, company_name, fingerprint, application_id, job_title, company_name, userId]);

    if (possibleUpdate) {
      possibleUpdates.push({
        discord_msg_id: possibleUpdate.discord_msg_id,
        discord_webhook: discord_webhook,
        newStatus: jobStatus,
        jobTitle: job_title,
        companyName: company_name,
        emailSnippet: email.body.slice(0, 300)
      });

      await db.run(`
        UPDATE application_tracking 
        SET current_status = ?, last_updated = ? 
        WHERE hash = ?
      `, [jobStatus, date, possibleUpdate.hash]);
    }

    let success = false;
    let discord_id = possibleUpdate?.discord_msg_id ?? null;

    if (discord_webhook && discord_webhook !== "NULL") {
      const result = await sendToDiscord(discord_webhook, email);
      if (result.success) {
        success = true;
        discord_id = result.messageId;
      }
    } else {
      success = await saveToSupabase(userId, email);
    }

    if (success) {
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

      const emailId = email.id || `email-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      email.id = emailId;
      email.metadata = {
        receivedAt: new Date().toISOString(),
        source: possibleUpdate ? 'update' : 'new',
        storageLocation: 'memory',
        userId
      };

      if (!emailUpdatesStore.emailsById.has(emailId)) {
        emailUpdatesStore.emailsById.set(emailId, email);
        emailUpdatesStore.queue.push(email);
        return true;
      }
    }
  }

  return false;
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

  const emails = getEmailUpdates(userId);
  res.json({ success: true, emails });
};