/// <reference types="node" />
// Orrery as an MCP server over stdio: any MCP client (Claude Code, Cursor, Gemini CLI, …) can check, compile,
// simulate and share Orrery projects with its own model. Everything runs on the user's machine; sketches are
// compiled with the user's arduino-cli. Build with `npm run build:mcp`, run with `node dist-mcp/server.mjs`.
import { readFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { compile } from '../../scripts/arduino-cli.mjs';
import { SERVER_INSTRUCTIONS, TOOLS, callTool, type ToolContext } from './tools';

const ctx: ToolContext = {
  compile,
  readFile: (path) => readFile(path, 'utf8'),
};

const server = new Server({ name: 'orrery', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as { name: string; inputSchema: { type: 'object' } }[] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const r = await callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, ctx);
    return { content: [{ type: 'text', text: r.text }], isError: r.isError ?? false };
  } catch (e) {
    return { content: [{ type: 'text', text: `Orrery failed: ${(e as Error).stack ?? String(e)}` }], isError: true };
  }
});

// stdout carries the protocol: anything else goes to stderr
console.log = console.error;
await server.connect(new StdioServerTransport());
