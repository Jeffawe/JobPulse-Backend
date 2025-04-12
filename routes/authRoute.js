import express from 'express';
import { authController, UpdateUserNotifications } from '../controllers/authController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.post('/google', authController.googleAuth);;
router.post('/update-notifications', authenticateToken,UpdateUserNotifications);

export default router;