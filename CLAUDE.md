# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WhatsApp Calendar Bot — an agentic WhatsApp bot that uses Claude + Google Calendar MCP to schedule and manage meetings. Supports cross-platform calendar delivery (Google Calendar, Apple Calendar, Outlook) via `.ics` email invites (Resend). Includes gym session package tracking with SQLite persistence. Voice messages are transcribed via OpenAI Whisper.

## Build & Run

```bash
npm install
npm run dev          # development via tsx
npm run build        # tsc compile to dist/
npm start            # run compiled JS from dist/
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run lint:fix     # eslint --fix
npm run format       # prettier --write
npm run format:check # prettier --check
```

ESM project (`"type": "module"`). All `.ts` imports use `.js` extensions. Node >= 22.

### Docker deployment (Raspberry Pi)

```bash
docker compose up -d --build
```

Volumes persist SQLite data (`./data/`), WhatsApp session (`./wwebjs_auth/`), and Google OAuth credentials. See `DEPLOYMENT.md` for the full Pi deployment guide.

## Architecture

**Message flow**: WhatsApp message (`message_create` event) → trigger check + access control (`src/index.ts`) → Claude agentic loop (`src/agent.ts`) → reply to WhatsApp.

### Key modules (all in `src/`)

- **`index.ts`** — WhatsApp client (whatsapp-web.js with Puppeteer). Uses `message_create` event (fires for both sent and received messages). Handles voice message transcription. Manages MCP + DB lifecycle.
- **`transcribe.ts`** — Voice message transcription via OpenAI Whisper API. Converts base64 audio (OGG/Opus from WhatsApp) to text.
- **`agent.ts`** — Core agentic loop using `anthropic.messages.create()`. Merges local tools + MCP tools into a single tools array. Routes tool calls via `executeTool()`. Iterates up to `MAX_TOOL_ROUNDS=10` rounds.
- **`mcp-client.ts`** — MCP client using `@modelcontextprotocol/sdk`. Supports two transports: stdio (`GCAL_MCP_COMMAND`, spawns a subprocess) or HTTP/SSE (`GCAL_MCP_URL`). Fetches tool definitions at startup and converts them to Anthropic API format.
- **`db.ts`** — SQLite database (better-sqlite3). Stores gym session packages/logs and ICS event tracking. Data persists in `DATA_DIR/bot.db` (default `./data/bot.db`).
- **`config.ts`** — Loads `.env` via dotenv. Parses `PEOPLE_MAP` env var (format: `Name=email:provider`).
- **`conversation-store.ts`** — In-memory per-chat conversation history. 20 message limit, 30-minute TTL.
- **`ics-invite.ts`** — Generates RFC 5545 `.ics` files and sends them via Resend. ICS event tracking (UID, SEQUENCE) persisted to SQLite for update/cancel flows across restarts.

### Tool architecture

All tools appear as standard `tool_use` blocks. The agent has two categories:
1. **MCP tools** — Discovered from the Google Calendar MCP server at startup, converted to Anthropic tool format. Executed via `callMCPTool()`.
2. **Local tools** — Defined in `agent.ts` as `LOCAL_TOOLS`: ICS tools (`send_ics_invite`, `send_ics_update`, `send_ics_cancel`), `lookup_person`, gym tools (`gym_buy_sessions`, `gym_get_remaining`, `gym_use_session`, `gym_cancel_session`).

`executeTool()` routes by checking `LOCAL_TOOL_NAMES` — local tools run in-process, everything else forwards to MCP.

## Configuration

All config via environment variables (`.env` file, see `.env.example`).

Required: `ANTHROPIC_API_KEY`, plus one of `GCAL_MCP_COMMAND` (stdio) or `GCAL_MCP_URL` (HTTP).

For stdio MCP (recommended): set `GCAL_MCP_COMMAND=npx @cocal/google-calendar-mcp` and `GOOGLE_OAUTH_CREDENTIALS=/path/to/gcp-oauth.keys.json`.

`RESEND_API_KEY` + `EMAIL_FROM` needed for `.ics` email delivery to non-Google calendar users.

`PEOPLE_MAP` format: `Name=email:provider` comma-separated. Provider defaults to `google`. Supported: `google`, `apple`, `outlook`, `other`. Special entry `gym-trainer` is used by the gym session flow.
