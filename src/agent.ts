import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { CalendarProvider, Person, PersonRole } from "./config.js";
import { sendICSInvite, sendICSUpdate, sendICSCancel } from "./ics-invite.js";
import { getMCPTools, callMCPTool } from "./mcp-client.js";
import {
  createGymPackage,
  getActiveGymPackage,
  useGymSession,
  cancelGymSession,
  setGymPackage,
  resolvePerson,
  getPeopleList,
  upsertPerson,
} from "./db.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const MAX_TOOL_ROUNDS = 25;

// ── Local tools (non-MCP) that the agent can call ──

const ICS_EVENT_PROPERTIES = {
  gcal_event_id: {
    type: "string",
    description: "The Google Calendar event ID (from the MCP create/update response)",
  },
  title: { type: "string", description: "Event title" },
  description: { type: "string", description: "Event description (optional)" },
  location: { type: "string", description: "Event location (optional)" },
  start_time: { type: "string", description: "ISO 8601 start time" },
  end_time: { type: "string", description: "ISO 8601 end time" },
  recipient_names: {
    type: "array",
    items: { type: "string" },
    description: "Names of non-Google attendees (must be in people registry)",
  },
  all_attendee_emails: {
    type: "array",
    items: { type: "string" },
    description: "All attendee emails (for the .ics attendee list)",
  },
} as const;

const LOCAL_TOOLS: Anthropic.Tool[] = [
  {
    name: "send_ics_invite",
    description:
      "Send a NEW .ics calendar invite to non-Google calendar users (Apple Calendar, Outlook). " +
      "Use AFTER creating an event on Google Calendar. The gcal_event_id is required so the " +
      "bot can track the event and send proper updates/cancellations later.",
    input_schema: {
      type: "object" as const,
      properties: ICS_EVENT_PROPERTIES,
      required: [
        "gcal_event_id",
        "title",
        "start_time",
        "end_time",
        "recipient_names",
        "all_attendee_emails",
      ],
    },
  },
  {
    name: "send_ics_update",
    description:
      "Send an UPDATED .ics to non-Google calendar users after modifying an event on Google Calendar. " +
      "This reuses the same ICS UID and increments the SEQUENCE number so Apple Calendar / Outlook " +
      "update the event in-place rather than creating a duplicate. Requires the gcal_event_id " +
      "from the original event.",
    input_schema: {
      type: "object" as const,
      properties: ICS_EVENT_PROPERTIES,
      required: [
        "gcal_event_id",
        "title",
        "start_time",
        "end_time",
        "recipient_names",
        "all_attendee_emails",
      ],
    },
  },
  {
    name: "send_ics_cancel",
    description:
      "Send a CANCELLATION .ics to non-Google calendar users after deleting an event on Google Calendar. " +
      "This sends METHOD:CANCEL with the same UID so Apple Calendar / Outlook remove the event. " +
      "Requires the gcal_event_id of the deleted event.",
    input_schema: {
      type: "object" as const,
      properties: {
        gcal_event_id: {
          type: "string",
          description: "The Google Calendar event ID of the cancelled event",
        },
        recipient_names: {
          type: "array",
          items: { type: "string" },
          description: "Names of non-Google attendees to notify",
        },
        start_time: { type: "string", description: "Original start time (ISO 8601)" },
        end_time: { type: "string", description: "Original end time (ISO 8601)" },
        all_attendee_emails: {
          type: "array",
          items: { type: "string" },
          description: "All attendee emails",
        },
      },
      required: [
        "gcal_event_id",
        "recipient_names",
        "start_time",
        "end_time",
        "all_attendee_emails",
      ],
    },
  },
  {
    name: "lookup_person",
    description:
      "Look up a person in the registry by name. Returns their email and calendar provider. " +
      "Use this to check if someone is registered and what calendar they use.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Person's name (case-insensitive)" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_person",
    description:
      "Update a person's details in the registry (email, calendar provider, role, phone). " +
      "Use this when the user wants to change their email or the gym trainer's contact info. " +
      "The phone field should be the WhatsApp number (digits only, with country code, e.g. '420123456789').",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Person's name/key (e.g. 'David' or 'gym-trainer')",
        },
        email: { type: "string", description: "New email address" },
        calendar: {
          type: "string",
          enum: ["google", "apple", "outlook", "other"],
          description: "Calendar provider (defaults to google)",
        },
        role: {
          type: "string",
          enum: ["client", "trainer"],
          description: "Role: 'client' (session owner) or 'trainer'",
        },
        phone: {
          type: "string",
          description: "WhatsApp phone number (digits only with country code, e.g. '420123456789')",
        },
      },
      required: ["name", "email", "role"],
    },
  },
  {
    name: "gym_buy_sessions",
    description:
      "Register a new prepaid gym session package. Creates a new active package with the given number of sessions.",
    input_schema: {
      type: "object" as const,
      properties: {
        total_sessions: {
          type: "number",
          description: "Number of prepaid sessions purchased",
        },
      },
      required: ["total_sessions"],
    },
  },
  {
    name: "gym_get_remaining",
    description:
      "Check how many prepaid gym sessions remain in the active package. " +
      "Returns total, used, and remaining session counts.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "gym_use_session",
    description:
      "Record a gym session as used. Call this AFTER creating the calendar event. " +
      "Returns the session number (e.g. 3/10) to include in the event title.",
    input_schema: {
      type: "object" as const,
      properties: {
        gcal_event_id: {
          type: "string",
          description: "The Google Calendar event ID of the gym session",
        },
      },
      required: ["gcal_event_id"],
    },
  },
  {
    name: "gym_set_sessions",
    description:
      "Manually set the gym session package to specific values. " +
      "Replaces the current active package with the given total and used counts.",
    input_schema: {
      type: "object" as const,
      properties: {
        total_sessions: {
          type: "number",
          description: "Total number of sessions in the package",
        },
        used_sessions: {
          type: "number",
          description: "Number of sessions already used",
        },
      },
      required: ["total_sessions", "used_sessions"],
    },
  },
  {
    name: "gym_cancel_session",
    description:
      "Undo a gym session usage when a gym event is cancelled. " +
      "Restores the session back to the package.",
    input_schema: {
      type: "object" as const,
      properties: {
        gcal_event_id: {
          type: "string",
          description: "The Google Calendar event ID of the cancelled gym session",
        },
      },
      required: ["gcal_event_id"],
    },
  },
];

