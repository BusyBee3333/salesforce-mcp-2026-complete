// Health check tool — validates environment, API connectivity, and Salesforce auth
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "health_check",
      title: "Health Check",
      description:
        "Validate server health: checks that Salesforce credentials are configured, the API is reachable, and OAuth token is valid. Returns connectivity status and API version. Use when diagnosing connection issues or verifying server setup.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      outputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["healthy", "degraded", "unhealthy"] },
          checks: {
            type: "object",
            properties: {
              envVars: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  missing: { type: "array", items: { type: "string" } },
                },
              },
              apiReachable: { type: "boolean" },
              authValid: { type: "boolean" },
              latencyMs: { type: "number" },
              apiVersion: { type: "string" },
            },
          },
          error: { type: "string" },
        },
        required: ["status", "checks"],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    health_check: async () => {
      const requiredEnvVars = [
        "SALESFORCE_CLIENT_ID",
        "SALESFORCE_CLIENT_SECRET",
        "SALESFORCE_USERNAME",
        "SALESFORCE_PASSWORD",
        "SALESFORCE_INSTANCE_URL",
      ];
      const missing = requiredEnvVars.filter((v) => !process.env[v]);
      const envCheck = { ok: missing.length === 0, missing };

      const healthResult = await client.healthCheck();

      let status: "healthy" | "degraded" | "unhealthy";
      if (missing.length > 0 || !healthResult.reachable) {
        status = "unhealthy";
      } else if (!healthResult.authenticated) {
        status = "degraded";
      } else {
        status = "healthy";
      }

      const result = {
        status,
        checks: {
          envVars: envCheck,
          apiReachable: healthResult.reachable,
          authValid: healthResult.authenticated,
          latencyMs: healthResult.latencyMs,
          apiVersion: healthResult.apiVersion,
          orgId: healthResult.orgId,
        },
        ...(healthResult.error ? { error: healthResult.error } : {}),
      };

      logger.info("health_check", { status });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return {
    tools: getToolDefinitions(),
    handlers: getToolHandlers(client),
  };
}
