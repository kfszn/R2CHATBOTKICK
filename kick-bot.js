const fetch = require('node-fetch');
require('dotenv').config();

// Config
const BOT_USERNAME = 'CodeR2K2';
const R2K2_API_URL = process.env.R2K2_API_URL;
let KICK_ACCESS_TOKEN = process.env.KICK_ACCESS_TOKEN;
let KICK_REFRESH_TOKEN = process.env.KICK_REFRESH_TOKEN;
const BOT_SECRET = process.env.BOT_SECRET || '';
const PORT = process.env.PORT || 3001;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

log(`[boot] R2K2 Kick Message Sender starting...`);
log(`[boot] Bot: ${BOT_USERNAME}`);
log(`[boot] API URL: ${R2K2_API_URL}`);
log(`[boot] Access token set: ${!!KICK_ACCESS_TOKEN}`);
log(`[boot] Bot secret set: ${!!BOT_SECRET}`);

// ─── AUTH ─────────────────────────────────────────────────────────────────────

async function refreshAccessToken() {
  try {
    const res = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.KICK_CLIENT_ID,
        client_secret: process.env.KICK_CLIENT_SECRET,
        refresh_token: KICK_REFRESH_TOKEN
      })
    });
    if (res.ok) {
      const data = await res.json();
      KICK_ACCESS_TOKEN = data.access_token;
      KICK_REFRESH_TOKEN = data.refresh_token;
      log(`[auth] Token refreshed successfully`);
      return true;
    } else {
      log(`[auth] Failed to refresh token: ${res.status}`);
      return false;
    }
  } catch (error) {
    log(`[auth] Error refreshing token: ${error.message}`);
    return false;
  }
}

// ─── SEND CHAT MESSAGE ────────────────────────────────────────────────────────

async function sendChatMessage(message) {
  try {
    const res = await fetch('https://api.kick.com/public/v1/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KICK_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        broadcaster_user_id: 1267794,
        content: message,
        type: 'bot'
      }),
    });
    if (res.status === 401) {
      log(`[chat] Token expired, refreshing...`);
      const refreshed = await refreshAccessToken();
      if (!refreshed) return false;
      const retry = await fetch('https://api.kick.com/public/v1/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${KICK_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          broadcaster_user_id: 1267794,
          content: message,
          type: 'bot'
        }),
      });
      if (!retry.ok) {
        const err = await retry.text();
        log(`[chat] Failed after refresh: ${retry.status} ${err}`);
        return false;
      }
      return true;
    } else if (!res.ok) {
      const err = await res.text();
      log(`[chat] Failed to send message: ${res.status} ${err}`);
      return false;
    }
    log(`[chat] Sent: ${message.substring(0, 80)}...`);
    return true;
  } catch (error) {
    log(`[chat] Error sending message: ${error.message}`);
    return false;
  }
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
// Receives requests from the site webhook handler to send chat messages

const http = require('http');

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/send') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { message, secret } = JSON.parse(body);
        if (secret !== BOT_SECRET) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        if (!message) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'message required' }));
          return;
        }
        const success = await sendChatMessage(message);
        res.writeHead(success ? 200 : 500);
        res.end(JSON.stringify({ success }));
      } catch (err) {
        log(`[server] Error: ${err.message}`);
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'invalid request' }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', bot: BOT_USERNAME }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(PORT, () => {
  log(`[server] Message sender listening on port ${PORT}`);
});
