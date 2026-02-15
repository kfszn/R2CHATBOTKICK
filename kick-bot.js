const axios = require('axios');
const WebSocket = require('ws');

// Configuration
const CONFIG = {
  kickUsername: process.env.KICK_USERNAME || 'CodeR2K2',
  kickPassword: process.env.KICK_PASSWORD,
  channelName: process.env.KICK_CHANNEL || 'R2ktwo',
  apiEndpoint: process.env.API_ENDPOINT || 'https://r2k2.gg/api/slot-calls'
};

class KickBot {
  constructor() {
    this.ws = null;
    this.channelId = null;
    this.accessToken = null;
    this.chatRoomId = null;
  }

  async authenticate() {
    try {
      console.log('Authenticating with Kick...');
      
      // Get CSRF token first
      const csrfResponse = await axios.get('https://kick.com/kick-token-provider');
      const xsrfToken = csrfResponse.headers['set-cookie']
        ?.find(cookie => cookie.startsWith('XSRF-TOKEN'))
        ?.split(';')[0]
        ?.split('=')[1];

      if (!xsrfToken) {
        throw new Error('Failed to get XSRF token');
      }

      // Login
      const loginResponse = await axios.post(
        'https://kick.com/api/v2/authentication/login',
        {
          email: CONFIG.kickUsername,
          password: CONFIG.kickPassword
        },
        {
          headers: {
            'X-XSRF-TOKEN': decodeURIComponent(xsrfToken),
            'Content-Type': 'application/json'
          },
          withCredentials: true
        }
      );

      this.accessToken = loginResponse.data.token;
      console.log('✓ Authenticated successfully');
      
      return true;
    } catch (error) {
      console.error('Authentication failed:', error.message);
      if (error.response) {
        console.error('Response data:', error.response.data);
      }
      return false;
    }
  }

  async getChannelInfo() {
    try {
      console.log(`Getting channel info for ${CONFIG.channelName}...`);
      
      const response = await axios.get(
        `https://kick.com/api/v2/channels/${CONFIG.channelName}`
      );

      this.channelId = response.data.id;
      this.chatRoomId = response.data.chatroom.id;
      
      console.log(`✓ Channel ID: ${this.channelId}`);
      console.log(`✓ Chatroom ID: ${this.chatRoomId}`);
      
      return true;
    } catch (error) {
      console.error('Failed to get channel info:', error.message);
      return false;
    }
  }

  connectToChat() {
    console.log('Connecting to Kick chat...');
    
    this.ws = new WebSocket('wss://ws-us2.pusher.com/app/eb1d5f283081a78b932c?protocol=7&client=js&version=7.4.0&flash=false');

    this.ws.on('open', () => {
      console.log('✓ WebSocket connected');
      
      // Subscribe to chat channel
      const subscribeMessage = {
        event: 'pusher:subscribe',
        data: {
          auth: '',
          channel: `chatrooms.${this.chatRoomId}.v2`
        }
      };
      
      this.ws.send(JSON.stringify(subscribeMessage));
      console.log(`✓ Subscribed to chatrooms.${this.chatRoomId}.v2`);
      console.log('🤖 Bot is now listening for !call commands...\n');
    });

    this.ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data);
        
        // DEBUG: Log all events to see what we're getting
        if (message.event && !message.event.includes('pusher:ping')) {
          console.log('📨 Event received:', message.event);
        }
        
        // Handle different message types
        if (message.event === 'pusher:connection_established') {
          console.log('✓ Pusher connection established');
        } else if (message.event === 'pusher_internal:subscription_succeeded') {
          console.log('✓ Successfully subscribed to chat');
        } else if (message.event === 'App\\Events\\ChatMessageEvent') {
          console.log('💬 Chat message detected!');
          await this.handleChatMessage(message.data);
        }
      } catch (error) {
        console.error('Error processing message:', error.message);
      }
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error.message);
    });

    this.ws.on('close', () => {
      console.log('WebSocket closed. Reconnecting in 5 seconds...');
      setTimeout(() => this.connectToChat(), 5000);
    });

    // Send ping every 30 seconds to keep connection alive
    setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
      }
    }, 30000);
  }

  async handleChatMessage(data) {
    try {
      const messageData = typeof data === 'string' ? JSON.parse(data) : data;
      const content = messageData.content?.trim();
      const username = messageData.sender?.username;

      if (!content || !username) return;

      // Check if message starts with !call
      if (content.toLowerCase().startsWith('!call ')) {
        const slotName = content.substring(6).trim(); // Remove "!call "
        
        if (!slotName) {
          console.log(`⚠️  ${username} used !call but didn't specify a slot name`);
          return;
        }

        console.log(`📢 ${username} called: ${slotName}`);
        
        // Send to API
        await this.sendToAPI(username, slotName);
      }
    } catch (error) {
      console.error('Error handling chat message:', error.message);
    }
  }

  async sendToAPI(username, slotName) {
    try {
      const payload = {
        username: username,
        slotName: slotName,
        type: 'call',
        timestamp: new Date().toISOString()
      };

      const response = await axios.post(CONFIG.apiEndpoint, payload, {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      console.log(`✓ Sent to API: ${username} | ${slotName}`);
      
    } catch (error) {
      console.error('Failed to send to API:', error.message);
      if (error.response) {
        console.error('API Response:', error.response.data);
      }
    }
  }

  async start() {
    console.log('=== Kick Bot Starting ===\n');
    
    // Get channel info (no auth needed for public channels)
    const channelSuccess = await this.getChannelInfo();
    if (!channelSuccess) {
      console.error('Failed to get channel info. Exiting.');
      process.exit(1);
    }

    // Connect to chat
    this.connectToChat();
  }
}

// Validate required environment variables
if (!CONFIG.apiEndpoint) {
  console.error('ERROR: API_ENDPOINT environment variable is required');
  process.exit(1);
}

// Start the bot
const bot = new KickBot();
bot.start();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nShutting down bot...');
  if (bot.ws) {
    bot.ws.close();
  }
  process.exit(0);
});
