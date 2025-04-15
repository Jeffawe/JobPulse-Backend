// Enhanced email update system with WebSocket support
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';

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
        addToEmailUpdates(email, userId, 'storage', email.storageLocation || 'unknown');
      });
      
      emailUpdatesStore.lastRefreshed = now;
    } catch (error) {
      console.error('Failed to refresh cache from permanent storage:', error);
    }
  }
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

export const addToEmailUpdates = (email, userId, source, storageLocation) => {
  const emailId = email.id || `email-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  email.id = emailId;
  
  email.metadata = {
    receivedAt: new Date().toISOString(),
    source: source || 'unknown',
    storageLocation: storageLocation || 'memory',
    userId
  };
  
  // Prevent duplicates
  if (!emailUpdatesStore.emailsById.has(emailId)) {
    emailUpdatesStore.emailsById.set(emailId, email);
    emailUpdatesStore.queue.push(email);
    
    // Send real-time update
    if (userId && emailUpdatesStore.connections.has(userId)) {
      const socket = emailUpdatesStore.connections.get(userId);
      socket.emit('newEmail', email);
    }
    
    return true;
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