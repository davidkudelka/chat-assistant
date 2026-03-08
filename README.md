# WhatsApp Calendar Bot (AI-Powered, Cross-Platform)

An agentic WhatsApp bot that uses **Claude + Google Calendar MCP** to schedule and manage meetings between people in a group chat — even when attendees use **different calendar apps** (Google Calendar, Apple Calendar, Outlook).

## Architecture

```
WhatsApp Group Chat
       │
       ▼
  whatsapp-web.js         ← listens for "@bot ..." messages
       │
       ▼
  Claude Agent (Sonnet)   ← agentic loop, decides what tools to call
       │
       ├──► Google Calendar MCP   ← create/list/update/delete events
       ├──► lookup_person         ← check registry + calendar provider
       └──► send_ics_invite       ← send .ics email to Apple/Outlook users
```

### How Cross-Platform Scheduling Works

The event lives on **Google Calendar** (as the source of truth). Cross-platform delivery works because:

1. **Google Calendar users** — Google auto-adds the event when they're listed as an attendee
2. **Apple Calendar users** — receive an email invite with an `.ics` attachment that Apple Calendar picks up natively. The bot also calls `send_ics_invite` as a fallback for guaranteed delivery.
3. **Outlook users** — same `.ics` mechanism as Apple; Outlook natively handles calendar invites via email

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
@bot when is the next meeting between Alice and Bob?
```

**Manage events:**
```
@bot cancel the standup on Friday
@bot move the Alice/Bob sync to 3pm
```

**Free-form questions:**
```
@bot is Bob free tomorrow afternoon?
@bot find a slot for Alice and Bob next week, 30 minutes
```

## Setup

### 1. Prerequisites

- **Node.js** ≥ 18
- **Chromium** installed (for Puppeteer/WhatsApp Web)
- **Anthropic API key** with access to Claude Sonnet
- **Google Calendar MCP server** — either:
  - Anthropic's hosted MCP (`https://gcal.mcp.claude.com/mcp`) if you have access
  - Self-hosted: [google-calendar-mcp](https://github.com/anthropics/google-calendar-mcp)

### 2. Install

```bash
git clone <your-repo>
cd whatsapp-calendar-bot
npm install
```

### 3. Configure

```bash
cp .env.example .env
```

Fill in:

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key |
| `GCAL_MCP_URL` | ✅ | Google Calendar MCP endpoint |
| `PEOPLE_MAP` | ✅ | Name-to-email mapping (see below) |
| `BOT_TRIGGER` | | Trigger keyword, default `@bot` |
| `TIMEZONE` | | IANA timezone, default `Europe/Prague` |
| `ALLOWED_CHATS` | | Restrict to specific WhatsApp chat IDs |

#### People Registry

The `PEOPLE_MAP` tells the bot each person's email and calendar provider:

```env
PEOPLE_MAP=Alice=alice@gmail.com:google,Bob=bob@icloud.com:apple,Charlie=charlie@outlook.com:outlook
```

Supported providers: `google`, `apple`, `outlook`, `other` (defaults to `google` if omitted).

When scheduling between Alice (Google) and Bob (Apple), the bot:
1. Creates the event on Google Calendar with both as attendees
2. Google sends Alice's invite automatically
3. Calls `send_ics_invite` to email Bob a `.ics` file that Apple Calendar picks up

### 4. MCP Server Setup

#### Option A: Self-hosted Google Calendar MCP

If you're self-hosting the MCP server:

```bash
# In a separate terminal
npx @anthropic-ai/google-calendar-mcp --port 3001
# Then set GCAL_MCP_URL=http://localhost:3001/mcp in .env
```

You'll need to authenticate with Google OAuth on first run.

#### Option B: Anthropic's hosted MCP

If you have access to Anthropic's hosted MCP connectors, use:
```env
GCAL_MCP_URL=https://gcal.mcp.claude.com/mcp
```

Note: this requires proper authentication headers which you may need to configure.

### 5. Run

```bash
# Development
npm run dev

# Production
npm run build && npm start
```

On first launch, scan the QR code in your terminal with WhatsApp → Linked Devices.

## How It Works

1. **Message arrives** in WhatsApp starting with `@bot`
2. **Trigger stripped**, sender name and group participants extracted
3. **Claude agent invoked** with:
   - System prompt containing the people registry, timezone, today's date
   - Conversation history (last 20 messages, 30-min TTL per chat)
   - Google Calendar MCP server for tool use
4. **Agentic loop**: Claude calls MCP tools (list events, create event, etc.) as many times as needed
5. **Final text response** sent back to WhatsApp as a reply

### Conversation Memory

The bot maintains per-chat conversation history (up to 20 messages, 30-min TTL) so you can have multi-turn interactions:

```
You:  @bot schedule Alice and Bob tomorrow at 2pm for a design review
Bot:  ✅ Created "Design Review" for tomorrow 2:00-3:00 PM with Alice and Bob
You:  @bot actually make it 90 minutes
Bot:  ✅ Updated to 2:00-3:30 PM
```

## Project Structure

```
src/
├── index.ts               # WhatsApp client + message routing
├── config.ts              # Env loading, people registry with calendar providers
├── agent.ts               # Claude agentic loop (MCP + local tools)
├── ics-invite.ts          # .ics generator + SMTP sender for Apple/Outlook
└── conversation-store.ts  # Per-chat message history
```

## Extending

- **Add more MCP servers**: Pass additional entries in the `mcp_servers` array in `agent.ts` (e.g., Slack MCP to also post in a channel)
- **Richer people registry**: Move `PEOPLE_MAP` to a JSON file or database for larger teams
- **Approval flow**: Modify the system prompt to always confirm before creating — the multi-turn history already supports this
- **Private chats**: The bot works in 1:1 chats too, not just groups

## Troubleshooting

| Issue | Fix |
|---|---|
| No QR code | Ensure Chromium is installed: `sudo apt install chromium-browser` |
| MCP auth errors | Check your MCP server is running and authenticated with Google |
| Bot not responding | Verify message starts with the trigger (`@bot` by default) |
| Wrong timezone | Set `TIMEZONE` in `.env` to your IANA timezone |
| "Person not found" | Add them to `PEOPLE_MAP` in `.env` |
