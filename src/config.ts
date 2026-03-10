import dotenv from "dotenv";
dotenv.config();

export type CalendarProvider = "google" | "apple" | "outlook" | "other";
export type PersonRole = "client" | "trainer";

export interface Person {
  name: string;
  email: string;
  calendar: CalendarProvider;
  role: PersonRole;
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

  if (!config.resendApiKey) {
    console.warn("⚠️  RESEND_API_KEY not set — .ics email delivery will be unavailable");
  }
  if (!config.openaiApiKey) {
    console.warn("⚠️  OPENAI_API_KEY not set — voice message transcription will be unavailable");
  }
}
