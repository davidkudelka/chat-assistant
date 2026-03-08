# Raspberry Pi Deployment

Guide for deploying the WhatsApp Calendar Bot on a Raspberry Pi using Docker.

## Prerequisites

- Raspberry Pi with SSH access
- The bot already working locally on your dev machine (OAuth authenticated, WhatsApp linked)

## 1. Install Docker on the Pi

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

Log out and back in for the group change to take effect.

## 2. Get the project on the Pi

**Option A: Clone from GitHub** (recommended)

```bash
ssh pi@<PI_IP>
git clone git@github.com:davidkudelka/chat-assistant.git ~/chat-assistant
```

**Option B: Sync from your dev machine**

```bash
rsync -avz --exclude node_modules --exclude dist --exclude .wwebjs_auth --exclude data \
  ~/AI-Projects/chat-assistant/ pi@<PI_IP>:~/chat-assistant/
```

Replace `<PI_IP>` with your Pi's IP address and `pi` with your Pi username.

## 3. Copy credentials

The OAuth credentials and tokens need to be on the Pi so the MCP server can authenticate with Google Calendar without a browser.

```bash
# OAuth credentials JSON
scp ~/.config/gcp-oauth.keys.json pi@<PI_IP>:~/.config/gcp-oauth.keys.json

# OAuth tokens (avoids re-auth on the Pi)
scp -r ~/.config/google-calendar-mcp/ pi@<PI_IP>:~/.config/google-calendar-mcp/
```

## 4. Configure `.env` on the Pi

SSH into the Pi and edit `~/chat-assistant/.env`. Update the OAuth path to match the Pi:

```
GOOGLE_OAUTH_CREDENTIALS=/home/pi/.config/gcp-oauth.keys.json
```

Adjust `/home/pi` to your actual home directory on the Pi.

## 5. Build and start

```bash
cd ~/chat-assistant
docker compose up -d --build
```

The first build will take a while on the Pi (compiling native modules for ARM).

## 6. Scan the QR code

The first launch requires linking WhatsApp:

```bash
docker compose logs -f
```

A QR code will appear in the terminal output. Scan it with **WhatsApp > Settings > Linked Devices > Link a Device**.

After scanning, the session is saved in the `./wwebjs_auth` volume. Future restarts won't need a re-scan.

You should see:

```
✅ WhatsApp Calendar Bot is online.
✅ MCP connected.
Listening for messages...
```

Press `Ctrl+C` to stop following logs — the container continues running in the background.

## Managing the bot

```bash
docker compose logs -f          # follow live logs
docker compose restart          # restart the bot
docker compose down             # stop the bot
docker compose up -d --build    # rebuild after code changes
```

## Persisted data

All runtime data survives container rebuilds via Docker volumes:

| Volume | Container path | Contents |
|---|---|---|
| `./data/` | `/app/data/` | SQLite database (`bot.db` — gym packages, ICS tracking) |
| `./wwebjs_auth/` | `/app/.wwebjs_auth/` | WhatsApp session (no QR re-scan needed) |
| `~/.config/google-calendar-mcp/` | `/root/.config/google-calendar-mcp/` | Google OAuth tokens |

## Updating the bot

**If cloned from GitHub:**

```bash
# On the Pi
cd ~/chat-assistant
git pull
docker compose up -d --build
```

**If synced via rsync:**

```bash
# From your dev machine — sync code to Pi
rsync -avz --exclude node_modules --exclude dist --exclude .wwebjs_auth --exclude data \
  ~/AI-Projects/chat-assistant/ pi@<PI_IP>:~/chat-assistant/

# On the Pi — rebuild and restart
cd ~/chat-assistant
docker compose up -d --build
```

The WhatsApp session and database are preserved across rebuilds.

## Troubleshooting

| Issue | Fix |
|---|---|
| Build fails on ARM | Ensure `python3 make g++` are in the Dockerfile (needed for `better-sqlite3`) |
| QR code not visible | Run `docker compose logs -f` to see console output |
| OAuth token expired | Re-run auth on your dev machine, then `scp` the new tokens to the Pi |
| Bot stops responding | Check `docker compose logs --tail 50` for errors, then `docker compose restart` |
| Container keeps restarting | Check logs — likely MCP connection failure or missing env vars |
