import { connectDB } from '../db/database.js';
import { getOAuth2ClientBasic } from '../services/googleClient.js';
import { cacheUtils, CACHE_DURATIONS } from '../config/cacheConfig.js';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { google } from 'googleapis';

dotenv.config();

export const authController = {
  async googleAuth(req, res) {
    try {
      const { token } = req.body;

      if (!token) throw new Error("No code provided");

      const oauth2Client = getOAuth2ClientBasic();

      // Exchange code for tokens
      const { tokens } = await oauth2Client.getToken({
        code: token,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI
      });
      oauth2Client.setCredentials(tokens);

      const access_token = tokens.access_token;
      const refresh_token = tokens.refresh_token;

      if (!tokens || !access_token) {
        throw new Error('Failed to retrieve tokens');
      }

      let firstTime = true;

      const oauth2 = google.oauth2({
        auth: oauth2Client,
        version: 'v2',
      });

      const { data: userData } = await oauth2.userinfo.get();

      const db = await connectDB();


      // Check if user exists
      let user = await db.get(`SELECT * FROM users WHERE email = ?`, [userData.email]);

      if (!user) {
        firstTime = true;

        const { success, labelId } = await createGmailFilter(oauth2Client);
        const label = success ? labelId : null;

        await db.run(
          `INSERT INTO users (email, name, refresh_token, discord_webhook, label_id) VALUES (?, ?, ?, ?, ?)`,
          [userData.email, userData.name, refresh_token, "NULL" || null, label]
        );

        user = await db.get(`SELECT * FROM users WHERE email = ?`, [userData.email]);
      } else {
        firstTime = false;

        let finalLabel = user.label_id;
        let update = false;

        // If user has no label, create one
        if (!user.label_id) {
          const { success, labelId } = await createGmailFilter(oauth2Client);
          if (success) {
            finalLabel = labelId;
            update = true;
          }
        }

        // If refresh_token is present, we should update
        if (refresh_token) {
          update = true;
        }

        if (update) {
          await db.run(
            `UPDATE users SET refresh_token = COALESCE(?, refresh_token), label_id = COALESCE(?, label_id) WHERE email = ?`,
            [refresh_token, finalLabel, userData.email]
          );
        }
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

  async createGmailFilterEndPoint(req, res) {
    try {
      const userId = req.userId;
  
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
  
      const db = await connectDB();
  
      let cachedUser = await cacheUtils.getCache(`userbasic:${userId}`);
  
      if (!cachedUser) {
        cachedUser = await db.get(`
          SELECT id, email, name, notification_value, notification_channel, notification_status, email_addresses, label_id
          FROM users
          WHERE id = ?
        `, [userId]);
  
        if (!cachedUser) {
          return res.status(404).json({ error: 'User not found' });
        }
      }

      const tokenRow = await db.get(
        `SELECT refresh_token FROM users WHERE id = ?`,
        [userId]
      );
      
      if (!tokenRow?.refresh_token) {
        return res.status(401).json({ error: 'No refresh token available' });
      }
  
      const oauth2Client = getOAuth2ClientBasic();
      oauth2Client.setCredentials({ refresh_token: tokenRow.refresh_token });
      const { success, labelId } = await createGmailFilter(oauth2Client);
  
      if (success && labelId) {
        await db.run(
          `UPDATE users SET label_id = ? WHERE id = ?`,
          [labelId, cachedUser.id]
        );
  
        // Update cache object and reset it
        cachedUser.label_id = labelId;
        await cacheUtils.setCache(`userbasic:${userId}`, cachedUser, CACHE_DURATIONS.USER_PROFILE);
      }
  
      res.status(200).json(cachedUser);
  
    } catch (error) {
      console.error('Error Creating Filter:', error);
      res.status(500).json({ error: 'Server Error: Failed to create filter' });
    }
  },

  async verify(req, res) {
    try {
      const userId = req.userId;

      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      const cachedUser = await cacheUtils.getCache(`userbasic:${userId}`);

      if (cachedUser) return res.json(cachedUser);

      const db = await connectDB();
      const user = await db.get(`
        SELECT id, email, name, notification_value, notification_channel, notification_status, email_addresses, label_id
        FROM users
        WHERE id = ?
      `, [userId]);

      if (!user) return res.status(404).json({ error: 'User not found' });

      await cacheUtils.setCache(`userbasic:${userId}`, user, CACHE_DURATIONS.USER_PROFILE);
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
      await cacheUtils.deleteCache(`userbasic:${userId}`);

      res.status(200).json({ message: 'Account deleted and access revoked' });
    } catch (error) {
      console.error('Delete account error:', error);
      res.status(500).json({ error: 'Failed to delete account' });
    }
  }

};

export const createGmailFilter = async (oauth2Client) => {
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const labelName = 'JobPulseTracker';
  
  const query = `
    (subject:("application received" OR "thank you for your application" OR "application status" OR 
             "we received your application" OR "application confirmation" OR "interview invitation" OR
             "interview request" OR "schedule an interview" OR "job offer" OR "position update" OR
             "next steps" OR "assessment invitation" OR "hiring process" OR "thanks for applying" OR
             "we're reviewing your application" OR "application submission" OR "phone screen" OR
             "technical interview" OR "onsite interview" OR "job application" OR "your candidacy"))
    OR
    (from:(jobs-noreply@linkedin.com OR careers@linkedin.com OR *@indeedemail.com OR 
           *@bounce.jobvite.com OR *@notifications.lever.co OR *@greenhouse.io OR
           *@workday.com OR *@taleo.net OR *@brassring.com OR *@smartrecruiters.com OR
           *@icims.com OR *@ultipro.com OR *@myworkdayjobs.com OR *@successfactors.com OR
           *@bamboohr.com OR *@recruitee.com OR *@zohorecruit.com OR *@ashbyhq.com OR
           *@workable.com OR *@hire.lever.co OR *@eightfold.ai OR *@manatalportal.com OR
           *@app.jazz.co OR noreply@hired.com OR *@indeed.com OR *@ziprecruiter.com OR
           *@monster.com OR *@careerbuilder.com OR *@dice.com OR *@wellfound.com OR
           *@talent.com OR *@angel.co OR *@remoteco.com OR *@simplyhired.com OR
           jobs@greenhouse.io OR talent@*) 
     -subject:("who's viewed" OR "weekly" OR "digest" OR "network" OR "profile views" OR "trending" OR
              "updates" OR "news" OR "newsletter" OR "subscription"))
  `;

  try {
    // 1. Get all labels
    const labelsRes = await gmail.users.labels.list({ userId: 'me' });
    const labels = labelsRes.data.labels || [];

    // 2. Check if label already exists
    let label = labels.find(l => l.name === labelName);

    if (!label) {
      // 3. Create label if it doesn't exist
      const createRes = await gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name: labelName,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
          color: {
            backgroundColor: '#4986e7', // Blue background
            textColor: '#ffffff'        // White text
          }
        },
      });

      label = createRes.data;
      console.log('Label created:', label.id);
    } else {
      console.log('Label already exists:', label.id);
    }

    // 4. Check if a filter already exists with the same query + label
    const filtersRes = await gmail.users.settings.filters.list({ userId: 'me' });
    const filters = filtersRes.data.filter || [];

    // Find and delete any existing JobPulseTracker filters to avoid duplicates
    const existingFilters = filters.filter(f => 
      f.action?.addLabelIds?.includes(label.id)
    );
    
    if (existingFilters.length > 0) {
      console.log(`Removing ${existingFilters.length} existing filters for this label`);
      for (const filter of existingFilters) {
        await gmail.users.settings.filters.delete({
          userId: 'me',
          id: filter.id
        });
        console.log(`Deleted old filter: ${filter.id}`);
      }
    }

    // 5. Create the new filter
    const filterRes = await gmail.users.settings.filters.create({
      userId: 'me',
      requestBody: {
        criteria: {
          query: query.replace(/\s+/g, ' ').trim(), // Clean up the query string
        },
        action: {
          addLabelIds: [label.id],
          // Uncomment the next line if you want to auto-archive these emails
          // removeLabelIds: ['INBOX'],
        },
      },
    });

    console.log('New filter created:', filterRes.data.id);
    return { 
      success: true, 
      labelId: label.id,
      message: 'Job application filter successfully created/updated'
    };
  } catch (err) {
    console.error('Error setting up Gmail filter/label:', err);
    return { 
      success: false, 
      error: err.message 
    };
  }
}

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

    await cacheUtils.deleteCache(`userbasic:${userId}`);

    return res.status(200).json(updatedUser);

  } catch (error) {
    console.error('Update error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
