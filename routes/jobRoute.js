import express from 'express';
import { 
    setupGmailPushNotifications, 
    handleGmailPushNotification,
    refreshGmailWatch 
  } from '../controllers/pushController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Route to set up Gmail push notifications for a user
// This should be called when a user connects their Gmail account
router.post('/setup-gmail-push', authenticateToken, setupGmailPushNotifications);

// Endpoint that receives push notifications from Google Pub/Sub
// This should be publicly accessible (no auth) with proper validation inside
router.post('/gmail-webhook', handleGmailPushNotification);

// You might also want a route to manually refresh the watch
router.post('/refresh-gmail-watch', authenticateToken, async (req, res) => {
  try {
    const result = await refreshGmailWatch(req.userId);
    res.status(200).json({ success: result });
  } catch (error) {
    console.error('Error refreshing Gmail watch:', error);
    res.status(500).json({ error: 'Failed to refresh Gmail watch' });
  }
});

export default router;
