import OpenAI, { toFile } from "openai";
import { config } from "./config.js";

let openai: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (openai) return openai;
  if (!config.openaiApiKey) return null;
  openai = new OpenAI({ apiKey: config.openaiApiKey });
  return openai;
}

/**
 * Transcribe audio using OpenAI Whisper.
 * Accepts base64-encoded audio data (OGG/Opus from WhatsApp).
 */
export async function transcribeAudio(base64Audio: string, mimetype: string): Promise<string> {
  const client = getClient();
  if (!client) {
    throw new Error("OPENAI_API_KEY not configured — cannot transcribe voice messages");
  }

  const buffer = Buffer.from(base64Audio, "base64");
  const ext = mimetype.includes("ogg") ? "ogg" : mimetype.includes("mp4") ? "m4a" : "webm";
  const file = await toFile(buffer, `voice.${ext}`, { type: mimetype });

  const response = await client.audio.transcriptions.create({
    model: "whisper-1",
    file,
  });

  return response.text;
}
