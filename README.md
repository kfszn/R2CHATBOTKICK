# Kick Slot Tracker Bot

This bot monitors the R2ktwo Kick channel for `!call SlotName` commands and sends them to the R2K2.gg API.

## How to Deploy to Railway

### 1. Create a new GitHub repository
1. Go to GitHub and create a new repository (e.g., `kick-slot-bot`)
2. Upload these files:
   - `kick-bot.js`
   - `package.json` (rename kick-bot-package.json to package.json)

### 2. Deploy to Railway
1. Go to [railway.app](https://railway.app)
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose your `kick-slot-bot` repository
5. Railway will auto-detect it's a Node.js project

### 3. Set Environment Variables
In Railway project settings, add these environment variables:

**Required:**
- `API_ENDPOINT` = `https://r2k2.gg/api/slot-calls`

**Optional (if bot needs authentication later):**
- `KICK_USERNAME` = `CodeR2K2`
- `KICK_PASSWORD` = `your-password-here`
- `KICK_CHANNEL` = `R2ktwo`

### 4. Deploy
Railway will automatically:
- Install dependencies (`npm install`)
- Start the bot (`npm start`)
- Keep it running 24/7

## How it Works

1. Bot connects to Kick chat for channel `R2ktwo`
2. Listens for messages starting with `!call`
3. When it sees `!call GatesOfOlympus`, it extracts:
   - Username: (whoever typed it)
   - Slot Name: `GatesOfOlympus`
4. Sends POST request to `https://r2k2.gg/api/slot-calls`:
```json
{
  "username": "viewer123",
  "slotName": "GatesOfOlympus",
  "type": "call",
  "timestamp": "2026-02-15T20:30:00.000Z"
}
```

## Testing Locally

```bash
# Install dependencies
npm install

# Set environment variable
export API_ENDPOINT=https://r2k2.gg/api/slot-calls

# Run bot
npm start
```

## Logs
You'll see output like:
```
=== Kick Bot Starting ===

Getting channel info for R2ktwo...
✓ Channel ID: 12345
✓ Chatroom ID: 67890
Connecting to Kick chat...
✓ WebSocket connected
✓ Subscribed to chatrooms.67890.v2
🤖 Bot is now listening for !call commands...

📢 viewer123 called: GatesOfOlympus
✓ Sent to API: viewer123 | GatesOfOlympus
```

## Commands Supported

Currently:
- `!call SlotName` - Tracks a slot call

Coming soon:
- `!bonus SlotName` - Tracks a bonus buy
- `!hunt SlotName` - Tracks a bonus hunt
