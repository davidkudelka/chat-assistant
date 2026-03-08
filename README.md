# WhatsApp Calendar Bot (AI-Powered, Cross-Platform)

An agentic WhatsApp bot that uses **Claude + Google Calendar MCP** to schedule and manage meetings — even when attendees use **different calendar apps** (Google Calendar, Apple Calendar, Outlook). Includes **gym session package tracking** with SQLite persistence.

## Architecture

```
WhatsApp (message_create)
       │
       ▼
  whatsapp-web.js         ← listens for "@bot ..." messages
       │
       ▼
  Claude Agent (Sonnet)   ← agentic loop, decides what tools to call
       │
       ├──► Google Calendar MCP   ← create/list/update/delete events (via @modelcontextprotocol/sdk)
       ├──► lookup_person         ← check registry + calendar provider
       ├──► send_ics_invite       ← send .ics email via Resend to Apple/Outlook users
       ├──► gym_buy_sessions      ← register prepaid gym session package
       ├──► gym_use_session       ← track session usage (3/10, etc.)
       └──► gym_get_remaining     ← check remaining sessions
       │
       ▼
  SQLite (better-sqlite3)  ← persists gym packages, session logs, ICS event tracking
```

### How Cross-Platform Scheduling Works

The event lives on **Google Calendar** (as the source of truth). Cross-platform delivery works because:

1. **Google Calendar users** — Google auto-adds the event when they're listed as an attendee
2. **Apple Calendar / Outlook users** — receive an email invite with an `.ics` attachment via Resend

No separate Apple/iCloud API integration is needed. The iCalendar (`.ics`) standard is universal.

## What It Can Do

**Schedule between people:**
```
@bot schedule a 1-on-1 between Alice and Bob tomorrow at 2pm
@bot set up a 30-min sync with Alice next Monday at 10am
```

**Query meetings:**
```
@bot what meetings do Alice and Bob have this week?
@bot show me Alice's schedule for Friday
```

**Manage events:**
```
@bot cancel the standup on Friday
@bot move the Alice/Bob sync to 3pm
```

**Gym training sessions:**
```
@bot buy 10 gym sessions
@bot gym training next Wednesday at 8:30
@bot how many gym sessions do I have left?
@bot cancel last gym session
```

## Setup

### 1. Prerequisites

- **Node.js** >= 22
- **Anthropic API key** with access to Claude Sonnet
- **Google Cloud OAuth credentials** (for Google Calendar API)

### 2. Install

```bash
git clone <your-repo>
cd whatsapp-calendar-bot
npm install
```

### 3. Google Calendar MCP Setup

#### Create OAuth credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project and enable the **Google Calendar API**
3. APIs & Services > Credentials > Create Credentials > **OAuth client ID** (Desktop app)
4. Download the JSON file, save as `~/.config/gcp-oauth.keys.json`
5. OAuth consent screen > Audience > add your email as a test user
6. Set publishing status to **Production** (avoids 7-day token expiry)

#### Authenticate

```bash
GOOGLE_OAUTH_CREDENTIALS=~/.config/gcp-oauth.keys.json npx @cocal/google-calendar-mcp auth
```

This opens a browser for Google OAuth. Tokens are saved locally and auto-refresh.

### 4. Configure

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `GCAL_MCP_COMMAND` | Yes* | MCP command, e.g. `npx @cocal/google-calendar-mcp` |
| `GOOGLE_OAUTH_CREDENTIALS` | Yes* | Path to OAuth credentials JSON |
| `GCAL_MCP_URL` | Yes* | Alternative: HTTP MCP endpoint (use instead of COMMAND) |
| `PEOPLE_MAP` | Yes | Name-to-email mapping (see below) |
| `RESEND_API_KEY` | | For `.ics` email delivery to non-Google users |
| `EMAIL_FROM` | | Sender address (default: `Calendar Bot <onboarding@resend.dev>`) |
| `BOT_TRIGGER` | | Trigger keyword (default: `@bot`) |
| `TIMEZONE` | | IANA timezone (default: `Europe/Prague`) |
| `OPENAI_API_KEY` | | For voice message transcription via Whisper |
| `ALLOWED_CHATS` | | Comma-separated WhatsApp chat IDs to restrict access |

*Either `GCAL_MCP_COMMAND` + `GOOGLE_OAUTH_CREDENTIALS` or `GCAL_MCP_URL` is required.

#### People Registry

The `PEOPLE_MAP` tells the bot each person's email and calendar provider:

```env
PEOPLE_MAP=Alice=alice@gmail.com:google,Bob=bob@icloud.com:apple,gym-trainer=trainer@email.com:google
```

Supported providers: `google`, `apple`, `outlook`, `other` (defaults to `google` if omitted).

### 5. Run

```bash
# Development
npm run dev

# Production
npm run build && npm start
```

On first launch, scan the QR code in your terminal with WhatsApp > Linked Devices.

### 6. Docker Deployment (Raspberry Pi)

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full step-by-step guide (Docker install, code sync, credential setup, QR scan).

Quick start:

```bash
docker compose up -d --build
```

Data is persisted via volumes:
- `./data/` — SQLite database (`bot.db`)
- `./wwebjs_auth/` — WhatsApp session (no re-scan needed after restart)
- Google OAuth credentials mounted read-only

### Voice Messages

Voice messages sent to allowed chats are automatically transcribed via **OpenAI Whisper** and processed as regular commands — no trigger keyword needed. Requires `OPENAI_API_KEY` in `.env`.

## How It Works

1. **Message arrives** in WhatsApp — text starting with `@bot`, or a voice message
2. **Trigger stripped**, sender name and group participants extracted
3. **Claude agent invoked** with system prompt (people registry, timezone, date), conversation history, and all tools (MCP + local)
4. **Agentic loop**: Claude calls tools as needed — up to 10 rounds
5. **Final text response** sent back to WhatsApp as a reply

### Conversation Memory

Per-chat history (up to 20 messages, 30-min TTL) enables multi-turn interactions:

```
You:  @bot schedule Alice and Bob tomorrow at 2pm for a design review
Bot:  ✅ Created "Design Review" for tomorrow 2:00-3:00 PM
You:  @bot actually make it 90 minutes
Bot:  ✅ Updated to 2:00-3:30 PM
```

### Gym Session Tracking

Prepaid gym session packages are tracked in SQLite. Each gym event title includes the session number (e.g. "Gym session 3/10 - David"). Cancelling a session restores it to the package. The bot warns when sessions are running low or exhausted.

## Project Structure

```
src/
├── index.ts               # WhatsApp client + message routing + lifecycle
├── config.ts              # Env loading, people registry
├── agent.ts               # Claude agentic loop (MCP + local tools)
├── mcp-client.ts          # MCP SDK client (stdio + HTTP/SSE transports)
├── db.ts                  # SQLite schema + gym packages + ICS event tracking
├── ics-invite.ts          # .ics generator + Resend email sender
└── conversation-store.ts  # In-memory per-chat message history
```

## Troubleshooting

| Issue | Fix |
|---|---|
| No QR code | Ensure Chromium is installed: `sudo apt install chromium-browser` |
| MCP auth errors | Re-run the `npx @cocal/google-calendar-mcp auth` command |
| Bot not responding | Verify message starts with the trigger (`@bot` by default) |
| OAuth token expired | Publish app to Production in Google Cloud Console |
| "Person not found" | Add them to `PEOPLE_MAP` in `.env` |
| Data lost on restart | Ensure Docker volumes are mounted (`./data`, `./wwebjs_auth`) |