const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOLS.map((t) => t.name));

/** Human-readable labels for progress updates. */
const TOOL_LABELS: Record<string, string> = {
  lookup_person: "Looking up contact...",
  update_person: "Updating contact...",
  send_ics_invite: "Sending calendar invite...",
  send_ics_update: "Updating calendar invite...",
  send_ics_cancel: "Cancelling calendar invite...",
  gym_buy_sessions: "Registering session package...",
  gym_get_remaining: "Checking remaining sessions...",
  gym_use_session: "Recording session...",
  gym_set_sessions: "Updating session count...",
  gym_cancel_session: "Restoring session...",
};

function describeTools(toolNames: string[]): string {
  const labels = toolNames.map((n) => TOOL_LABELS[n] ?? `Using ${n}...`);
  return [...new Set(labels)].join("\n");
}

export type ProgressCallback = (status: string) => Promise<void>;

/**
 * Resolve recipient names to Person objects.
 */
function resolveRecipients(names: string[]): Person[] {
  const recipients: Person[] = [];
  for (const name of names) {
    const person = resolvePerson(name);
    if (person) recipients.push(person);
  }
  return recipients;
}

/**
 * Execute a local (non-MCP) tool call and return the result.
 */
async function executeLocalTool(name: string, input: Record<string, unknown>): Promise<string> {
  const inp = input as Record<string, string | string[]>;

  switch (name) {
    case "send_ics_invite": {
      const recipients = resolveRecipients(inp.recipient_names as string[]);
      if (recipients.length === 0) {
        return JSON.stringify({
          status: "skipped",
          reason: "No matching non-Google recipients found",
        });
      }

      const result = await sendICSInvite(recipients, {
        gcalEventId: inp.gcal_event_id as string,
        title: inp.title as string,
        description: inp.description as string | undefined,
        location: inp.location as string | undefined,
        startTime: new Date(inp.start_time as string),
        endTime: new Date(inp.end_time as string),
        allAttendees: (inp.all_attendee_emails as string[]).map((email) => ({ email })),
      });
      return JSON.stringify(result);
    }

    case "send_ics_update": {
      const recipients = resolveRecipients(inp.recipient_names as string[]);
      if (recipients.length === 0) {
        return JSON.stringify({
          status: "skipped",
          reason: "No matching non-Google recipients found",
        });
      }

      const result = await sendICSUpdate(recipients, {
        gcalEventId: inp.gcal_event_id as string,
        title: inp.title as string,
        description: inp.description as string | undefined,
        location: inp.location as string | undefined,
        startTime: new Date(inp.start_time as string),
        endTime: new Date(inp.end_time as string),
        allAttendees: (inp.all_attendee_emails as string[]).map((email) => ({ email })),
      });
      return JSON.stringify(result);
    }

    case "send_ics_cancel": {
      const recipients = resolveRecipients(inp.recipient_names as string[]);
      if (recipients.length === 0) {
        return JSON.stringify({
          status: "skipped",
          reason: "No matching non-Google recipients found",
        });
      }

      const result = await sendICSCancel(recipients, inp.gcal_event_id as string, {
        startTime: new Date(inp.start_time as string),
        endTime: new Date(inp.end_time as string),
        allAttendees: (inp.all_attendee_emails as string[]).map((email) => ({ email })),
      });
      return JSON.stringify(result);
    }

    case "lookup_person": {
      const person = resolvePerson(inp.name as string);
      if (!person) {
        return JSON.stringify({ found: false, name: inp.name });
      }
      return JSON.stringify({ found: true, ...person });
    }

    case "update_person": {
      const name = inp.name as string;
      const email = inp.email as string;
      const calendar = (inp.calendar as CalendarProvider) || "google";
      const role = (inp.role as PersonRole) || "client";
      const phone = inp.phone as string | undefined;
      const updated = upsertPerson(name.toLowerCase(), name, email, calendar, role, phone);
      return JSON.stringify({ status: "updated", ...updated });
    }

    case "gym_buy_sessions": {
      const total = input.total_sessions as number;
      const pkg = createGymPackage(total);
      return JSON.stringify({
        status: "created",
        package_id: pkg.id,
        total_sessions: pkg.total_sessions,
        used_sessions: 0,
        remaining: pkg.total_sessions,
      });
    }

    case "gym_get_remaining": {
      const pkg = getActiveGymPackage();
      if (!pkg) {
        return JSON.stringify({
          status: "no_active_package",
          message: "No active gym session package found",
        });
      }
      return JSON.stringify({
        package_id: pkg.id,
        total_sessions: pkg.total_sessions,
        used_sessions: pkg.used_sessions,
        remaining: pkg.total_sessions - pkg.used_sessions,
      });
    }

    case "gym_use_session": {
      const pkg = getActiveGymPackage();
      if (!pkg) {
        return JSON.stringify({
          status: "error",
          message: "No active gym session package. Buy sessions first.",
        });
      }
      if (pkg.used_sessions >= pkg.total_sessions) {
        return JSON.stringify({
          status: "exhausted",
          message: "All sessions have been used. Buy a new package.",
          total: pkg.total_sessions,
          used: pkg.used_sessions,
        });
      }
      const sessionNumber = pkg.used_sessions + 1;
      useGymSession(pkg.id, input.gcal_event_id as string, sessionNumber);
      return JSON.stringify({
        status: "ok",
        session_number: sessionNumber,
        total: pkg.total_sessions,
        remaining: pkg.total_sessions - sessionNumber,
        label: `${sessionNumber}/${pkg.total_sessions}`,
      });
    }

    case "gym_set_sessions": {
      const total = input.total_sessions as number;
      const used = input.used_sessions as number;
      if (used > total) {
        return JSON.stringify({
          status: "error",
          message: "Used sessions cannot exceed total sessions",
        });
      }
      const pkg = setGymPackage(total, used);
      return JSON.stringify({
        status: "ok",
        package_id: pkg.id,
        total_sessions: total,
        used_sessions: used,
        remaining: total - used,
      });
    }

    case "gym_cancel_session": {
      const cancelled = cancelGymSession(input.gcal_event_id as string);
      if (!cancelled) {
        return JSON.stringify({
          status: "not_found",
          message: "No gym session found for this event",
        });
      }
      return JSON.stringify({ status: "restored", message: "Session restored to package" });
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

/**
 * Execute a tool call — routes to local handler or MCP server.
 */
async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (LOCAL_TOOL_NAMES.has(name)) {
    return executeLocalTool(name, input);
  }
  return callMCPTool(name, input);
}

/**
 * Build the system prompt with cross-platform calendar awareness.
 */
function buildSystemPrompt(senderName: string, senderRole: string, chatParticipants: string[]): string {
  // Build timezone-aware date info to prevent day-of-week miscalculations
  const nowDate = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(nowDate);
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value) - 1;
  const d = Number(parts.find((p) => p.type === "day")!.value);
  const localToday = new Date(y, m, d);
  const dayOfWeek = localToday.getDay(); // 0=Sun

  // Monday=0 week layout (European convention: Mon-Sun)
  const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  // Convert JS dayOfWeek (0=Sun) to Mon-based (0=Mon)
  const monBasedDay = (dayOfWeek + 6) % 7;

  function formatIso(date: Date): string {
    const yy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  // This week (Mon-Sun containing today)
  const thisWeek: string[] = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(y, m, d + (i - monBasedDay));
    const iso = formatIso(date);
    const label = i === monBasedDay ? `${dayNames[i]} (TODAY)` : dayNames[i];
    thisWeek.push(`  ${label}: ${iso}`);
  }

  // Next week (Mon-Sun)
  const nextWeek: string[] = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(y, m, d + (7 - monBasedDay + i));
    const iso = formatIso(date);
    nextWeek.push(`  ${dayNames[i]}: ${iso}`);
  }

  const today = localToday.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const now = nowDate.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: config.timezone,
  });

  // Compute UTC offset for the configured timezone (e.g. "+01:00" or "+02:00" for Prague)
  const utcFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    timeZoneName: "shortOffset",
  });
  const tzPart = utcFormatter.formatToParts(nowDate).find((p) => p.type === "timeZoneName");
  // tzPart.value is like "GMT+1" or "GMT+2", convert to "+01:00" format
  const rawOffset = tzPart?.value ?? "GMT+0";
  const offsetMatch = rawOffset.match(/GMT([+-]?)(\d+)/);
  const offsetSign = offsetMatch?.[1] || "+";
  const offsetHours = offsetMatch?.[2] ?? "0";
  const tzOffset = `${offsetSign}${offsetHours.padStart(2, "0")}:00`;

  return `You are a helpful scheduling assistant in a WhatsApp chat between a gym client and their trainer.
Today is ${today}, current time is ${now} (timezone: ${config.timezone}, UTC offset: ${tzOffset}).

### This week's dates:
${thisWeek.join("\n")}

### Next week's dates:
${nextWeek.join("\n")}

IMPORTANT DATE/TIME RULES:
- When the user says "this Friday", "next Monday", etc., ALWAYS look up the exact date from the tables above. Do NOT calculate dates yourself.
- When passing datetime to ANY tool (MCP or local), ALWAYS use ISO 8601 with the timezone offset: e.g. "2026-03-13T15:00:00${tzOffset}" — NEVER omit the offset.
- Example: "this Friday at 3 PM" → "2026-03-13T15:00:00${tzOffset}"

## Registered People
${getPeopleList()}

## Current Context
- Message sender: ${senderName} (role: ${senderRole})
- Chat participants: ${chatParticipants.join(", ")}

## Role Awareness
This bot operates in a shared chat between the client and trainer. Both can interact with the bot.
- **Client** (role: client) — owns the session package, pays for sessions
- **Trainer** (role: trainer) — conducts the sessions

### Permissions by role:
- **Both** can: schedule sessions, cancel sessions, check remaining sessions, reschedule sessions
- **Client only** can: buy session packages (gym_buy_sessions), set session counts (gym_set_sessions), update people registry
- **Trainer** requesting to buy/set sessions: politely decline and say only the client can do this

When the trainer schedules or cancels, sessions are still deducted from / restored to the client's package.
Always use the client's name in event titles (e.g. "Gym session 3/10 - David"), regardless of who requested it.

## Your Capabilities
You have access to:
1. **Google Calendar via MCP** — create, list, update, delete events, check free/busy
2. **send_ics_invite / send_ics_update / send_ics_cancel** — .ics delivery for non-Google calendar users
3. **lookup_person** — check if someone is in the registry and what calendar they use
4. **update_person** — update a person's details (client only)

## Cross-Platform Scheduling Flows

### Creating a new event:
1. Use lookup_person to check each attendee's calendar provider
2. Create the event on Google Calendar via MCP (add ALL attendees by email, set sendUpdates to "all")
3. Note the gcal_event_id from the response — you need this for future updates
4. If any attendee uses Apple/Outlook: call send_ics_invite with the gcal_event_id

### Updating an event:
1. Update the event on Google Calendar via MCP
2. If any attendee uses Apple/Outlook: call send_ics_update with the same gcal_event_id

### Cancelling an event:
1. Delete the event on Google Calendar via MCP
2. If any attendee uses Apple/Outlook: call send_ics_cancel with the gcal_event_id

## Behavior Rules
- Always confirm what you're about to do before creating/modifying events, unless the request is unambiguous.
- Use timezone ${config.timezone} for all events unless told otherwise.
- Keep responses concise — this is WhatsApp, not email.
- Use emojis sparingly for readability.
- If a person isn't in the registry, say so and ask for their email.
- ALWAYS pass gcal_event_id to ICS tools — this is how we track events across updates.
- When creating events, always set sendUpdates to "all" so Google sends invite emails.

## Gym Training

### Session packages
- The client prepays a number of gym sessions (e.g. 10). Use gym_buy_sessions to register a new package.
- Use gym_get_remaining to check how many sessions are left.
- Each gym event uses one session from the active package.

### Creating a gym session:
1. Call gym_get_remaining to check there are sessions available
2. Create the event on Google Calendar via MCP:
   - Duration: always 1 hour
   - Location: always "Next Move, Vinohrady"
   - Add both the client and trainer as attendees (look up both from the registry)
3. Call gym_use_session with the gcal_event_id — this returns the session label (e.g. "3/10")
4. Update the event title to "Gym session 3/10 - {client name}" using the label from gym_use_session
5. No need to confirm — gym training requests are always unambiguous.
6. If no active package exists or all sessions are used, tell the user.

### Cancelling a gym session:
1. Delete the event on Google Calendar
2. Call gym_cancel_session with the gcal_event_id — this restores the session to the package

### "As usual" / regular weekly schedule:
When the user says "book gym sessions for next week as usual" (or similar), book:
- Monday at 8:30 AM (1 hour)
- Wednesday at 8:30 AM (1 hour)
Both sessions follow the standard gym session creation flow above. Book them sequentially (create first, then second).

### Querying:
- "how many gym sessions left" → call gym_get_remaining (both client and trainer can ask)
- "buy 10 gym sessions" → call gym_buy_sessions (client only)
- "set gym sessions to 5 used out of 10" → call gym_set_sessions (client only)

## Important
- Default event duration is 1 hour unless specified.
- When updating events, ALWAYS also call send_ics_update for non-Google attendees.
- When deleting events, ALWAYS also call send_ics_cancel for non-Google attendees.`;
}

