const WebSocket = require('ws');
const fetch = require('node-fetch');
require('dotenv').config();

// Config
const KICK_CHANNEL = 'r2ktwo';
const KICK_CHANNEL_SLUG = 'r2ktwo';
const BOT_USERNAME = 'CodeR2K2';
const R2K2_API_URL = process.env.R2K2_API_URL;
let KICK_ACCESS_TOKEN = process.env.KICK_ACCESS_TOKEN;
let KICK_REFRESH_TOKEN = process.env.KICK_REFRESH_TOKEN;
const KICK_CHATROOMID = process.env.KICK_CHATROOM_ID;
const BOT_SECRET = process.env.BOT_SECRET || '';

let ws;
let reconnectDelay = 5000;

// Points config
const POINTS_PER_MESSAGE = 1;
const POINTS_PER_EMOTE = 0.2;

// ─── COMMAND & TIMER CACHE ────────────────────────────────────────────────────
let commandCache = [];
let timerCache = [];
let lastCommandFetch = 0;
const COMMAND_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
const commandCooldowns = new Map(); // key: `${command}:${username}`, value: timestamp
const globalCooldowns = new Map(); // key: command, value: last fired timestamp

async function fetchCommands() {
  try {
    const res = await fetch(`${R2K2_API_URL}/api/bot/commands`, {
      headers: { 'x-bot-secret': BOT_SECRET }
    });
    if (res.ok) {
      const data = await res.json();
      commandCache = data.commands || [];
      timerCache = data.timers || [];
      lastCommandFetch = Date.now();
      log(`[commands] Loaded ${commandCache.length} commands, ${timerCache.length} timers`);
    }
  } catch (error) {
    log(`[commands] Failed to fetch: ${error.message}`);
  }
}

async function fetchCommandsIfNeeded() {
  if (Date.now() - lastCommandFetch > COMMAND_CACHE_TTL) {
    await fetchCommands();
  }
}

async function handleCustomCommand(username, trigger) {
  await fetchCommandsIfNeeded();
  const cmd = commandCache.find(c => c.trigger.toLowerCase() === trigger.toLowerCase() && c.enabled);
  if (!cmd) return false;

  const cooldownMs = (cmd.cooldown_seconds || 0) * 1000;
  const globalKey = cmd.trigger;
  const userKey = `${cmd.trigger}:${username}`;
  const now = Date.now();

  // Check global cooldown
  if (cooldownMs > 0 && globalCooldowns.has(globalKey)) {
    if (now - globalCooldowns.get(globalKey) < cooldownMs) {
      log(`[commands] ${trigger} on cooldown (global)`);
      return true; // command exists but on cooldown, swallow it
    }
  }

  globalCooldowns.set(globalKey, now);
  await sendChatMessage(cmd.response);
  log(`[commands] Fired ${trigger} for ${username}`);
  return true;
}

// ─── TIMER SYSTEM ─────────────────────────────────────────────────────────────
const timerLastFired = new Map(); // key: timer id, value: timestamp

async function runTimers() {
  if (!isLive) return;
  await fetchCommandsIfNeeded();
  const now = Date.now();
  for (const timer of timerCache) {
    if (!timer.enabled) continue;
    const intervalMs = (timer.interval_minutes || 10) * 60 * 1000;
    const lastFired = timerLastFired.get(timer.id) || 0;
    if (now - lastFired >= intervalMs) {
      timerLastFired.set(timer.id, now);
      await sendChatMessage(timer.message);
      log(`[timer] Fired timer ${timer.id}: ${timer.message.substring(0, 50)}...`);
    }
  }
}


// Stream state
let isLive = false;
let lastStreamCheck = 0;
const STREAM_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── EMOTE DETECTION ─────────────────────────────────────────────────────────

function isEmoteOnly(content) {
  // Strip all Kick emotes [emote:id:name] and unicode emoji, see if anything remains
  const stripped = content
    .replace(/\[emote:\d+:\w+\]/g, '')
    .replace(/\p{Emoji_Presentation}/gu, '')
    .replace(/\p{Emoji}\uFE0F/gu, '')
    .trim();
  return stripped.length === 0;
}

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
    } else {
      log(`[auth] Failed to refresh token: ${res.status}`);
    }
  } catch (error) {
    log(`[auth] Error refreshing token: ${error.message}`);
  }
}

// ─── STREAM LIVE CHECK ───────────────────────────────────────────────────────

