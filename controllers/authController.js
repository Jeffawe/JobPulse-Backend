import { connectDB, canCreateTestUser } from '../db/database.js';
import { getOAuth2ClientBasic } from '../services/googleClient.js';
import { cacheUtils, CACHE_DURATIONS } from '../config/cacheConfig.js';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { encryptMultipleFields, decryptMultipleFields } from '../services/secrets/encryption.js';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const generateRandomString = (length) => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

const generateTestUser = async (db) => {
  try {
    const testEmail = `demo-${uuidv4().substring(0, 8)}@testing.com`;
    let testUser = await db.get(`SELECT * FROM users WHERE email = ?`, [testEmail]);

    if (!testUser) {
      // Generate secure but fake credentials
      const fakeCredentials = {
        refresh_token: `test_${generateRandomString(30)}`,
        discord_webhook: 'test_discord_webhook'
      };

      // Encrypt the fake credentials
      const { testencryptedData, testiv, testauthTag } = encryptMultipleFields(fakeCredentials);

      await db.run(
        `INSERT INTO users (
        email,
        name,
        credentials_encrypted_data,
        credentials_iv,
        credentials_auth_tag,
        discord_webhook,
        label_id,
        isTestUser
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          testEmail,
          'Test User',
          testencryptedData,
          testiv,
          testauthTag,
          false,
          null,
          true
        ]
      );

      testUser = await db.get(`SELECT * FROM users WHERE email = ?`, [testEmail]);
    }

    if (!testUser) {
      throw new Error("Failed to create test user");
    }

    return testUser;
  } catch (e) {
    console.log(e);
    throw new Error("Failed to create test user");
  }
}

export const authController = {
  async googleAuth(req, res) {
    try {
      const { token, is_test_user } = req.body;

      if (!token) throw new Error("No code provided");

      let firstTime = true;

      const oauth2Client = getOAuth2ClientBasic();

      const db = await connectDB();

      if (!db) throw new Error("Failed to connect to database");

      if (is_test_user) {
        // Get client IP address - adjust as needed based on your setup
        const ipAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        // Check if test user creation is allowed for this IP
        const limitCheck = await cacheUtils.getCache(`testUserLimit:${ipAddress}`);

        let canCreate;
        if (!limitCheck) {
          // Check database if not in cache
          canCreate = await canCreateTestUser(ipAddress);
          // Cache the result briefly to prevent database hammering
          await cacheUtils.setCache(`testUserLimit:${ipAddress}`, canCreate, 60); // Cache for 60 seconds
        } else {
          canCreate = limitCheck;
        }

        if (!canCreate.allowed) {
          // Return appropriate error based on reason
          let errorMessage = "Test user creation limit reached.";
          let waitTime = "Please try again later.";

          switch (canCreate.reason) {
            case 'ip_total_limit':
              errorMessage = "You've reached the maximum number of test users allowed.";
              break;
            case 'ip_daily_limit':
              errorMessage = "Daily test user creation limit reached.";
              waitTime = "Please try again tomorrow.";
              break;
            case 'system_limit':
              errorMessage = "System-wide test user limit reached.";
              break;
          }

          return res.status(429).json({
            error: errorMessage,
            message: waitTime
          });
        }

        let testUser = await cacheUtils.getCache(`userbasic:${token}`);

        if (!testUser) {
          testUser = await db.get(`SELECT * FROM users WHERE id = ?`, [token]);
        }

        if (!testUser) {
          testUser = await generateTestUser(db);
          firstTime = true;
        }

        const message = firstTime ? 'Test user created Successfully' : 'Loading exisitng test user';

        const testJwtToken = jwt.sign(
          { userId: testUser.id, is_test_user: true },
          process.env.JWT_SECRET,
          { expiresIn: '1d' }
        );

        await cacheUtils.setCache(`userbasic:${testUser.id}`, testUser, CACHE_DURATIONS.USER_PROFILE);

        return res.json({ token: testJwtToken, user: testUser, firstTime: true, message: message });
      }

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

      if (!tokens.refresh_token) {
        console.warn('No refresh token received — user might have already granted access before.');
      }

      const oauth2 = google.oauth2({
        auth: oauth2Client,
        version: 'v2',
      });

      const { data: userData } = await oauth2.userinfo.get();


      // Check if user exists
      let user = await db.get(`SELECT * FROM users WHERE email = ?`, [userData.email]);

      const { iv, encryptedData, authTag } = encryptMultipleFields({
        refresh_token,
        discord_webhook: null,
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
            label_id,
            isTestUser
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userData.email,
            userData.name,
            encryptedData,
            iv,
            authTag,
            false,
            label,
            false
          ]
        );

        user = await db.get(`SELECT * FROM users WHERE email = ?`, [userData.email]);

        const encryptedCachePayload = {
          credentials_encrypted_data: encryptedData,
          credentials_iv: iv,
          credentials_auth_tag: authTag,
        };

        await cacheUtils.setCache(
          `data:${user.id}`,
          encryptedCachePayload,
          CACHE_DURATIONS.OTHER
        );
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

          const encryptedCachePayload = {
            credentials_encrypted_data: encryptedData,
            credentials_iv: iv,
            credentials_auth_tag: authTag,
          };

          await cacheUtils.setCache(
            `data:${user.id}`,
            encryptedCachePayload,
            CACHE_DURATIONS.OTHER
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
        label_id: user.label_id,
        isTestUser: user.isTestUser
      };

      // Create JWT
      const jwtToken = jwt.sign(
        { userId: user.id, is_test_user: false },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      await cacheUtils.setCache(`userbasic:${user.id}`, sanitizedUser, CACHE_DURATIONS.USER_PROFILE);

      const finalMessage = firstTime ? 'User created Successfully' : 'Loading exisitng user';
      res.json({ token: jwtToken, user: sanitizedUser, firstTime: firstTime, message: finalMessage });

    } catch (error) {
      console.error('Google auth error:', error);
      res.status(401).json({ error: error.message });
    }
  },

  async createGmailFilterEndPoint(req, res) {
    try {
      const userId = req.userId;
      const testUser = req.testUser;

      if (testUser) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const db = await connectDB();

      let cachedUser = await cacheUtils.getCache(`userbasic:${userId}`);

      if (!cachedUser) {
        cachedUser = await db.get(`
          SELECT id, email, name, notification_value, notification_channel, notification_status, email_addresses, label_id, discord_webhook, isTestUser
          FROM users
          WHERE id = ?
        `, [userId]);

        if (!cachedUser) {
          return res.status(404).json({ error: 'User not found' });
        }
      }

      let tokenRow = await cacheUtils.getCache(`data:${userId}`);

      if (!tokenRow) {
        tokenRow = await db.get(
          `SELECT credentials_encrypted_data, credentials_iv, credentials_auth_tag FROM users WHERE id = ?`,
          [userId]
        );
      }

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
      const testUser = req.testUser;

      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      let cacheKey = `userbasic:${userId}`;
      const cachedUser = await cacheUtils.getCache(cacheKey);

      if (cachedUser) return res.json(cachedUser);

      const db = await connectDB();
      const user = await db.get(`
        SELECT id, email, name, notification_value, notification_channel, notification_status, email_addresses, discord_webhook, label_id, isTestUser
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
    const email = req.body.email || null;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    console.log('deleteAccount', userId, req.userId, email);

    const db = await connectDB();
    let transactionStarted = false;

    try {
      await db.run('BEGIN TRANSACTION');
      transactionStarted = true;

      let user = await cacheUtils.getCache(`data:${userId}`);

      if (!user) {
        user = await db.get(
          `SELECT id, credentials_encrypted_data, credentials_iv, credentials_auth_tag FROM users WHERE id = ?`,
          [userId]
        );
      }

      if (!user && email) {
        user = await db.get(
          `SELECT id, credentials_encrypted_data, credentials_iv, credentials_auth_tag FROM users WHERE email = ?`,
          [email]
        );
      }

      if (!user) {
        throw new Error('User not found');
      }

      if (!req.testUser) {
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

            if (!response.ok) {
              console.warn('Failed to revoke Google token: Non-200 response');
            }
          }
        } catch (err) {
          console.warn('Failed to decrypt and revoke refresh token:', err);
        }
      }

      if (req.testUser) {
        await cacheUtils.deleteCache(`testUser${user.id}`);

        const ipAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        if (ipAddress) {
          const ipExists = await db.get(
            `SELECT count FROM test_user_limits WHERE ip_address = ?`,
            [ipAddress]
          );

          if (ipExists) {
            await db.run(
              `UPDATE test_user_limits 
             SET count = count - 1 
             WHERE ip_address = ? AND count > 0`,
              [ipAddress]
            );
          }
        }
      }

      await db.run(`DELETE FROM application_tracking WHERE user_id = ?`, [user.id]);
      const deleteUser = await db.run(`DELETE FROM users WHERE id = ?`, [user.id]);


      if (deleteUser.changes === 0) {
        throw new Error('User not found');
      }

      await db.run('COMMIT');

      await cacheUtils.deleteCache(`data:${user.id}`);
      await cacheUtils.deleteCache(`userbasic:${user.id}`);
      await cacheUtils.deleteCache(`testUser${user.id}`);

      res.status(200).json({ message: 'Account deleted and access revoked' });

    } catch (error) {
      if (transactionStarted) {
        try {
          await db.run('ROLLBACK');
        } catch (rollbackError) {
          console.error('Rollback failed:', rollbackError);
        }
      }
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
             "technical interview" OR "onsite interview" OR "job application" OR "your candidacy" OR
             "thank you for applying" OR "not to move forward" OR "not moving forward" OR
             "not proceed" OR "other candidates" OR "decided to proceed" OR "no longer under consideration" OR
             "pursue other candidates" OR "application unsuccessful" OR "won't be progressing" OR
             "not selected" OR "not a match" OR "opportunity to inform you"))
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
           *@myworkday.com OR talentmanagementsolution@myworkday.com OR
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
          addLabelIds: [label.id]
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
                isTestUser, credentials_encrypted_data, credentials_iv, credentials_auth_tag, discord_webhook
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

      const encryptedCachePayload = {
        credentials_encrypted_data: encryptedData,
        credentials_iv: iv,
        credentials_auth_tag: authTag,
      };

      await Promise.all([
        cacheUtils.setCache(`data:${userId}`, encryptedCachePayload, CACHE_DURATIONS.OTHER),
        cacheUtils.setCache(`discord_webhook:${userId}`, updatedWebhook, CACHE_DURATIONS.DISCORD_WEBHOOK),
      ]);

      // Commit changes
      await db.run('COMMIT');

      // Get the updated user from DB
      const updatedUser = await db.get(`SELECT id, email, name, notification_value, notification_channel, notification_status, email_addresses, label_id, isTestUser FROM users WHERE email = ?`, [email]);

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
