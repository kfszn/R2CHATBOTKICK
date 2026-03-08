const WebSocket = require('ws');
const fetch = require('node-fetch');
require('dotenv').config();

// Config
const KICK_CHANNEL = 'r2ktwo';
const BOT_USERNAME = 'CodeR2K2';
const R2K2_API_URL = process.env.R2K2_API_URL;
const BOT_OAUTH_TOKEN = process.env.KICK_OAUTH_TOKEN;
const KICK_CHATROOMID = process.env.KICK_CHATROOM_ID;

let ws;
let reconnectDelay = 5000;

// Points config (loaded from API on startup)
let POINTS_PER_MESSAGE = 1;
let POINTS_PER_10MIN = 1;

// Stream state
let isLive = false;
let streamCheckInterval = null;
let watchTimeInterval = null;

// Track chatters this stream session
// { kick_username: { messageCount: 0 } }
const sessionChatters = {};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── API CALLS ───────────────────────────────────────────────────────────────

async function loadSettings() {
  try {
    const res = await fetch(`${R2K2_API_URL}/api/settings`);
    if (res.ok) {
      const data = await res.json();
      POINTS_PER_MESSAGE = data.points_per_message || 1;
      POINTS_PER_10MIN = data.points_per_10min_watch || 1;
      log(`[settings] Loaded — msg: ${POINTS_PER_MESSAGE}pt, 10min: ${POINTS_PER_10MIN}pt`);
    }
  } catch (error) {
    log(`[settings] Failed to load, using defaults: ${error.message}`);
  }
}

async function awardPoints(kickUsername, points, type, description) {
  try {
    const res = await fetch(`${R2K2_API_URL}/api/points/award`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kick_username: kickUsername, points, type, description }),
    });
    if (!res.ok) {
      const err = await res.text();
      log(`[points] Failed to award ${points}pt to ${kickUsername}: ${err}`);
    } else {
      log(`[points] +${points}pt to ${kickUsername} (${type})`);
    }
  } catch (error) {
    log(`[points] Error awarding points to ${kickUsername}: ${error.message}`);
  }
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

async function checkStreamLive() {
  try {
    const res = await fetch(`https://kick.com/api/v2/channels/${KICK_CHANNEL}`);
    log(`[stream] Check status: ${res.status}`);
    if (res.ok) {
      const data = await res.json();
      const wasLive = isLive;
      isLive = data.livestream !== null;
      log(`[stream] isLive: ${isLive}`);
      if (!wasLive && isLive) {
        log(`[stream] Stream went LIVE — starting new session`);
        onStreamStart();
      } else if (wasLive && !isLive) {
        log(`[stream] Stream went OFFLINE — ending session`);
        onStreamEnd();
      }
    } else {
      log(`[stream] Bad status ${res.status} — defaulting isLive to true`);
      if (!isLive) { isLive = true; onStreamStart(); }
    }
  } catch (error) {
    log(`[stream] Error: ${error.message} — defaulting isLive to true`);
    if (!isLive) { isLive = true; onStreamStart(); }
  }
}

// ─── STREAM SESSION ──────────────────────────────────────────────────────────

function onStreamStart() {
  // Clear previous session chatters
  Object.keys(sessionChatters).forEach(k => delete sessionChatters[k]);

  // Award watch time points every 10 minutes to qualifying chatters (3+ messages)
  watchTimeInterval = setInterval(() => {
    const qualifying = Object.entries(sessionChatters)
      .filter(([_, data]) => data.messageCount >= 3)
      .map(([username]) => username);

    log(`[watchtime] Awarding ${POINTS_PER_10MIN}pt to ${qualifying.length} qualifying chatters`);

    for (const username of qualifying) {
      awardPoints(username, POINTS_PER_10MIN, 'watch_time', 'Watch time bonus (10 min)');
    }
  }, 10 * 60 * 1000);
}

function onStreamEnd() {
  if (watchTimeInterval) {
    clearInterval(watchTimeInterval);
    watchTimeInterval = null;
  }
  Object.keys(sessionChatters).forEach(k => delete sessionChatters[k]);
}

// ─── CHAT HANDLERS ───────────────────────────────────────────────────────────

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
      await sendChatMessage(`@${kickUsername} ✅ Your Kick account has been linked to R2K2.gg! You'll now earn points while watching. 🎉`);
    } else if (res.status === 404) {
      await sendChatMessage(`@${kickUsername} ❌ Account ID ${accountId} not found. Make sure you copied it correctly from your R2K2.gg profile page.`);
    } else if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      if (data.error === 'kick_already_linked') {
        await sendChatMessage(`@${kickUsername} ❌ Your Kick account is already linked to an R2K2.gg account.`);
      } else {
        await sendChatMessage(`@${kickUsername} ❌ That account ID is already linked to a different Kick account.`);
      }
    } else {
      await sendChatMessage(`@${kickUsername} ❌ Something went wrong. Please try again later.`);
    }
  } catch (error) {
    log(`[verify] Error: ${error.message}`);
    await sendChatMessage(`@${kickUsername} ❌ Something went wrong. Please try again later.`);
  }
}

