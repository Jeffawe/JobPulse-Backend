// In your Express router
import express from 'express';
import { 
    handleGmailPushNotification
  } from '../controllers/pushController.js';

const router = express.Router();

// Route that Google Pub/Sub will call (webhook endpoint)
router.post('/webhook', handleGmailPushNotification);

export default router;