#!/usr/bin/env node
/**
 * Salesforce MCP Server
 * Production-quality MCP server for Salesforce CRM.
 * 19 tools: Leads, Contacts, Accounts, Opportunities, Cases, SOQL
 * Auth: OAuth 2.0 (Username-Password flow) with auto-refresh
 * Transport: stdio (default) or HTTP (MCP_TRANSPORT=http)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SalesforceClient } from "./client.js";
import { ToolRegistry } from "./tools/index.js";
import { logger } from "./logger.js";

const SERVER_NAME = "salesforce-mcp";
const SERVER_VERSION = "1.0.0";

async function main() {
  // Validate required environment variables
  const required = [
    "SALESFORCE_CLIENT_ID",
    "SALESFORCE_CLIENT_SECRET",
    "SALESFORCE_USERNAME",
    "SALESFORCE_PASSWORD",
    "SALESFORCE_INSTANCE_URL",
  ];

  const missing = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "startup.missing_env",
        missing,
        hint: "Copy .env.example to .env and fill in your Salesforce credentials",
      }) + "\n"
    );
    process.exit(1);
  }

  // Initialize Salesforce client
  const client = new SalesforceClient({
    clientId: process.env.SALESFORCE_CLIENT_ID!,
    clientSecret: process.env.SALESFORCE_CLIENT_SECRET!,
    username: process.env.SALESFORCE_USERNAME!,
    password: process.env.SALESFORCE_PASSWORD!,
    instanceUrl: process.env.SALESFORCE_INSTANCE_URL!,
    loginUrl: process.env.SALESFORCE_LOGIN_URL,
  });

  // Initialize tool registry
  const registry = new ToolRegistry(client);

  // Create MCP server
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Load all tool groups and register them
  const allTools = await registry.getAllTools();
  logger.info("tools.loaded", { count: allTools.length });

  for (const tool of allTools) {
    // Build a Zod object schema from the tool's inputSchema properties
    const schemaProps: Record<string, z.ZodTypeAny> = {};
    const inputProps = (tool.inputSchema as {
      type: string;
      properties?: Record<string, { type?: string; description?: string; enum?: string[] }>;
      required?: string[];
    }).properties || {};

    for (const [key, prop] of Object.entries(inputProps)) {
      let fieldSchema: z.ZodTypeAny;

      if (prop.enum) {
        fieldSchema = z.enum(prop.enum as [string, ...string[]]).optional();
      } else if (prop.type === "number") {
        fieldSchema = z.number().optional();
      } else if (prop.type === "boolean") {
        fieldSchema = z.boolean().optional();
      } else {
        fieldSchema = z.string().optional();
      }

      if (prop.description) {
        fieldSchema = fieldSchema.describe(prop.description);
      }

      schemaProps[key] = fieldSchema;
    }

    const handler = await registry.getHandler(tool.name);

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: schemaProps,
        annotations: tool.annotations,
      },
      async (args) => {
        const requestId = logger.requestId();
        const start = performance.now();
        logger.info("tool.call.start", { requestId, tool: tool.name });

        try {
          const result = await handler(args as Record<string, unknown>);
          const durationMs = Math.round(performance.now() - start);
          logger.info("tool.call.done", { requestId, tool: tool.name, durationMs });
          return result as {
            content: Array<{ type: "text"; text: string }>;
            structuredContent?: Record<string, unknown>;
            isError?: boolean;
          };
        } catch (error) {
          const durationMs = Math.round(performance.now() - start);
          let message: string;

          if (error instanceof z.ZodError) {
            message = `Validation error: ${error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`;
            logger.warn("tool.call.validation_error", { requestId, tool: tool.name, durationMs });
          } else if (error instanceof Error) {
            message = error.message;
            logger.error("tool.call.error", { requestId, tool: tool.name, durationMs, error: message });
          } else {
            message = String(error);
            logger.error("tool.call.error", { requestId, tool: tool.name, durationMs, error: message });
          }

          return {
            content: [{ type: "text" as const, text: `Error: ${message}` }],
            structuredContent: { error: message, tool: tool.name } as Record<string, unknown>,
            isError: true,
          };
        }
      }
    );
  }

  // Transport selection
  const transportMode = process.env.MCP_TRANSPORT || "stdio";

  if (transportMode === "http") {
    await startHttpTransport(server);
  } else {
    await startStdioTransport(server);
  }
}

async function startStdioTransport(server: McpServer) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("server.started", { transport: "stdio", name: SERVER_NAME, version: SERVER_VERSION });
}

async function startHttpTransport(server: McpServer) {
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { createServer } = await import("http");

  const port = parseInt(process.env.MCP_HTTP_PORT || "3000", 10);
  const sessions = new Map<string, { transport: InstanceType<typeof StreamableHTTPServerTransport>; lastActivity: number }>();
  const MAX_SESSIONS = 100;
  const SESSION_TTL_MS = 30 * 60 * 1000;

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        sessions.delete(id);
        logger.info("session.expired", { sessionId: id });
      }
    }
  }, 60_000);

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, sessions: sessions.size }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "POST") {
        let transport: InstanceType<typeof StreamableHTTPServerTransport>;

        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          session.lastActivity = Date.now();
          transport = session.transport;
        } else {
          if (sessions.size >= MAX_SESSIONS) {
            // Evict oldest
            let oldest: string | null = null;
            let oldestTime = Infinity;
            for (const [id, s] of sessions.entries()) {
              if (s.lastActivity < oldestTime) { oldestTime = s.lastActivity; oldest = id; }
            }
            if (oldest) sessions.delete(oldest);
          }

          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
          await server.connect(transport);
          const newId = transport.sessionId;
          if (newId) sessions.set(newId, { transport, lastActivity: Date.now() });
        }

        await transport.handleRequest(req, res);
        return;
      }

      if (req.method === "GET" && sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.lastActivity = Date.now();
        await session.transport.handleRequest(req, res);
        return;
      }

      if (req.method === "DELETE" && sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        sessions.delete(sessionId);
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request" }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  process.on("SIGTERM", () => {
    clearInterval(cleanupInterval);
    sessions.clear();
    httpServer.close();
  });

  httpServer.listen(port, () => {
    logger.info("server.started", { transport: "http", name: SERVER_NAME, port, endpoint: "/mcp" });
  });
}

main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "server.fatal",
      error: error instanceof Error ? error.message : String(error),
    }) + "\n"
  );
  process.exit(1);
});
