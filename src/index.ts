import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
type Message = pkg.Message;
type GroupChat = pkg.GroupChat;
import qrcode from "qrcode-terminal";
import { config, validateConfig } from "./config.js";
import { runAgent, type ProgressCallback } from "./agent.js";
import { connectMCPWithRetry, disconnectMCP } from "./mcp-client.js";
import { initDB, closeDB } from "./db.js";
import { transcribeAudio } from "./transcribe.js";

import { mkdirSync } from "fs";

/** Per-chat cooldown to prevent duplicate agent runs from rapid taps. */
const DEDUP_COOLDOWN_MS = 3_000;
const lastProcessed = new Map<string, number>();

validateConfig();

// Ensure data directory exists and initialize database
mkdirSync(process.env.DATA_DIR ?? "./data", { recursive: true });
initDB();

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

// ── QR Auth ──
client.on("qr", (qr) => {
  console.log("\n📱 Scan this QR code with WhatsApp:\n");
  qrcode.generate(qr, { small: true });
});

// ── Ready ──
client.on("ready", async () => {
  console.log("✅ WhatsApp Calendar Bot is online.");
  console.log(`   Trigger keyword: "${config.botTrigger}"`);
  console.log(`   Timezone: ${config.timezone}`);
  console.log("   People registry: SQLite-backed");

  try {
    console.log(`   MCP endpoint: ${config.gcalMcpUrl || config.gcalMcpCommand}`);
    await connectMCPWithRetry();
    console.log("✅ MCP connected.");
  } catch (err) {
    console.error("❌ Failed to connect to MCP server after all retries:", err);
    process.exit(1);
  }

  console.log("\nListening for messages...\n");
});

// ── Message Handler ──
client.on("message_create", async (msg: Message) => {
  if (msg.isStatus) return;

  const chatId = msg.from;
  const isVoice = msg.type === "ptt" || msg.type === "audio";

  // Text messages need a body; voice messages don't
  if (!isVoice && !msg.body) return;

  // Log for discovery
  if (msg.body) {
    console.log(`💬 [${chatId}] ${msg.body.slice(0, 50)}`);
  }

  // Access control
  if (config.allowedChats.length > 0 && !config.allowedChats.includes(chatId)) {
    return;
  }

  let userMessage: string;

  if (isVoice) {
    // Voice message — transcribe and process (no trigger needed)
    console.log(`🎤 [${chatId}] Voice message received, transcribing...`);
    try {
      const media = await msg.downloadMedia();
      if (!media) {
        console.error(`❌ [${chatId}] Failed to download voice message`);
        return;
      }
      userMessage = await transcribeAudio(media.data, media.mimetype);
      console.log(`🎤 [${chatId}] Transcribed: ${userMessage.slice(0, 80)}`);
    } catch (err) {
      console.error(`❌ [${chatId}] Transcription failed:`, err);
      await msg.reply("⚠️ Couldn't process the voice message. Please try typing instead.");
      return;
    }
  } else {
    // Text message — check trigger
    const body = msg.body.trim();
    const trigger = config.botTrigger.toLowerCase();

    if (!body.toLowerCase().startsWith(trigger)) return;

    userMessage = body.slice(config.botTrigger.length).trim();
    if (!userMessage) {
      await msg.reply(
        `👋 I'm your calendar bot! Just say:\n\n` +
          `*${config.botTrigger} schedule a meeting between Alice and Bob tomorrow at 3pm*\n` +
          `*${config.botTrigger} what meetings do Alice and Bob have this week?*\n` +
          `*${config.botTrigger} cancel the standup on Friday*`,
      );
      return;
    }
  }

  // Get sender info
  const contact = await msg.getContact();
  const senderName = contact.pushname || contact.name || contact.number;

  // Get chat participants (for group chats)
  let participants: string[] = [senderName];
  const chat = await msg.getChat();
  if (chat.isGroup) {
    const groupChat = chat as GroupChat;
    const groupParticipants = groupChat.participants || [];
    const names: string[] = [];
    for (const p of groupParticipants.slice(0, 20)) {
      try {
        const c = await client.getContactById(p.id._serialized);
        names.push(c.pushname || c.name || c.number);
      } catch {
        names.push(p.id.user);
      }
    }
    participants = names;
  }

  console.log(`📨 [${chatId}] ${senderName}: ${userMessage}`);

  // Deduplication: ignore if same chat triggered agent recently
  const now = Date.now();
  const lastTime = lastProcessed.get(chatId) ?? 0;
  if (now - lastTime < DEDUP_COOLDOWN_MS) {
    console.log(`⏭️ [${chatId}] Skipped (cooldown: ${now - lastTime}ms since last)`);
    return;
  }
  lastProcessed.set(chatId, now);

  try {
    const statusMsg = await msg.reply("⏳ Processing your request...");

    const onProgress: ProgressCallback = async (status) => {
      if (statusMsg) await statusMsg.edit(status);
    };

    const reply = await runAgent(senderName, userMessage, participants, onProgress);

    // Edit the status message with the final reply
    if (statusMsg) {
      await statusMsg.edit(reply);
    } else {
      await msg.reply(reply);
    }

    console.log(`🤖 [${chatId}] Reply: ${reply.slice(0, 100)}...`);
  } catch (err) {
    console.error(`❌ Agent error [${chatId}]:`, err);
    await msg.reply("⚠️ Something went wrong. Please try again.");
  }
});

// ── Lifecycle ──
client.on("auth_failure", (err) => {
  console.error("❌ Auth failure:", err);
  process.exit(1);
});

client.on("change_state", (state) => {
  console.log(`📡 WhatsApp state: ${state}`);
});

client.on("disconnected", (reason) => {
  console.warn("⚠️ Disconnected:", reason);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await disconnectMCP();
  closeDB();
  await client.destroy();
  process.exit(0);
});

// ── Start ──
client.initialize();
