import { connectDB } from '../db/database.js';
import { getOAuth2ClientBasic } from '../services/googleClient.js';
import { cacheUtils, CACHE_DURATIONS } from '../config/cacheConfig.js';
import jwt from 'jsonwebtoken';

export const authController = {
  async googleAuth(req, res) {
    try {
      const { token } = req.body;

      const oauth2Client = getOAuth2ClientBasic();

      // Exchange code for tokens
      const { tokens } = await oauth2Client.getToken(token);
      const access_token = tokens.access_token;
      const refresh_token = tokens.refresh_token;

      if (!tokens) throw new Error('Tokens not received');
      if (!access_token) throw new Error('Access token not received');

      let firstTime = true;

      // Get user info from Google
      const response = await fetch(
        `https://www.googleapis.com/oauth2/v3/userinfo?access_token=${access_token}`
      );

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Google API error:', errorData);
        throw new Error('Failed to get user info from Google');
      }

      const userData = await response.json();
      const db = await connectDB();

      // Check if user exists
      let user = await db.get(`SELECT * FROM users WHERE email = ?`, [userData.email]);

      if (!user) {
        firstTime = true;
        // Create new user
        await db.run(
          `INSERT INTO users (email, name, refresh_token, discord_webhook) VALUES (?, ?, ?, ?)`,
          [userData.email, userData.name, refresh_token, "NULL" || null]
        );

        user = await db.get(`SELECT * FROM users WHERE email = ?`, [userData.email]);
      } else {
        firstTime = false;
        // Update refresh_token if new one is returned
        // if (refresh_token) {
        //   await db.run(
        //     `UPDATE users SET refresh_token = ? WHERE email = ?`,
        //     [refresh_token, userData.email]
        //   );
        // }
      }

      // Create JWT
      const jwtToken = jwt.sign(
        { userId: user.id },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.json({ token: jwtToken, user, firstTime: firstTime });

    } catch (error) {
      console.error('Google auth error:', error);
      res.status(401).json({ error: error.message });
    }
  },

  async verify(req, res) {
    try {
      const userId = req.userId;

      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const cachedUser = await cacheUtils.getCache(`user:${userId}`);

      if (cachedUser) return res.json(cachedUser);

      const db = await connectDB();
      const user = await db.get(`SELECT id, email, name, discord_webhook, notification_channel, notification_value FROM users WHERE id = ?`, [userId]);

      if (!user) return res.status(404).json({ error: 'User not found' });

      await cacheUtils.setCache(`user:${userId}`, user, CACHE_DURATIONS.USER_PROFILE);
      res.json(user);
    } catch (error) {
      console.error('Verification error:', error);
      res.status(401).json({ error: 'Invalid token' });
    }
  },

  async deleteAccount(req, res) {
    try {
      if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  
      const userId = req.params.userId;
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }
  
      const db = await connectDB();
  
      // Fetch user first to get refresh_token
      const user = await db.get(`SELECT * FROM users WHERE id = ?`, [userId]);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
  
      // Revoke Google refresh token if it exists
      if (user.refresh_token) {
        try {
          await fetch('https://oauth2.googleapis.com/revoke', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: `token=${user.refresh_token}`
          });
        } catch (revokeErr) {
          console.warn('Failed to revoke Google token:', revokeErr);
          // continue anyway — this shouldn’t block account deletion
        }
      }
  
      // Delete user from DB
      const result = await db.run(`DELETE FROM users WHERE id = ?`, [userId]);
      if (result.changes === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
  
      // Clear cache
      await cacheUtils.deleteCache(`user:${userId}`);
  
      res.status(200).json({ message: 'Account deleted and access revoked' });
    } catch (error) {
      console.error('Delete account error:', error);
      res.status(500).json({ error: 'Failed to delete account' });
    }
  }
  
};

export const UpdateUserNotifications = async (req, res) => {
  const userId = req.userId;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { email, discord_webhook, notification_channel, notification_value } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const db = await connectDB();

    // Fetch existing user data
    const user = await db.get(`SELECT * FROM users WHERE email = ?`, [email]);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Use existing values if not provided
    const updatedWebhook = discord_webhook ?? user.discord_webhook;
    const updatedChannel = notification_channel ?? user.notification_channel;
    const updatedValue = notification_value ?? user.notification_value;

    await db.run(
      `UPDATE users 
       SET discord_webhook = ?, notification_channel = ?, notification_value = ? 
       WHERE email = ?`,
      [updatedWebhook, updatedChannel, updatedValue, email]
    );

    // Get the updated user from DB
    const updatedUser = await db.get(`SELECT * FROM users WHERE email = ?`, [email]);

    await cacheUtils.deleteCache(`user:${userId}`);

    return res.status(200).json(updatedUser);

  } catch (error) {
    console.error('Update error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