/**
 * Run the agentic loop: Claude + MCP + local tools, iterating until done.
 */
export async function runAgent(
  senderName: string,
  senderRole: string,
  messageText: string,
  chatParticipants: string[],
  onProgress?: ProgressCallback,
): Promise<string> {
  const systemPrompt = buildSystemPrompt(senderName, senderRole, chatParticipants);
  const allTools = [...LOCAL_TOOLS, ...getMCPTools()];
  const steps: string[] = [];

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `[${senderName}]: ${messageText}` },
  ];

  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    tools: allTools,
    messages,
  });

  // Agentic loop: execute tool calls until Claude is done
  let rounds = 0;
  while (response.stop_reason === "tool_use" && rounds < MAX_TOOL_ROUNDS) {
    rounds++;

    const toolCalls = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    console.log(`  🔧 Agent round ${rounds}: ${toolCalls.map((b) => b.name).join(", ")}`);
    for (const call of toolCalls) {
      console.log(`     ${call.name}:`, JSON.stringify(call.input));
    }

    // Update progress message
    const stepLabel = describeTools(toolCalls.map((b) => b.name));
    steps.push(stepLabel);
    if (onProgress) {
      await onProgress(`⏳ Processing...\n${steps.join("\n")}`).catch(() => {});
    }

    // Execute all tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const call of toolCalls) {
      try {
        const result = await executeTool(call.name, call.input as Record<string, unknown>);
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: result,
        });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify({ error: String(err) }),
          is_error: true,
        });
      }
    }

    if (toolResults.length === 0) break;

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools: allTools,
      messages,
    });
  }

  // Extract final text
  const textBlocks = response.content.filter(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );

  const reply = textBlocks.map((b) => b.text).join("\n") || "Done ✅";

  return reply;
}
