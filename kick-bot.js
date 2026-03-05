const WebSocket = require('ws');
const fetch = require('node-fetch');
require('dotenv').config();

// Config
const KICK_CHANNEL = 'r2ktwo';
const BOT_USERNAME = 'CodeR2K2';
const R2K2_API_URL = process.env.R2K2_API_URL; // e.g. https://r2k2.gg
const BOT_OAUTH_TOKEN = process.env.KICK_OAUTH_TOKEN;
const KICK_CHATROOMID = process.env.KICK_CHATROOM_ID; // numeric chatroom ID

let ws;
let reconnectDelay = 5000;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function sendChatMessage(message) {
  try {
    const res = await fetch(`https://kick.com/api/v2/messages/send/${KICK_CHATROOMID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BOT_OAUTH_TOKEN}`,
      },
      body: JSON.stringify({ content: message, type: 'message' }),
    });
    if (!res.ok) {
      const err = await res.text();
      log(`[chat] Failed to send message: ${res.status} ${err}`);
    }
  } catch (error) {
    log(`[chat] Error sending message: ${error.message}`);
  }
}

async function handleVerify(kickUsername, accountId) {
  log(`[verify] ${kickUsername} attempting to verify with ${accountId}`);

  try {
    const res = await fetch(`${R2K2_API_URL}/api/kick/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: accountId, kick_username: kickUsername }),
    });

    if (res.ok) {
      log(`[verify] ✅ ${kickUsername} linked to ${accountId}`);
      await sendChatMessage(`@${kickUsername} ✅ Your Kick account has been linked to R2K2.gg account ${accountId}! You'll now earn points while watching. 🎉`);
    } else if (res.status === 404) {
      log(`[verify] ❌ Account not found: ${accountId}`);
      await sendChatMessage(`@${kickUsername} ❌ Account ID ${accountId} not found. Make sure you copied it correctly from your R2K2.gg profile.`);
    } else if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      if (data.error === 'kick_already_linked') {
        log(`[verify] ❌ Kick username already linked: ${kickUsername}`);
        await sendChatMessage(`@${kickUsername} ❌ Your Kick account is already linked to an R2K2.gg account.`);
      } else {
        log(`[verify] ❌ Account ID already linked: ${accountId}`);
        await sendChatMessage(`@${kickUsername} ❌ That account ID is already linked to a different Kick account.`);
      }
    } else {
      log(`[verify] ❌ Unexpected error: ${res.status}`);
      await sendChatMessage(`@${kickUsername} ❌ Something went wrong. Please try again later.`);
    }
  } catch (error) {
    log(`[verify] Error calling API: ${error.message}`);
    await sendChatMessage(`@${kickUsername} ❌ Something went wrong. Please try again later.`);
  }
}

function handleMessage(data) {
  try {
    const parsed = JSON.parse(data);

    // Only handle chat messages
    if (parsed.event !== 'App\\Events\\ChatMessageEvent') return;

    const payload = JSON.parse(parsed.data);
    const username = payload?.sender?.username;
    const content = payload?.content?.trim();

    if (!username || !content) return;

    // Ignore messages from the bot itself
    if (username.toLowerCase() === BOT_USERNAME.toLowerCase()) return;

    log(`[chat] ${username}: ${content}`);

    // Handle !verify command
    const verifyMatch = content.match(/^!verify\s+(R2K2-[A-Z0-9]{5})$/i);
    if (verifyMatch) {
      const accountId = verifyMatch[1].toUpperCase();
      handleVerify(username, accountId);
      return;
    }

    // Handle !points command (placeholder for later)
    if (content.toLowerCase() === '!points') {
      sendChatMessage(`@${username} Points system coming soon! Link your account with !verify R2K2-XXXXX`);
      return;
    }

    // Handle !help command
    if (content.toLowerCase() === '!help' || content.toLowerCase() === '!r2k2') {
      sendChatMessage(`@${username} 👋 Create an account at r2k2.gg, get your account ID, then type !verify R2K2-XXXXX here to link and earn points!`);
      return;
    }

  } catch (error) {
    log(`[ws] Error parsing message: ${error.message}`);
  }
}

function connect() {
  log(`[ws] Connecting to Kick chat for channel: ${KICK_CHANNEL}`);

  ws = new WebSocket('wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=7.6.0&flash=false');

  ws.on('open', () => {
    log('[ws] Connected to Pusher');
    reconnectDelay = 5000;

    // Subscribe to channel chat
    ws.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: { auth: '', channel: `chatrooms.${KICK_CHATROOMID}.v2` }
    }));

    log(`[ws] Subscribed to chatroom ${KICK_CHATROOMID}`);

    // Ping every 30s to keep connection alive
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
      }
    }, 30000);
  });

  ws.on('message', (data) => {
    const str = data.toString();

    // Respond to pong
    if (str.includes('pusher:pong')) return;

    handleMessage(str);
  });

  ws.on('close', () => {
    log(`[ws] Connection closed. Reconnecting in ${reconnectDelay / 1000}s...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000); // exponential backoff, max 60s
  });

  ws.on('error', (error) => {
    log(`[ws] Error: ${error.message}`);
  });
}

// Start
log(`[boot] R2K2 Kick Bot starting...`);
log(`[boot] Channel: ${KICK_CHANNEL}`);
log(`[boot] Bot: ${BOT_USERNAME}`);
log(`[boot] API URL: ${R2K2_API_URL}`);
log(`[boot] Chatroom ID: ${KICK_CHATROOMID}`);
log(`[boot] OAuth token set: ${!!BOT_OAUTH_TOKEN}`);

connect();
