# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WhatsApp Calendar Bot — an agentic WhatsApp bot that uses Claude + Google Calendar MCP to schedule and manage meetings. Supports cross-platform calendar delivery (Google Calendar, Apple Calendar, Outlook) via `.ics` email invites.

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

## Architecture

**Message flow**: WhatsApp message → trigger check + access control (`src/index.ts`) → Claude agentic loop (`src/agent.ts`) → reply to WhatsApp.

### Key modules (all in `src/`)

- **`index.ts`** — WhatsApp client (whatsapp-web.js with Puppeteer). Listens for messages starting with the trigger keyword, extracts sender/participants, calls `runAgent()`. Manages MCP client lifecycle (connect on ready, disconnect on shutdown).
- **`agent.ts`** — Core agentic loop using the standard `anthropic.messages.create()` API. Merges local tools + MCP tools into a single tools array. Routes tool calls via `executeTool()` — local tools handled in-process, MCP tools forwarded to the MCP server. Iterates up to `MAX_TOOL_ROUNDS=10` rounds.
- **`mcp-client.ts`** — MCP client using `@modelcontextprotocol/sdk`. Connects to the Google Calendar MCP server via Streamable HTTP (with SSE fallback). Fetches tool definitions at startup and converts them to Anthropic API format. Exposes `callMCPTool()` for tool execution.
- **`config.ts`** — Loads `.env` via dotenv. Parses `PEOPLE_MAP` env var (format: `Name=email:provider`). Exports `config` object, `resolvePerson()`, `getPeopleList()`.
- **`conversation-store.ts`** — In-memory per-chat conversation history. 20 message limit, 30-minute TTL. Stale conversations cleaned up every 10 minutes.
- **`ics-invite.ts`** — Generates RFC 5545 `.ics` files and sends them via SMTP (nodemailer). Tracks events by Google Calendar event ID to support proper UPDATE (same UID, incremented SEQUENCE) and CANCEL flows.

### Tool architecture

All tools appear as standard `tool_use` blocks — no beta API or special MCP block types. The agent has two categories:
1. **MCP tools** — Discovered from the MCP server at startup (`mcp-client.ts`), converted to Anthropic tool format. Executed via `callMCPTool()` which calls `client.callTool()` on the MCP SDK client.
2. **Local tools** — Defined in `agent.ts` as `LOCAL_TOOLS`: `send_ics_invite`, `send_ics_update`, `send_ics_cancel`, `lookup_person`. Executed in-process via `executeLocalTool()`.

`executeTool()` routes by checking `LOCAL_TOOL_NAMES` — if the tool name matches a local tool, it runs locally; otherwise it's forwarded to MCP.

## Configuration

All config via environment variables (`.env` file, see `.env.example`). Required: `ANTHROPIC_API_KEY`, `GCAL_MCP_URL`. SMTP settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) needed only for `.ics` email delivery to non-Google users.

`PEOPLE_MAP` format: `Name=email:provider` comma-separated. Provider defaults to `google`. Supported: `google`, `apple`, `outlook`, `other`.