async function handleChatPoints(kickUsername) {
  // Track chatter in session
  if (!sessionChatters[kickUsername]) {
    sessionChatters[kickUsername] = { messageCount: 0 };
  }
  sessionChatters[kickUsername].messageCount++;
  log(`[points] ${kickUsername} msg #${sessionChatters[kickUsername].messageCount}, isLive: ${isLive}`);

  // Award points per message only when stream is live
  if (isLive && POINTS_PER_MESSAGE > 0) {
    await awardPoints(kickUsername, POINTS_PER_MESSAGE, 'chat_message', 'Chat message');
  }
}

function handleMessage(data) {
  try {
    const parsed = JSON.parse(data);
    if (parsed.event !== 'App\\Events\\ChatMessageEvent') return;

    const payload = JSON.parse(parsed.data);
    const username = payload?.sender?.username;
    const content = payload?.content?.trim();

    if (!username || !content) return;
    if (username.toLowerCase() === BOT_USERNAME.toLowerCase()) return;

    log(`[chat] ${username}: ${content}`);

    // !verify command
    const verifyMatch = content.match(/^!verify\s+(R2K2-[A-Z0-9]{5})$/i);
    if (verifyMatch) {
      handleVerify(username, verifyMatch[1].toUpperCase());
      return;
    }

    // !points command
    if (content.toLowerCase() === '!points') {
      try {
        const res = await fetch(`${R2K2_API_URL}/api/points/balance?kick_username=${encodeURIComponent(username)}`);
        if (res.ok) {
          const data = await res.json();
          sendChatMessage(`@${username} 🏆 You have ${data.points.toLocaleString()} R2K2 points! Redeem them at www.r2k2.gg/shop`);
        } else if (res.status === 404) {
          sendChatMessage(`@${username} ❌ Your Kick account is not linked to an R2K2.gg account. Sign up at www.r2k2.gg and type !verify R2K2-XXXXX to link.`);
        } else {
          sendChatMessage(`@${username} ❌ Something went wrong. Try again later.`);
        }
      } catch (error) {
        log(`[points] Error fetching balance for ${username}: ${error.message}`);
        sendChatMessage(`@${username} ❌ Something went wrong. Try again later.`);
      }
      return;
    }

    // !help / !r2k2 command
    if (content.toLowerCase() === '!help' || content.toLowerCase() === '!r2k2') {
      sendChatMessage(`@${username} 👋 Create an account at www.r2k2.gg, get your account ID, then type !verify R2K2-XXXXX here to link and start earning points!`);
      return;
    }

    // Award chat points
    handleChatPoints(username);

  } catch (error) {
    log(`[ws] Error parsing message: ${error.message}`);
  }
}

// ─── WEBSOCKET ───────────────────────────────────────────────────────────────

function connect() {
  log(`[ws] Connecting to Kick chat for channel: ${KICK_CHANNEL}`);

  ws = new WebSocket('wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=7.6.0&flash=false');

  ws.on('open', () => {
    log('[ws] Connected to Pusher');
    reconnectDelay = 5000;

    ws.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: { auth: '', channel: `chatrooms.${KICK_CHATROOMID}.v2` }
    }));

    log(`[ws] Subscribed to chatroom ${KICK_CHATROOMID}`);

    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
      }
    }, 30000);
  });

  ws.on('message', (data) => {
    const str = data.toString();
    if (str.includes('pusher:pong')) return;
    handleMessage(str);
  });

  ws.on('close', () => {
    log(`[ws] Connection closed. Reconnecting in ${reconnectDelay / 1000}s...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  });

  ws.on('error', (error) => {
    log(`[ws] Error: ${error.message}`);
  });
}

// ─── BOOT ────────────────────────────────────────────────────────────────────

async function boot() {
  log(`[boot] R2K2 Kick Bot starting...`);
  log(`[boot] Channel: ${KICK_CHANNEL}`);
  log(`[boot] Bot: ${BOT_USERNAME}`);
  log(`[boot] API URL: ${R2K2_API_URL}`);
  log(`[boot] Chatroom ID: ${KICK_CHATROOMID}`);
  log(`[boot] OAuth token set: ${!!BOT_OAUTH_TOKEN}`);

  await loadSettings();
  await checkStreamLive();
  streamCheckInterval = setInterval(checkStreamLive, 2 * 60 * 1000);

  connect();
}

boot();
