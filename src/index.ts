import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
type Message = pkg.Message;
type GroupChat = pkg.GroupChat;
import qrcode from "qrcode-terminal";
import { config, validateConfig } from "./config.js";
import { runAgent } from "./agent.js";
import { cleanupStale } from "./conversation-store.js";
import { connectMCP, disconnectMCP } from "./mcp-client.js";

validateConfig();

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
  console.log(`   Registered people: ${config.peopleMap.size}`);

  try {
    console.log(`   MCP endpoint: ${config.gcalMcpUrl}`);
    await connectMCP();
    console.log("✅ MCP connected.");
  } catch (err) {
    console.error("❌ Failed to connect to MCP server:", err);
    process.exit(1);
  }

  console.log("\nListening for messages...\n");
});

// ── Message Handler ──
client.on("message_create", async (msg: Message) => {
  if (msg.isStatus || !msg.body) return;

  // Log every incoming message's chat ID for discovery
  console.log(`💬 [${msg.from}] ${msg.body.slice(0, 50)}`);

  const body = msg.body.trim();
  const trigger = config.botTrigger.toLowerCase();

  // Only respond to messages that start with the trigger keyword
  if (!body.toLowerCase().startsWith(trigger)) return;

  // Access control
  const chatId = msg.from;
  if (config.allowedChats.length > 0 && !config.allowedChats.includes(chatId)) {
    return;
  }

  // Strip the trigger keyword from the message
  const userMessage = body.slice(config.botTrigger.length).trim();
  if (!userMessage) {
    await msg.reply(
      `👋 I'm your calendar bot! Just say:\n\n` +
        `*${config.botTrigger} schedule a meeting between Alice and Bob tomorrow at 3pm*\n` +
        `*${config.botTrigger} what meetings do Alice and Bob have this week?*\n` +
        `*${config.botTrigger} cancel the standup on Friday*`,
    );
    return;
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
    // Resolve participant names
    const names: string[] = [];
    for (const p of groupParticipants.slice(0, 20)) {
      // limit to avoid huge lists
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

  try {
    // Show typing indicator
    const chatObj = await msg.getChat();
    await chatObj.sendStateTyping();

    // Run the AI agent
    const reply = await runAgent(chatId, senderName, userMessage, participants);

    console.log(`🤖 [${chatId}] Reply: ${reply.slice(0, 100)}...`);
    await msg.reply(reply);
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

client.on("disconnected", (reason) => {
  console.warn("⚠️ Disconnected:", reason);
  process.exit(1);
});

// Cleanup stale conversations every 10 minutes
setInterval(cleanupStale, 10 * 60 * 1000);

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await disconnectMCP();
  await client.destroy();
  process.exit(0);
});

// ── Start ──
client.initialize();
