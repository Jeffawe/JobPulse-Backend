import { google } from 'googleapis';
import dotenv from 'dotenv';
import { connectDB } from '../db/database.js';
import { decryptMultipleFields } from './secrets/encryption.js';
import { cacheUtils } from '../config/cacheConfig.js';

dotenv.config();

export const getOAuth2ClientBasic = () => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  return oauth2Client;
}

export const getOAuth2Client = async (userId) => {
  const db = await connectDB();

  let user = await cacheUtils.getCache(`data:${userId}`);

  if (!user) {
    user = await db.get(
      `SELECT credentials_encrypted_data, credentials_iv, credentials_auth_tag FROM users WHERE id = ?`,
      [userId]
    );
  }

  if (!user) {
    throw new Error('User not found');
  }

  const { refresh_token } = decryptMultipleFields(
    user.credentials_encrypted_data,
    user.credentials_iv,
    user.credentials_auth_tag
  );

  if (!refresh_token) {
    throw new Error('Missing refresh token');
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({ refresh_token: refresh_token });
  return oauth2Client;
};

