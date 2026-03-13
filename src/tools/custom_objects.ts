// Custom Objects tool group — Salesforce sObject metadata + bulk SOQL
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListSObjectsSchema = z.object({
  custom_only: z.boolean().optional().default(false).describe("If true, return only custom objects (those ending in __c)"),
  queryable_only: z.boolean().optional().default(true).describe("If true, return only queryable objects (default true)"),
  name_filter: z.string().optional().describe("Case-insensitive substring to filter object names"),
});

const DescribeObjectSchema = z.object({
  object_api_name: z.string().describe("API name of the sObject (e.g. 'Account', 'My_Object__c')"),
  include_fields: z.boolean().optional().default(true).describe("Include field definitions (default true)"),
  include_relationships: z.boolean().optional().default(true).describe("Include relationship definitions (default true)"),
  include_record_types: z.boolean().optional().default(false).describe("Include record type definitions (default false)"),
});

const ExecuteBulkQuerySchema = z.object({
  soql: z.string().describe("SOQL query to execute. Supports all standard SOQL including JOINs, aggregates, and subqueries."),
  all_rows: z.boolean().optional().default(false).describe("If true, includes deleted/archived records (queryAll). Default false."),
  max_records: z.number().min(1).max(50000).optional().default(2000).describe("Maximum records to return across all pages (default 2000, max 50000)"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_sobjects",
      title: "List sObjects",
      description: "List all Salesforce sObject types available in the org. Can filter to custom objects only or by queryability. Useful for discovering available objects before querying.",
      inputSchema: {
        type: "object",
        properties: {
          custom_only: { type: "boolean", description: "Return only custom objects (__c suffix)" },
          queryable_only: { type: "boolean", description: "Return only queryable objects (default true)" },
          name_filter: { type: "string", description: "Substring filter on object name" },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "describe_object",
      title: "Describe Object",
      description: "Get detailed metadata for a Salesforce sObject including all fields, their types, labels, and relationships. Essential for understanding object schema before writing SOQL.",
      inputSchema: {
        type: "object",
        properties: {
          object_api_name: { type: "string", description: "sObject API name (e.g. Account, My_Object__c)" },
          include_fields: { type: "boolean", description: "Include field definitions (default true)" },
          include_relationships: { type: "boolean", description: "Include relationship definitions (default true)" },
          include_record_types: { type: "boolean", description: "Include record types (default false)" },
        },
        required: ["object_api_name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "execute_bulk_query",
      title: "Execute Bulk Query",
      description: "Execute a SOQL query with automatic pagination to retrieve large result sets. Unlike execute_soql, this fetches ALL pages up to max_records. Use for exporting data or large queries.",
      inputSchema: {
        type: "object",
        properties: {
          soql: { type: "string", description: "SOQL query string" },
          all_rows: { type: "boolean", description: "Include soft-deleted records (queryAll)" },
          max_records: { type: "number", description: "Max total records to fetch (default 2000, max 50000)" },
        },
        required: ["soql"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_sobjects: async (args) => {
      const params = ListSObjectsSchema.parse(args);

      const result = await logger.time("tool.list_sobjects", () =>
        client.get<{ sobjects: Record<string, unknown>[] }>("/sobjects"), {}
      );

      let objects = result.sobjects;

      if (params.queryable_only) {
        objects = objects.filter((o) => o["queryable"] === true);
      }
      if (params.custom_only) {
        objects = objects.filter((o) => typeof o["name"] === "string" && (o["name"] as string).endsWith("__c"));
      }
      if (params.name_filter) {
        const lower = params.name_filter.toLowerCase();
        objects = objects.filter(
          (o) =>
            typeof o["name"] === "string" && (o["name"] as string).toLowerCase().includes(lower)
        );
      }

      const response = {
        total: objects.length,
        objects: objects.map((o) => ({
          name: o["name"],
          label: o["label"],
          labelPlural: o["labelPlural"],
          keyPrefix: o["keyPrefix"],
          queryable: o["queryable"],
          createable: o["createable"],
          updateable: o["updateable"],
          deletable: o["deletable"],
          custom: o["custom"],
          customSetting: o["customSetting"],
          urls: (o["urls"] as Record<string, unknown> | undefined)?.["sobject"],
        })),
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    describe_object: async (args) => {
      const params = DescribeObjectSchema.parse(args);

      const result = await logger.time("tool.describe_object", () =>
        client.get<Record<string, unknown>>(`/sobjects/${params.object_api_name}/describe`), {}
      );

      const response: Record<string, unknown> = {
        name: result["name"],
        label: result["label"],
        labelPlural: result["labelPlural"],
        keyPrefix: result["keyPrefix"],
        queryable: result["queryable"],
        createable: result["createable"],
        updateable: result["updateable"],
        deletable: result["deletable"],
        searchable: result["searchable"],
        retrieveable: result["retrieveable"],
        custom: result["custom"],
        customSetting: result["customSetting"],
      };

      if (params.include_fields && Array.isArray(result["fields"])) {
        response.fields = (result["fields"] as Record<string, unknown>[]).map((f) => ({
          name: f["name"],
          label: f["label"],
          type: f["type"],
          length: f["length"],
          nillable: f["nillable"],
          required: !f["nillable"] && !f["defaultedOnCreate"],
          createable: f["createable"],
          updateable: f["updateable"],
          unique: f["unique"],
          externalId: f["externalId"],
          referenceTo: f["referenceTo"],
          relationshipName: f["relationshipName"],
          picklistValues: Array.isArray(f["picklistValues"]) && (f["picklistValues"] as unknown[]).length > 0
            ? (f["picklistValues"] as Record<string, unknown>[]).map((p) => ({ label: p["label"], value: p["value"], active: p["active"] }))
            : undefined,
        }));
      }

      if (params.include_relationships && Array.isArray(result["childRelationships"])) {
        response.childRelationships = (result["childRelationships"] as Record<string, unknown>[]).map((r) => ({
          childSObject: r["childSObject"],
          field: r["field"],
          relationshipName: r["relationshipName"],
          cascadeDelete: r["cascadeDelete"],
        }));
      }

      if (params.include_record_types && Array.isArray(result["recordTypeInfos"])) {
        response.recordTypes = (result["recordTypeInfos"] as Record<string, unknown>[]).map((rt) => ({
          name: rt["name"],
          recordTypeId: rt["recordTypeId"],
          active: rt["active"],
          available: rt["available"],
          defaultRecordTypeMapping: rt["defaultRecordTypeMapping"],
        }));
      }

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    execute_bulk_query: async (args) => {
      const params = ExecuteBulkQuerySchema.parse(args);

      const allRecords: Record<string, unknown>[] = [];
      let totalSize = 0;
      let done = false;
      let nextUrl: string | undefined;

      // First page
      const firstPage = await logger.time("tool.execute_bulk_query.page1", () =>
        client.query(params.soql), {}
      );

      totalSize = firstPage.totalSize;
      allRecords.push(...(firstPage.records as Record<string, unknown>[]));
      done = firstPage.done;
      nextUrl = firstPage.nextRecordsUrl;

      // Follow pagination up to max_records
      while (!done && nextUrl && allRecords.length < params.max_records) {
        const cleanUrl = nextUrl.replace(/^\/services\/data\/v\d+\.\d+/, "");
        const page = await client.get<{ records: Record<string, unknown>[]; done: boolean; nextRecordsUrl?: string }>(cleanUrl);
        allRecords.push(...page.records);
        done = page.done;
        nextUrl = page.nextRecordsUrl;
      }

      const truncated = allRecords.length > params.max_records;
      const records = truncated ? allRecords.slice(0, params.max_records) : allRecords;

      const response = {
        records,
        meta: {
          totalSize,
          returned: records.length,
          hasMore: !done || truncated,
          truncatedAt: truncated ? params.max_records : undefined,
          query: params.soql,
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
