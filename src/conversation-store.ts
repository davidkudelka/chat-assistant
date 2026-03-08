import Anthropic from "@anthropic-ai/sdk";

type Message = Anthropic.MessageParam;

interface ChatHistory {
  messages: Message[];
  lastActivity: number;
}

const MAX_MESSAGES_PER_CHAT = 20;
const HISTORY_TTL_MS = 30 * 60 * 1000; // 30 minutes

const store = new Map<string, ChatHistory>();

/**
 * Get conversation history for a chat, pruning stale conversations.
 */
export function getHistory(chatId: string): Message[] {
  const entry = store.get(chatId);
  if (!entry) return [];

  // If conversation is stale, reset it
  if (Date.now() - entry.lastActivity > HISTORY_TTL_MS) {
    store.delete(chatId);
    return [];
  }

  return entry.messages;
}

/**
 * Append a user message and assistant response to the history.
 */
export function pushExchange(chatId: string, userMsg: string, assistantMsg: string): void {
  const history = getHistory(chatId);

  history.push({ role: "user", content: userMsg }, { role: "assistant", content: assistantMsg });

  // Trim to keep only the last N messages
  while (history.length > MAX_MESSAGES_PER_CHAT) {
    history.shift();
  }

  store.set(chatId, {
    messages: history,
    lastActivity: Date.now(),
  });
}

/**
 * Clear history for a specific chat.
 */
export function clearHistory(chatId: string): void {
  store.delete(chatId);
}

/**
 * Periodic cleanup of all stale conversations.
 */
export function cleanupStale(): void {
  const now = Date.now();
  for (const [chatId, entry] of store) {
    if (now - entry.lastActivity > HISTORY_TTL_MS) {
      store.delete(chatId);
    }
  }
}
