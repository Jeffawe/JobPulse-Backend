import { addToEmailUpdates } from '../services/emailUpdates.js';
import { NLPProcessor } from '../../nlpProcessor.js';
import { getOAuth2Client } from '../services/googleClient.js';

export const pollEmails = async (req, res) => {
    try {
      const { userId } = req;
      
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      const db = await connectDB();
      
      // Get user info
      const user = await db.get('SELECT email, discord_webhook FROM users WHERE id = ?', [userId]);
      
      // Get OAuth2 client
      const oauth2Client = await getOAuth2Client(userId);
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      
      const pollIntervalMinutes = parseInt(process.env.EMAIL_POLL_INTERVAL_MINUTES || '60');
    
      // Get emails from the last interval period
      const intervalMilliseconds = pollIntervalMinutes * 60 * 1000;
      const timeAgo = new Date(Date.now() - intervalMilliseconds).getTime() / 1000;
      const query = `after:${Math.floor(timeAgo)}`;
      
      const { data } = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 100
      });
      
      const messages = data.messages || [];
      const jobEmails = [];
      
      console.log(`Found ${messages.length} emails in the last ${pollIntervalMinutes} minutes`);
      
      // Process each email
      for (const message of messages) {
        const emailData = await gmail.users.messages.get({
          userId: 'me',
          id: message.id,
          format: 'full'
        });
        
        // Process email with NLP to check if it's a job email
        const processedEmail = await NLPProcessor(emailData.data);
        
        if (processedEmail.isJobEmail) {
          jobEmails.push(processedEmail);
          
          // Add to shared queue for frontend updates
          addToEmailUpdates(processedEmail);
          
          // Send to appropriate notification channel
          if (user.discord_webhook) {
            await sendToDiscord(user.discord_webhook, processedEmail);
          } else {
            await saveToSupabase(userId, processedEmail);
          }
        }
      }
      
      return res.status(200).json({ success: true, count: jobEmails.length });
    } catch (error) {
      console.error('Error polling emails:', error);
      return res.status(500).json({ error: 'Failed to poll emails' });
    }
  };
  
  // Function to send email updates to Discord webhook
  export const sendToDiscord = async (webhookUrl, emailData) => {
    try {
      const payload = {
        content: null,
        embeds: [
          {
            title: `Job Update: ${emailData.subject}`,
            description: emailData.snippet,
            color: 5814783,
            fields: [
              {
                name: "From",
                value: emailData.from,
                inline: true
              },
              {
                name: "Status",
                value: emailData.jobStatus || "New",
                inline: true
              },
              {
                name: "Date",
                value: new Date(emailData.date).toLocaleString(),
                inline: true
              }
            ],
            footer: {
              text: "Job Application Tracker"
            }
          }
        ]
      };
  
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
  
      if (!response.ok) {
        throw new Error(`Discord webhook failed: ${response.status}`);
      }
    } catch (error) {
      console.error('Error sending to Discord:', error);
      throw error;
    }
  };
  
  // Function to save email updates to Supabase
  export const saveToSupabase = async (userId, emailData) => {
    try {
      // Assuming you have a Supabase client setup
      const { createClient } = require('@supabase/supabase-js');
      
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_KEY
      );
      
      // Insert job update into Supabase
      const { data, error } = await supabase
        .from('job_updates')
        .insert([
          {
            user_id: userId,
            email_id: emailData.id,
            subject: emailData.subject,
            from: emailData.from,
            snippet: emailData.snippet,
            job_status: emailData.jobStatus || "New",
            date: emailData.date,
            full_content: emailData.content
          }
        ]);
        
      if (error) {
        throw error;
      }
      
      return data;
    } catch (error) {
      console.error('Error saving to Supabase:', error);
      throw error;
    }
  };