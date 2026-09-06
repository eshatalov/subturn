#!/usr/bin/env node
// faces/mcp.ts — the MCP stdio face: exactly five tools (spawn, resume,
// await, cancel, inspect), derived from the shared verb table. A thin single-file
// adapter; holds no state, assumes stateless clients, and may die and
// restart without touching running sessions (they live under their own
// detached supervisors). A thrown core error (e.g. a launch that failed
// before the harness produced a session) surfaces as a plain MCP tool
// error with the detail inline.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { verbs, instructions } from "./interface.ts";

export function buildServer(): Server {
  const server = new Server(
    { name: "subturn", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: verbs.map((v) => ({
      name: v.name,
      description: v.description,
      inputSchema: v.inputSchema,
      annotations: v.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const verb = verbs.find((v) => v.name === request.params.name);
    if (verb === undefined) {
      return {
        content: [{ type: "text", text: `unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await verb.run(request.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      };
    }
  });

  return server;
}

export async function startMcpServer(): Promise<void> {
  await buildServer().connect(new StdioServerTransport());
}

// Started directly (`node dist/faces/mcp.js`) — run; imported (CLI `serve`,
// tests) — the caller decides.
const entry = process.argv[1] ?? "";
if (entry.endsWith("/mcp.js") || entry.endsWith("/mcp.ts")) {
  startMcpServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
