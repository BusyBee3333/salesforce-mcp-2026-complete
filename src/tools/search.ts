// Search tool group — Salesforce SOSL search and Parameterized Search API
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const SoslSearchSchema = z.object({
  search_string: z.string().describe("SOSL search string (the FIND clause value, e.g. 'John Smith')"),
  objects: z.array(z.string()).optional().describe("SObject types to search (e.g. ['Account','Contact']). Defaults to all searchable objects."),
  fields_map: z.record(z.array(z.string())).optional().describe("Map of object -> fields to return, e.g. {\"Account\":[\"Id\",\"Name\"],\"Contact\":[\"Id\",\"Email\"]}"),
  limit: z.number().min(1).max(200).optional().default(25).describe("Max records per object"),
  search_group: z.enum(["ALL FIELDS", "NAME FIELDS", "EMAIL FIELDS", "PHONE FIELDS", "SIDEBAR FIELDS"]).optional().default("ALL FIELDS"),
});

const ParameterizedSearchSchema = z.object({
  query: z.string().describe("Search query string"),
  sobject: z.string().describe("SObject type to search (e.g. 'Account')"),
  fields: z.array(z.string()).optional().describe("Fields to return (defaults to Id, Name)"),
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  where: z.string().optional().describe("Optional SOQL WHERE clause to add (without WHERE keyword)"),
  order_by: z.string().optional().describe("ORDER BY field"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
  spell_correction: z.boolean().optional().default(true),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "sosl_search",
      title: "SOSL Search",
      description: "Execute a Salesforce SOSL (Salesforce Object Search Language) search across multiple objects simultaneously. Ideal for global search across Account, Contact, Lead, Opportunity, etc. Returns matched records grouped by object type.",
      inputSchema: {
        type: "object",
        properties: {
          search_string: { type: "string", description: "Search text (FIND clause value)" },
          objects: { type: "array", items: { type: "string" }, description: "Objects to search (default: all searchable)" },
          fields_map: { type: "object", description: "Object -> fields map (e.g. {\"Account\":[\"Id\",\"Name\"]})" },
          limit: { type: "number", description: "Max records per object (default 25, max 200)" },
          search_group: { type: "string", enum: ["ALL FIELDS", "NAME FIELDS", "EMAIL FIELDS", "PHONE FIELDS", "SIDEBAR FIELDS"] },
        },
        required: ["search_string"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "parameterized_search",
      title: "Parameterized Search",
      description: "Execute a Salesforce parameterized search against a single object using the Search REST API. More flexible than SOSL for single-object searches. Supports WHERE clauses, pagination, and spell correction.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search text" },
          sobject: { type: "string", description: "SObject to search (e.g. 'Account')" },
          fields: { type: "array", items: { type: "string" }, description: "Fields to return" },
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          where: { type: "string", description: "Additional SOQL WHERE clause" },
          order_by: { type: "string", description: "ORDER BY field" },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
          spell_correction: { type: "boolean", description: "Enable spell correction (default true)" },
        },
        required: ["query", "sobject"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    sosl_search: async (args) => {
      const params = SoslSearchSchema.parse(args);

      const escaped = params.search_string.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      let sosl = `FIND {${escaped}} IN ${params.search_group}`;

      if (params.objects && params.objects.length > 0) {
        const returning = params.objects.map((obj) => {
          const fields = params.fields_map?.[obj] || ["Id", "Name"];
          return `${obj}(${fields.join(",")})`;
        });
        sosl += ` RETURNING ${returning.join(", ")}`;
      }

      sosl += ` LIMIT ${params.limit}`;

      const encoded = encodeURIComponent(sosl);
      const result = await logger.time("tool.sosl_search", () =>
        client.get<{ searchRecords: Record<string, unknown>[] }>(`/search/?q=${encoded}`), {}
      );

      const byType: Record<string, unknown[]> = {};
      let totalCount = 0;
      for (const record of result.searchRecords || []) {
        const attr = record["attributes"] as Record<string, unknown> | undefined;
        const type = attr ? String(attr["type"] || "Unknown") : "Unknown";
        if (!byType[type]) byType[type] = [];
        byType[type].push(record);
        totalCount++;
      }

      const response = {
        searchString: params.search_string,
        byType,
        totalFound: totalCount,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    parameterized_search: async (args) => {
      const params = ParameterizedSearchSchema.parse(args);
      const fields = params.fields || ["Id", "Name"];

      const body: Record<string, unknown> = {
        q: params.query,
        fields,
        sobjects: [{ name: params.sobject }],
        in: "ALL FIELDS",
        overallLimit: params.limit,
        defaultLimit: params.limit,
        offset: params.offset,
        spellCorrection: params.spell_correction,
      };

      if (params.where) {
        body["sobjects"] = [{ name: params.sobject, where: params.where }];
      }
      if (params.order_by) {
        body["orderBy"] = [{ field: params.order_by, direction: params.order_dir }];
      }

      const result = await logger.time("tool.parameterized_search", () =>
        client.post<{ searchRecords: Record<string, unknown>[]; totalCount?: number }>("/parameterizedSearch/", body), {}
      );

      const response = {
        query: params.query,
        sobject: params.sobject,
        records: result.searchRecords || [],
        totalFound: (result.searchRecords || []).length,
        hasMore: (result.searchRecords || []).length === params.limit,
        offset: params.offset,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
