import { google } from 'googleapis';
import dotenv from 'dotenv';

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
  // Get user refresh token from database
  const user = await db.get('SELECT refresh_token FROM users WHERE id = ?', [userId]);
  
  if (!user || !user.refresh_token) {
    throw new Error('User not found or missing refresh token');
  }
  
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  
  oauth2Client.setCredentials({ refresh_token: user.refresh_token });
  return oauth2Client;
};

