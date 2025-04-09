import { connectDB } from '../db/database.js';
import { oauth2Client } from '../services/googleClient.js';
import { cacheUtils } from '../config/cacheConfig.js';

export const authController = {
  async googleAuth(req, res) {
    try {
      const { token } = req.body;

      // Exchange code for tokens
      const { tokens } = await oauth2Client.getToken(token);
      const access_token = tokens.access_token;
      const refresh_token = tokens.refresh_token;

      if (!access_token) throw new Error('Access token not received');

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
        // Create new user
        await db.run(
          `INSERT INTO users (email, name, refresh_token) VALUES (?, ?, ?)`,
          [userData.email, userData.name, refresh_token || null]
        );

        user = await db.get(`SELECT * FROM users WHERE email = ?`, [userData.email]);
      } else {
        // Update refresh_token if new one is returned
        if (refresh_token) {
          await db.run(
            `UPDATE users SET refresh_token = ? WHERE email = ?`,
            [refresh_token, userData.email]
          );
        }
      }

      // Create JWT
      const jwtToken = jwt.sign(
        { userId: user.id },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.json({ token: jwtToken, user });

    } catch (error) {
      console.error('Google auth error:', error);
      res.status(401).json({ error: error.message });
    }
  },

  async verify(req, res) {
    try {
      const userId = req.user.userId;
      const cachedUser = await cacheUtils.getCache(`user:${userId}`);

      if (cachedUser) return res.json(cachedUser);

      const db = await connectDB();
      const user = await db.get(`SELECT id, email, name FROM users WHERE id = ?`, [userId]);

      if (!user) return res.status(404).json({ error: 'User not found' });

      await cacheUtils.setCache(`user:${userId}`, user, CACHE_DURATIONS.USER_PROFILE);
      res.json(user);
    } catch (error) {
      console.error('Verification error:', error);
      res.status(401).json({ error: 'Invalid token' });
    }
  }
};

// POST /auth/update-notifications
export const UpdateUserNotifications = async (req, res) => {
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

    return res.status(200).json({ message: 'User updated successfully' });

  } catch (error) {
    console.error('Update error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
