import dotenv from "dotenv";
dotenv.config();

export type CalendarProvider = "google" | "apple" | "outlook" | "other";

export interface Person {
  name: string;
  email: string;
  calendar: CalendarProvider;
}

/**
 * Parse PEOPLE_MAP entries.
 *
 * Format: Name=email:provider
 * Provider is optional, defaults to "google".
 *
 * Examples:
 *   Alice=alice@gmail.com:google
 *   Bob=bob@icloud.com:apple
 *   Charlie=charlie@company.com          ← defaults to "google"
 */
function parsePeopleMap(raw: string): Map<string, Person> {
  const map = new Map<string, Person>();
  if (!raw) return map;

  for (const entry of raw.split(",")) {
    const [namePart, rest] = entry.split("=").map((s) => s.trim());
    if (!namePart || !rest) continue;

    const segments = rest.split(":");
    let email: string;
    let calendar: CalendarProvider = "google";

    if (segments.length >= 2) {
      const lastSeg = segments[segments.length - 1].toLowerCase();
      if (["google", "apple", "outlook", "other"].includes(lastSeg)) {
        calendar = lastSeg as CalendarProvider;
        email = segments.slice(0, -1).join(":");
      } else {
        email = rest;
      }
    } else {
      email = rest;
    }

    map.set(namePart.toLowerCase(), {
      name: namePart,
      email,
      calendar,
    });
  }
  return map;
}

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  gcalMcpUrl: process.env.GCAL_MCP_URL ?? "",
  gcalMcpCommand: process.env.GCAL_MCP_COMMAND ?? "",
  gcalOauthCredentials: process.env.GOOGLE_OAUTH_CREDENTIALS ?? "",
  botTrigger: process.env.BOT_TRIGGER ?? "@bot",
  timezone: process.env.TIMEZONE ?? "Europe/Prague",
  allowedChats: process.env.ALLOWED_CHATS
    ? process.env.ALLOWED_CHATS.split(",").map((s) => s.trim())
    : [],
  peopleMap: parsePeopleMap(process.env.PEOPLE_MAP ?? ""),

  // Resend settings for sending .ics invites
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "Calendar Bot <onboarding@resend.dev>",

  // OpenAI Whisper for voice message transcription
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
} as const;

export function validateConfig(): void {
  const missing: string[] = [];
  if (!config.anthropicApiKey) missing.push("ANTHROPIC_API_KEY");
  if (!config.gcalMcpUrl && !config.gcalMcpCommand) {
    missing.push("GCAL_MCP_URL or GCAL_MCP_COMMAND");
  }

  if (missing.length > 0) {
    console.error("❌ Missing required env vars:", missing.join(", "));
    process.exit(1);
  }

  if (config.peopleMap.size === 0) {
    console.warn("⚠️  PEOPLE_MAP is empty — the bot won't know anyone's email for invites.");
  }

  // Check if any non-Google users exist but Resend isn't configured
  const nonGoogleUsers = Array.from(config.peopleMap.values()).filter(
    (p) => p.calendar !== "google",
  );
  if (nonGoogleUsers.length > 0 && !config.resendApiKey) {
    console.warn(
      "⚠️  Non-Google calendar users detected but RESEND_API_KEY not set.\n" +
        "   Google Calendar still sends email invites to all attendees,\n" +
        "   which works for most setups. Set RESEND_API_KEY if you need\n" +
        "   explicit .ics file delivery as a fallback.",
    );
  }
}

/** Resolve a name (case-insensitive) to a Person, or return null */
export function resolvePerson(name: string): Person | null {
  return config.peopleMap.get(name.toLowerCase()) ?? null;
}

/** Get all registered people as a formatted string for the system prompt */
export function getPeopleList(): string {
  if (config.peopleMap.size === 0) return "No people registered.";
  return Array.from(config.peopleMap.values())
    .map((p) => `- ${p.name}: ${p.email} (${p.calendar} calendar)`)
    .join("\n");
}
