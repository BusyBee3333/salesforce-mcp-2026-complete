// SOQL tool — execute read-only SOQL queries directly against Salesforce
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const RunSoqlSchema = z.object({
  query: z.string().describe("A valid read-only SOQL query (SELECT statements only). Example: SELECT Id, Name FROM Account WHERE Industry = 'Technology' LIMIT 10"),
  fetch_all: z.boolean().optional().default(false).describe("If true, follow pagination and return all records (may be slow for large result sets). Default: false (returns first page only)"),
});

// Simple SOQL injection prevention — block DML-like patterns
function isQuerySafe(soql: string): { safe: boolean; reason?: string } {
  const normalized = soql.trim().toUpperCase();

  // Must start with SELECT
  if (!normalized.startsWith("SELECT")) {
    return { safe: false, reason: "Only SELECT queries are allowed. DML operations (INSERT, UPDATE, DELETE, UPSERT) are not permitted via run_soql." };
  }

  // Block DML keywords in suspicious positions
  const dmlPatterns = [/\bINSERT\b/, /\bUPDATE\b/, /\bDELETE\b/, /\bUPSERT\b/, /\bMERGE\b/, /\bUNDELETE\b/];
  for (const pattern of dmlPatterns) {
    if (pattern.test(normalized)) {
      return { safe: false, reason: `Query contains disallowed keyword. Only SELECT queries are permitted.` };
    }
  }

  return { safe: true };
}

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "run_soql",
      title: "Run SOQL Query",
      description:
        "Execute a read-only SOQL (Salesforce Object Query Language) SELECT query. Use when predefined tools don't cover your needs, or for ad-hoc analytics, cross-object queries, or custom field access. Only SELECT is allowed — DML operations are blocked. Example: SELECT Id, Name, StageName, Amount FROM Opportunity WHERE StageName = 'Prospecting' ORDER BY Amount DESC LIMIT 20",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Valid SOQL SELECT query. Only SELECT is allowed.",
          },
          fetch_all: {
            type: "boolean",
            description: "If true, follow pagination to return all records. Default: false.",
          },
        },
        required: ["query"],
      },
      outputSchema: {
        type: "object",
        properties: {
          records: { type: "array" },
          meta: {
            type: "object",
            properties: {
              totalSize: { type: "number" },
              returned: { type: "number" },
              done: { type: "boolean" },
            },
          },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    run_soql: async (args) => {
      const params = RunSoqlSchema.parse(args);

      const safetyCheck = isQuerySafe(params.query);
      if (!safetyCheck.safe) {
        const error = { error: safetyCheck.reason, query: params.query };
        return {
          content: [{ type: "text", text: JSON.stringify(error, null, 2) }],
          structuredContent: error,
          isError: true,
        };
      }

      let records: unknown[];
      let meta: { totalSize: number; returned: number; done: boolean };

      if (params.fetch_all) {
        const allRecords = await logger.time("tool.run_soql.all", () =>
          client.queryAll(params.query), { query: params.query.slice(0, 100) }
        );
        records = allRecords;
        meta = { totalSize: allRecords.length, returned: allRecords.length, done: true };
      } else {
        const result = await logger.time("tool.run_soql", () =>
          client.query(params.query), { query: params.query.slice(0, 100) }
        );
        records = result.records;
        meta = {
          totalSize: result.totalSize,
          returned: result.records.length,
          done: result.done,
        };
      }

      const response = { records, meta };
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
      };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