async function updateStreamStatus(live) {
  try {
    const res = await fetch(`${R2K2_API_URL}/api/bot/stream-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isLive: live, botSecret: BOT_SECRET })
    });
    if (res.ok) {
      log(`[stream] Updated site stream status: ${live}`);
    } else {
      log(`[stream] Failed to update site status: ${res.status}`);
    }
  } catch (error) {
    log(`[stream] Error updating site status: ${error.message}`);
  }
}

async function checkStreamLiveIfNeeded() {
  const now = Date.now();
  if (now - lastStreamCheck < STREAM_CHECK_INTERVAL) return;
  lastStreamCheck = now;
  await checkStreamLive();
}

async function checkStreamLive() {
  try {
    const res = await fetch(`${R2K2_API_URL}/api/stream/status`);
    if (res.ok) {
      const data = await res.json();
      const wasLive = isLive;
      isLive = data.isLive === true;
      if (!wasLive && isLive) { log(`[stream] Went LIVE — chatter points enabled`); }
      if (wasLive && !isLive) { log(`[stream] Went OFFLINE — chatter points disabled`); }
      log(`[stream] isLive: ${isLive}`);
    } else {
      log(`[stream] Check failed ${res.status} — keeping isLive: ${isLive}`);
    }
  } catch (error) {
    log(`[stream] Error: ${error.message} — keeping isLive: ${isLive}`);
  }
}

// ─── API CALLS ───────────────────────────────────────────────────────────────

async function loadSettings() {
  try {
    const res = await fetch(`${R2K2_API_URL}/api/settings`);
    if (res.ok) {
      const data = await res.json();
      log(`[settings] Loaded — msg: ${POINTS_PER_MESSAGE}pt, emote: ${POINTS_PER_EMOTE}pt`);
    }
  } catch (error) {
    log(`[settings] Failed to load: ${error.message}`);
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
      try {
        const parsed = JSON.parse(err);
        if (parsed.reason !== 'not_found') {
          log(`[points] Failed to award ${points}pt to ${kickUsername}: ${err}`);
        } else {
          log(`[points] skip ${kickUsername} (no account)`);
        }
      } catch {
        log(`[points] Failed to award ${points}pt to ${kickUsername}: ${err}`);
      }
    } else {
      log(`[points] +${points}pt to ${kickUsername} (${type})`);
    }
  } catch (error) {
    log(`[points] Error awarding points to ${kickUsername}: ${error.message}`);
  }
}

async function awardChatterPoints(kickUsername, points, type) {
  try {
    const res = await fetch(`${R2K2_API_URL}/api/bot/chatter-points`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kickUsername, points, type, botSecret: BOT_SECRET }),
    });
    if (res.ok) {
      log(`[chatter] +${points}pt to ${kickUsername} (${type})`);
    } else {
      const err = await res.text();
      log(`[chatter] Failed for ${kickUsername}: ${err}`);
    }
  } catch (error) {
    log(`[chatter] Error for ${kickUsername}: ${error.message}`);
  }
}

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
      await refreshAccessToken();
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
      }
    } else if (!res.ok) {
      const err = await res.text();
      log(`[chat] Failed to send message: ${res.status} ${err}`);
    }
  } catch (error) {
    log(`[chat] Error sending message: ${error.message}`);
  }
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

async function handleEntry(kickUsername, acebetUsername) {
  log(`[entry] ${kickUsername} entering tournament as ${acebetUsername}`);
  try {
    const res = await fetch(`${R2K2_API_URL}/api/bot/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kickUsername, acebetUsername, botSecret: BOT_SECRET }),
    });
    const data = await res.json();
    const msg = data.message || (res.ok ? '✅ You have been entered into the tournament!' : '❌ Something went wrong. Try again later.');
    await sendChatMessage(`@${kickUsername} ${msg}`);
    log(`[entry] Response for ${kickUsername}: ${msg}`);
  } catch (error) {
    log(`[entry] Error for ${kickUsername}: ${error.message}`);
    await sendChatMessage(`@${kickUsername} ❌ Something went wrong. Try again later.`);
  }
}

async function handleSlotRequest(kickUsername, slotName) {
  log(`[request] ${kickUsername} requesting slot: ${slotName}`);
  try {
    const res = await fetch(`${R2K2_API_URL}/api/bot/slot-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kickUsername, slotName, botSecret: BOT_SECRET }),
    });
    const data = await res.json();
    const msg = data.message || (res.ok ? '✅ Your slot call has been added!' : '❌ Something went wrong. Try again later.');
    await sendChatMessage(`@${kickUsername} ${msg}`);
    log(`[request] Response for ${kickUsername}: ${msg}`);
  } catch (error) {
    log(`[request] Error for ${kickUsername}: ${error.message}`);
    await sendChatMessage(`@${kickUsername} ❌ Something went wrong. Try again later.`);
  }
}

async function handleGTB(kickUsername, guess) {
  const amount = parseFloat(guess.replace(/[$,]/g, ''));
  if (isNaN(amount) || amount < 0) {
    await sendChatMessage(`@${kickUsername} ❌ Invalid guess. Use !gtb [amount] e.g. !gtb 1250 or !gtb 1250.50`);
    return;
  }
  log(`[gtb] ${kickUsername} guessing balance: $${amount}`);
  try {
    const res = await fetch(`${R2K2_API_URL}/api/bot/predictions/gtb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kickUsername, guess: amount, botSecret: BOT_SECRET }),
    });
    const data = await res.json();
    if (res.ok) {
      const isUpdate = data.updated;
      await sendChatMessage(`@${kickUsername} ${isUpdate ? '🔄 Updated' : '✅ Locked in'} — Balance guess: $${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 💰`);
    } else if (res.status === 403) {
      await sendChatMessage(`@${kickUsername} ❌ Guessing is currently closed!`);
    } else {
      await sendChatMessage(`@${kickUsername} ❌ Something went wrong. Try again later.`);
    }
  } catch (error) {
    log(`[gtb] Error for ${kickUsername}: ${error.message}`);
    await sendChatMessage(`@${kickUsername} ❌ Something went wrong. Try again later.`);
  }
}

