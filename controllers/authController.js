import { connectDB } from '../db/database.js';
import { getOAuth2ClientBasic } from '../services/googleClient.js';
import { cacheUtils, CACHE_DURATIONS } from '../config/cacheConfig.js';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { encryptMultipleFields, decryptMultipleFields } from '../services/encryption.js';

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

      const { iv, encryptedData, authTag } = encryptMultipleFields({
        refresh_token,
        discord_webhook: null
      });

      if (!user) {
        firstTime = true;

        const { success, labelId } = await createGmailFilter(oauth2Client);
        const label = success ? labelId : null;

        await db.run(
          `INSERT INTO users (
            email,
            name,
            credentials_encrypted_data,
            credentials_iv,
            credentials_auth_tag,
            discord_webhook,
            label_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            userData.email,
            userData.name,
            encryptedData,
            iv,
            authTag,
            false,
            label
          ]
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
            `UPDATE users
             SET
               credentials_encrypted_data = COALESCE(?, credentials_encrypted_data),
               credentials_iv = COALESCE(?, credentials_iv),
               credentials_auth_tag = COALESCE(?, credentials_auth_tag),
               label_id = COALESCE(?, label_id),
               discord_webhook = ?
             WHERE email = ?`,
            [
              encryptedData,
              iv,
              authTag,
              finalLabel,
              false,
              userData.email
            ]
          );
        }
      }

      const sanitizedUser = {
        id: user.id,
        email: user.email,
        name: user.name,
        discord_webhook: user.discord_webhook,
        notification_channel: user.notification_channel,
        notification_value: user.notification_value,
        notification_status: user.notification_status,
        email_addresses: user.email_addresses,
        label_id: user.label_id
      };

      // Create JWT
      const jwtToken = jwt.sign(
        { userId: user.id },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      await cacheUtils.setCache(`userbasic:${user.id}`, sanitizedUser, CACHE_DURATIONS.USER_PROFILE);

      res.json({ token: jwtToken, user: sanitizedUser, firstTime: firstTime });

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
        `SELECT credentials_encrypted_data, credentials_iv, credentials_auth_tag FROM users WHERE id = ?`,
        [userId]
      );

      if (!tokenRow) throw new Error("User not found");

      const { refresh_token } = decryptMultipleFields(
        tokenRow.credentials_encrypted_data,
        tokenRow.credentials_iv,
        tokenRow.credentials_auth_tag
      );

      const oauth2Client = getOAuth2ClientBasic();
      oauth2Client.setCredentials({ refresh_token: refresh_token });
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
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = req.params.userId;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const db = await connectDB();
    await db.run('BEGIN TRANSACTION');

    try {
      // Get encrypted credentials
      const user = await db.get(
        `SELECT credentials_encrypted_data, credentials_iv, credentials_auth_tag FROM users WHERE id = ?`,
        [userId]
      );

      if (!user) {
        await db.run('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }

      // Revoke Google token
      let revokeAccess = false;
      try {
        const { refresh_token } = decryptMultipleFields(
          user.credentials_encrypted_data,
          user.credentials_iv,
          user.credentials_auth_tag
        );

        if (refresh_token) {
          const response = await fetch('https://oauth2.googleapis.com/revoke', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: `token=${refresh_token}`
          });

          revokeAccess = response.ok;
          if (!revokeAccess) {
            console.warn('Failed to revoke Google token: Non-200 response');
          }
        }
      } catch (err) {
        console.warn('Failed to decrypt and revoke refresh token:', err);
      }

      // Delete user and related records
      const deleteUser = await db.run(`DELETE FROM users WHERE id = ?`, [userId]);
      if (deleteUser.changes === 0) {
        await db.run('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }

      await db.run(`DELETE FROM application_tracking WHERE user_id = ?`, [userId]);

      await db.run('COMMIT');
      await cacheUtils.deleteCache(`userbasic:${userId}`);

      res.status(200).json({ message: 'Account deleted and access revoked', revokeAccess });

    } catch (error) {
      await db.run('ROLLBACK');
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
        gmail.users.settings.filters.delete({
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

  if (discord_webhook && !discord_webhook.startsWith('https://discord.com/api/webhooks/')) {
    return res.status(400).json({ error: 'Invalid Discord webhook URL' });
  }

  try {
    const db = await connectDB();

    await db.run('BEGIN TRANSACTION');

    try {
      const user = await db.get(
        `SELECT id, email, name, notification_value, notification_channel, notification_status, email_addresses, label_id, 
                credentials_encrypted_data, credentials_iv, credentials_auth_tag, discord_webhook
         FROM users WHERE id = ?`,
        [userId]
      );

      if (!user) {
        await db.run('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }

      let decryptedCreds;
      try {
        decryptedCreds = decryptMultipleFields(
          user.credentials_encrypted_data,
          user.credentials_iv,
          user.credentials_auth_tag
        );
      } catch (err) {
        await db.run('ROLLBACK');
        return res.status(500).json({ error: 'Failed to decrypt credentials' });
      }

      // Update the webhook value
      const updatedWebhook = discord_webhook ?? decryptedCreds.discord_webhook;
      const updatedCreds = {
        refresh_token: decryptedCreds.refresh_token,
        discord_webhook: updatedWebhook
      };

      // Re-encrypt
      const { encryptedData, iv, authTag } = encryptMultipleFields(updatedCreds);

      // Update fields
      const updatedChannel = notification_channel ?? user.notification_channel;
      const updatedValue = notification_value ?? user.notification_value;

      await db.run(
        `UPDATE users 
          SET 
            credentials_encrypted_data = ?,
            credentials_iv = ?,
            credentials_auth_tag = ?,
            discord_webhook = ?,
            notification_channel = ?,
            notification_value = ?
          WHERE email = ?`,
        [
          encryptedData,
          iv,
          authTag,
          Boolean(updatedWebhook),
          updatedChannel,
          updatedValue,
          email
        ]
      );

      cacheUtils.setCache(`discord_webhook:${userId}`, updatedWebhook, CACHE_DURATIONS.DISCORD_WEBHOOK);
      
      // Commit changes
      await db.run('COMMIT');

      // Get the updated user from DB
      const updatedUser = await db.get(`SELECT id, email, name, notification_value, notification_channel, notification_status, email_addresses, label_id FROM users WHERE email = ?`, [email]);

      await cacheUtils.deleteCache(`userbasic:${userId}`);

      return res.status(200).json(updatedUser);
    } catch (error) {
      // Rollback on error
      await db.run('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Update error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
