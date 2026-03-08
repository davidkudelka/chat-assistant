import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

let mcpClient: Client | null = null;
let mcpTransport: Transport | null = null;
let cachedTools: Anthropic.Tool[] = [];

/**
 * Connect to the Google Calendar MCP server.
 *
 * Supports two modes:
 * - GCAL_MCP_COMMAND: spawn a local process via stdio (e.g. "npx @cocal/google-calendar-mcp")
 * - GCAL_MCP_URL: connect to a remote HTTP/SSE server
 */
export async function connectMCP(): Promise<void> {
  mcpClient = new Client({ name: "whatsapp-calendar-bot", version: "0.1.0" });

  if (config.gcalMcpCommand) {
    const parts = config.gcalMcpCommand.split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (config.gcalOauthCredentials) {
      env.GOOGLE_OAUTH_CREDENTIALS = config.gcalOauthCredentials;
    }

    mcpTransport = new StdioClientTransport({ command, args, env });
    await mcpClient.connect(mcpTransport);
    console.log(`   MCP transport: stdio (${config.gcalMcpCommand})`);
  } else {
    const url = new URL(config.gcalMcpUrl);

    try {
      mcpTransport = new StreamableHTTPClientTransport(url);
      await mcpClient.connect(mcpTransport);
      console.log("   MCP transport: Streamable HTTP");
    } catch {
      mcpClient = new Client({ name: "whatsapp-calendar-bot", version: "0.1.0" });
      mcpTransport = new SSEClientTransport(url);
      await mcpClient.connect(mcpTransport);
      console.log("   MCP transport: SSE (fallback)");
    }
  }

  // Fetch and cache tool definitions
  const { tools } = await mcpClient.listTools();
  cachedTools = tools.map(mcpToolToAnthropic);
  console.log(`   MCP tools loaded: ${cachedTools.map((t) => t.name).join(", ")}`);
}

/**
 * Disconnect from the MCP server.
 */
export async function disconnectMCP(): Promise<void> {
  await mcpClient?.close();
  mcpClient = null;
  mcpTransport = null;
  cachedTools = [];
}

/**
 * Get the Anthropic-formatted tool definitions from the MCP server.
 */
export function getMCPTools(): Anthropic.Tool[] {
  return cachedTools;
}

/**
 * Execute a tool call on the MCP server.
 */
export async function callMCPTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (!mcpClient) {
    throw new Error("MCP client not connected");
  }

  const result = await mcpClient.callTool({ name, arguments: args });

  if (result.isError) {
    return JSON.stringify({ error: true, content: result.content });
  }

  return JSON.stringify(result.content);
}

/**
 * Convert an MCP tool definition to the Anthropic API tool format.
 */
function mcpToolToAnthropic(tool: MCPTool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  };
}
