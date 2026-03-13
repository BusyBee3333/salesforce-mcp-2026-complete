// SOQL/SOSL/Describe tool group — raw query and schema exploration
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const RunSoqlSchema = z.object({
  query: z.string().describe("A valid read-only SOQL query (SELECT statements only). Example: SELECT Id, Name FROM Account WHERE Industry = 'Technology' LIMIT 10"),
  fetch_all: z.boolean().optional().default(false).describe("If true, follow pagination and return all records (may be slow for large result sets). Default: false (returns first page only)"),
});

const ExecuteSoslSchema = z.object({
  search: z.string().describe("A valid SOSL search string. Example: FIND {Acme} IN ALL FIELDS RETURNING Account(Id, Name), Contact(FirstName, LastName)"),
});

const DescribeGlobalSchema = z.object({
  include_custom: z.boolean().optional().default(true).describe("Include custom objects (default: true)"),
  include_standard: z.boolean().optional().default(true).describe("Include standard objects (default: true)"),
  queryable_only: z.boolean().optional().default(true).describe("Only return objects that are queryable via SOQL (default: true)"),
  search: z.string().optional().describe("Filter object names by this string (case-insensitive LIKE match)"),
});

// Simple SOQL injection prevention — block DML-like patterns
function isQuerySafe(soql: string): { safe: boolean; reason?: string } {
  const normalized = soql.trim().toUpperCase();

  if (!normalized.startsWith("SELECT")) {
    return { safe: false, reason: "Only SELECT queries are allowed. DML operations (INSERT, UPDATE, DELETE, UPSERT) are not permitted via run_soql." };
  }

  const dmlPatterns = [/\bINSERT\b/, /\bUPDATE\b/, /\bDELETE\b/, /\bUPSERT\b/, /\bMERGE\b/, /\bUNDELETE\b/];
  for (const pattern of dmlPatterns) {
    if (pattern.test(normalized)) {
      return { safe: false, reason: `Query contains disallowed keyword. Only SELECT queries are permitted.` };
    }
  }

  return { safe: true };
}

// Simple SOSL validation
function isSoslSafe(sosl: string): { safe: boolean; reason?: string } {
  const normalized = sosl.trim().toUpperCase();
  if (!normalized.startsWith("FIND")) {
    return { safe: false, reason: "SOSL searches must start with FIND {term}." };
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
    {
      name: "execute_sosl",
      title: "Execute SOSL Search",
      description:
        "Execute a Salesforce Object Search Language (SOSL) query across multiple objects. SOSL is a full-text search language — use it when you don't know which object a record is in, or to search across Account, Contact, Lead, and Opportunity simultaneously. Example: FIND {John Smith} IN ALL FIELDS RETURNING Account(Id, Name), Contact(FirstName, LastName, Email)",
      inputSchema: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description: "Valid SOSL FIND query. Must start with FIND {term}.",
          },
        },
        required: ["search"],
      },
      outputSchema: {
        type: "object",
        properties: {
          searchRecords: { type: "array" },
          meta: { type: "object" },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      name: "describe_global",
      title: "Describe Global (List All SObjects)",
      description:
        "List all Salesforce SObject types available in the org using the /sobjects/ describe endpoint. Returns object API names, labels, queryable status, and whether they are custom. Use to discover available objects before writing SOQL/SOSL, or when a user asks what objects exist.",
      inputSchema: {
        type: "object",
        properties: {
          include_custom: { type: "boolean", description: "Include custom objects (default: true)" },
          include_standard: { type: "boolean", description: "Include standard objects (default: true)" },
          queryable_only: { type: "boolean", description: "Only return queryable objects (default: true)" },
          search: { type: "string", description: "Filter by object API name (case-insensitive)" },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          objects: { type: "array" },
          meta: { type: "object" },
        },
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

    execute_sosl: async (args) => {
      const params = ExecuteSoslSchema.parse(args);

      const safetyCheck = isSoslSafe(params.search);
      if (!safetyCheck.safe) {
        const error = { error: safetyCheck.reason, search: params.search };
        return {
          content: [{ type: "text", text: JSON.stringify(error, null, 2) }],
          structuredContent: error,
          isError: true,
        };
      }

      const result = await logger.time("tool.execute_sosl", () =>
        client.request<{ searchRecords: unknown[] }>(`/search/?q=${encodeURIComponent(params.search)}`),
        { search: params.search.slice(0, 100) }
      );

      const response = {
        searchRecords: result.searchRecords || [],
        meta: {
          returned: result.searchRecords?.length ?? 0,
          query: params.search,
        },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
      };
    },

    describe_global: async (args) => {
      const params = DescribeGlobalSchema.parse(args);

      const result = await logger.time("tool.describe_global", () =>
        client.get<{ sobjects: Record<string, unknown>[] }>("/sobjects/"), {}
      );

      let objects = result.sobjects || [];

      // Apply filters
      if (params.queryable_only) {
        objects = objects.filter((o) => o["queryable"] === true);
      }
      if (!params.include_custom) {
        objects = objects.filter((o) => o["custom"] !== true);
      }
      if (!params.include_standard) {
        objects = objects.filter((o) => o["custom"] === true);
      }
      if (params.search) {
        const needle = params.search.toLowerCase();
        objects = objects.filter(
          (o) =>
            String(o["name"] || "").toLowerCase().includes(needle) ||
            String(o["label"] || "").toLowerCase().includes(needle)
        );
      }

      const response = {
        objects: objects.map((o) => ({
          name: o["name"],
          label: o["label"],
          labelPlural: o["labelPlural"],
          custom: o["custom"],
          queryable: o["queryable"],
          createable: o["createable"],
          updateable: o["updateable"],
          deletable: o["deletable"],
          searchable: o["searchable"],
          urls: o["urls"],
        })),
        meta: {
          total: objects.length,
          includesCustom: params.include_custom,
          includesStandard: params.include_standard,
          queryableOnly: params.queryable_only,
        },
      };

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
