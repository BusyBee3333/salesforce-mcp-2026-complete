// Limits tool group — Salesforce Org API Limits
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const GetLimitsSchema = z.object({
  filter: z.string().optional().describe("Optional substring filter on limit name (case-insensitive)"),
});

const CheckLimitSchema = z.object({
  limit_name: z.string().describe("Exact limit name, e.g. 'DailyApiRequests', 'DataStorageMB'"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "get_org_limits",
      title: "Get Org API Limits",
      description: "Retrieve all Salesforce org API limits — daily API requests, bulk API batches, data storage, file storage, streaming events, etc. Shows current usage and max allowed values.",
      inputSchema: {
        type: "object",
        properties: {
          filter: { type: "string", description: "Optional substring filter on limit name (case-insensitive)" },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "check_limit",
      title: "Check Specific Limit",
      description: "Check the current usage and maximum for a specific Salesforce org limit by name (e.g. 'DailyApiRequests', 'DataStorageMB', 'HourlyTimeBasedWorkflow').",
      inputSchema: {
        type: "object",
        properties: {
          limit_name: { type: "string", description: "Exact limit name from the Limits API" },
        },
        required: ["limit_name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    get_org_limits: async (args) => {
      const params = GetLimitsSchema.parse(args);
      const result = await logger.time("tool.get_org_limits", () =>
        client.get<Record<string, { Max: number; Remaining: number }>>("/limits/"), {}
      );

      let entries = Object.entries(result).map(([name, data]) => ({
        name,
        max: data.Max,
        remaining: data.Remaining,
        used: data.Max - data.Remaining,
        usedPercent: data.Max > 0 ? Math.round(((data.Max - data.Remaining) / data.Max) * 100) : 0,
      }));

      if (params.filter) {
        const f = params.filter.toLowerCase();
        entries = entries.filter((e) => e.name.toLowerCase().includes(f));
      }

      entries.sort((a, b) => b.usedPercent - a.usedPercent);

      const response = {
        limits: entries,
        meta: { total: entries.length },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    check_limit: async (args) => {
      const { limit_name } = CheckLimitSchema.parse(args);
      const result = await logger.time("tool.check_limit", () =>
        client.get<Record<string, { Max: number; Remaining: number }>>("/limits/"), {}
      );

      const data = result[limit_name];
      if (!data) {
        const available = Object.keys(result).filter((k) =>
          k.toLowerCase().includes(limit_name.toLowerCase())
        );
        const response = {
          error: `Limit '${limit_name}' not found.`,
          suggestions: available.slice(0, 10),
        };
        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
      }

      const response = {
        name: limit_name,
        max: data.Max,
        remaining: data.Remaining,
        used: data.Max - data.Remaining,
        usedPercent: data.Max > 0 ? Math.round(((data.Max - data.Remaining) / data.Max) * 100) : 0,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
