import express from 'express';
import { authController, UpdateUserNotifications } from '../controllers/authController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.post('/google', authController.googleAuth);
router.get('/verify', authenticateToken, authController.verify);
router.delete('/delete/:userId', authenticateToken,authController.deleteAccount);
router.patch('/update', authenticateToken, UpdateUserNotifications);

export default router;