async function handleGTM(kickUsername, guess) {
  const multi = parseFloat(guess.replace(/[x,]/gi, ''));
  if (isNaN(multi) || multi < 0) {
    await sendChatMessage(`@${kickUsername} ❌ Invalid guess. Use !gtm [multiplier] e.g. !gtm 45.5 or !gtm 100`);
    return;
  }
  log(`[gtm] ${kickUsername} guessing multi: ${multi}x`);
  try {
    const res = await fetch(`${R2K2_API_URL}/api/bot/predictions/gtm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kickUsername, guess: multi, botSecret: BOT_SECRET }),
    });
    const data = await res.json();
    if (res.ok) {
      const isUpdate = data.updated;
      await sendChatMessage(`@${kickUsername} ${isUpdate ? '🔄 Updated' : '✅ Locked in'} — Multi guess: ${multi}x 🎰`);
    } else if (res.status === 403) {
      await sendChatMessage(`@${kickUsername} ❌ Guessing is currently closed!`);
    } else {
      await sendChatMessage(`@${kickUsername} ❌ Something went wrong. Try again later.`);
    }
  } catch (error) {
    log(`[gtm] Error for ${kickUsername}: ${error.message}`);
    await sendChatMessage(`@${kickUsername} ❌ Something went wrong. Try again later.`);
  }
}

async function handleMessage(data) {
  try {
    const parsed = JSON.parse(data);
    if (parsed.event !== 'App\\Events\\ChatMessageEvent') return;

    const payload = JSON.parse(parsed.data);
    const username = payload?.sender?.username;
    const content = payload?.content?.trim();

    if (!username || !content) return;
    if (username.toLowerCase() === BOT_USERNAME.toLowerCase()) return;

    log(`[chat] ${username}: ${content}`);

    // Check stream status on message activity (cached 5 min)
    checkStreamLiveIfNeeded();

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

    // !entry [acebet_username] command
    const entryMatch = content.match(/^!entry\s+(\S+)$/i);
    if (entryMatch) {
      handleEntry(username, entryMatch[1]);
      return;
    }

    // !request [slot name] command
    const requestMatch = content.match(/^!request\s+(.+)$/i);
    if (requestMatch) {
      handleSlotRequest(username, requestMatch[1].trim());
      return;
    }

    // !gtb [amount] — Guess The Balance
    const gtbMatch = content.match(/^!gtb\s+([\d.,\$]+)$/i);
    if (gtbMatch) {
      handleGTB(username, gtbMatch[1]);
      return;
    }

    // !gtm [multi] — Guess The Multi
    const gtmMatch = content.match(/^!gtm\s+([\d.,x]+)$/i);
    if (gtmMatch) {
      handleGTM(username, gtmMatch[1]);
      return;
    }

    // ─── CUSTOM COMMANDS ──────────────────────────────────────────────────────
    if (content.startsWith('!')) {
      const trigger = content.split(' ')[0].toLowerCase();
      const handled = await handleCustomCommand(username, trigger);
      if (handled) return;
    }

    // ─── SITE GIVEAWAY KEYWORD ────────────────────────────────────────────────
    // Check if content matches active giveaway keyword (silent entry)
    try {
      const res = await fetch(`${R2K2_API_URL}/api/bot/giveaway/enter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kickUsername: username, message: content, botSecret: BOT_SECRET }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.entered) {
          log(`[giveaway] ${username} entered via keyword`);
        }
      }
    } catch (error) {
      log(`[giveaway] Error checking keyword for ${username}: ${error.message}`);
    }

    // ─── CHATTER POINTS (always active) ──────────────────────────────────────
    const emoteOnly = isEmoteOnly(content);
    const pts = emoteOnly ? POINTS_PER_EMOTE : POINTS_PER_MESSAGE;
    const type = emoteOnly ? 'emote' : 'message';

    // Award shop points (linked users only)
    awardPoints(username, pts, 'chat_message', emoteOnly ? 'Emote message' : 'Chat message');

    // Award chatter leaderboard points (all chatters)
    awardChatterPoints(username, pts, type);

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

  ws.on('close', (code, reason) => {
    log(`[ws] Connection closed. Code: ${code} Reason: ${reason?.toString() || 'none'} Reconnecting in ${reconnectDelay / 1000}s...`);
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
  log(`[boot] Access token set: ${!!KICK_ACCESS_TOKEN}`);
  log(`[boot] Bot secret set: ${!!BOT_SECRET}`);

  await loadSettings();
  await fetchCommands(); // initial load
  setInterval(runTimers, 60 * 1000); // check timers every minute
  connect();
}

boot();
