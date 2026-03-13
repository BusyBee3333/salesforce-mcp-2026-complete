// Apex tool group — Salesforce Apex REST execution, anonymous apex, and debug logs
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ExecuteAnonymousSchema = z.object({
  apex_code: z.string().describe("Apex code to execute anonymously (required)"),
  log_level: z.enum(["NONE", "ERROR", "WARN", "INFO", "DEBUG", "FINE", "FINER", "FINEST"]).optional().default("DEBUG"),
});

const ListApexClassesSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  name_filter: z.string().optional().describe("Filter by class name (case-insensitive substring match)"),
  api_version: z.string().optional().describe("Filter by API version (e.g. '59.0')"),
  order_by: z.enum(["Name", "CreatedDate", "LastModifiedDate"]).optional().default("Name"),
});

const GetApexClassSchema = z.object({
  class_id: z.string().describe("Apex class ID"),
});

const ListApexLogsSchema = z.object({
  limit: z.number().min(1).max(50).optional().default(10),
  offset: z.number().min(0).optional().default(0),
  user_id: z.string().optional().describe("Filter by User ID"),
});

const GetApexLogSchema = z.object({
  log_id: z.string().describe("ApexLog ID"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "execute_anonymous_apex",
      title: "Execute Anonymous Apex",
      description: "Execute anonymous Apex code in the Salesforce org using the Tooling API /executeAnonymous endpoint. Returns compile status, execution status, exception info, and debug log output. Use for quick data operations or testing logic.",
      inputSchema: {
        type: "object",
        properties: {
          apex_code: { type: "string", description: "Apex code to execute (required)" },
          log_level: { type: "string", enum: ["NONE", "ERROR", "WARN", "INFO", "DEBUG", "FINE", "FINER", "FINEST"], description: "Debug log level (default: DEBUG)" },
        },
        required: ["apex_code"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "list_apex_classes",
      title: "List Apex Classes",
      description: "List Apex classes in the Salesforce org via the Tooling API. Returns class names, API versions, status, and last modified dates. Filter by name or API version.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          name_filter: { type: "string", description: "Filter by class name" },
          api_version: { type: "string", description: "Filter by API version" },
          order_by: { type: "string", enum: ["Name", "CreatedDate", "LastModifiedDate"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_apex_class",
      title: "Get Apex Class",
      description: "Get full details and source code of an Apex class by ID using the Tooling API.",
      inputSchema: {
        type: "object",
        properties: {
          class_id: { type: "string", description: "Apex class ID (required)" },
        },
        required: ["class_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "list_apex_logs",
      title: "List Apex Debug Logs",
      description: "List recent Apex debug logs from the org. Returns log IDs, status, duration, and size. Filter by user.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max logs to return (default 10, max 50)" },
          offset: { type: "number", description: "Pagination offset" },
          user_id: { type: "string", description: "Filter by User ID" },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_apex_log",
      title: "Get Apex Log Content",
      description: "Retrieve the full content of an Apex debug log by ID using the Tooling API.",
      inputSchema: {
        type: "object",
        properties: {
          log_id: { type: "string", description: "ApexLog ID (required)" },
        },
        required: ["log_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    execute_anonymous_apex: async (args) => {
      const params = ExecuteAnonymousSchema.parse(args);
      const encoded = encodeURIComponent(params.apex_code);

      const result = await logger.time("tool.execute_anonymous_apex", () =>
        client.get<{
          compiled: boolean;
          compileProblem: string | null;
          success: boolean;
          line: number;
          column: number;
          exceptionMessage: string | null;
          exceptionStackTrace: string | null;
        }>(`/tooling/executeAnonymous/?anonymousBody=${encoded}`), {}
      );

      const response = {
        compiled: result.compiled,
        compileProblem: result.compileProblem,
        success: result.success,
        line: result.line,
        column: result.column,
        exceptionMessage: result.exceptionMessage,
        exceptionStackTrace: result.exceptionStackTrace,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    list_apex_classes: async (args) => {
      const params = ListApexClassesSchema.parse(args);
      const conditions: string[] = [];
      if (params.name_filter) conditions.push(`Name LIKE '%${params.name_filter.replace(/'/g, "\\'")}%'`);
      if (params.api_version) conditions.push(`ApiVersion = ${params.api_version}`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,Name,ApiVersion,Status,LengthWithoutComments,CreatedDate,LastModifiedDate FROM ApexClass ${where} ORDER BY ${params.order_by} ASC LIMIT ${params.limit} OFFSET ${params.offset}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_apex_classes", () =>
          client.get<{ records: Record<string, unknown>[]; totalSize: number; done: boolean }>(
            `/tooling/query/?q=${encodeURIComponent(soql)}`
          ), {}
        ),
        client.get<{ totalSize: number }>(
          `/tooling/query/?q=${encodeURIComponent(`SELECT COUNT() FROM ApexClass ${where}`)}`
        ),
      ]);

      const response = {
        records: (result.records || []).map((r) => ({
          id: r["Id"],
          name: r["Name"],
          apiVersion: r["ApiVersion"],
          status: r["Status"],
          lengthWithoutComments: r["LengthWithoutComments"],
          createdDate: r["CreatedDate"],
          lastModifiedDate: r["LastModifiedDate"],
        })),
        meta: {
          total: countResult.totalSize,
          returned: (result.records || []).length,
          hasMore: (result.records || []).length === params.limit,
          offset: params.offset,
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_apex_class: async (args) => {
      const { class_id } = GetApexClassSchema.parse(args);
      const result = await logger.time("tool.get_apex_class", () =>
        client.get<Record<string, unknown>>(`/tooling/sobjects/ApexClass/${class_id}`), {}
      );

      const response = {
        id: result["Id"],
        name: result["Name"],
        apiVersion: result["ApiVersion"],
        status: result["Status"],
        body: result["Body"],
        lengthWithoutComments: result["LengthWithoutComments"],
        createdDate: result["CreatedDate"],
        lastModifiedDate: result["LastModifiedDate"],
        createdById: result["CreatedById"],
        lastModifiedById: result["LastModifiedById"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    list_apex_logs: async (args) => {
      const params = ListApexLogsSchema.parse(args);
      const conditions: string[] = [];
      if (params.user_id) conditions.push(`LogUserId = '${params.user_id}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,Application,DurationMilliseconds,Location,LogLength,LogUserId,Operation,Request,StartTime,Status FROM ApexLog ${where} ORDER BY StartTime DESC LIMIT ${params.limit} OFFSET ${params.offset}`;

      const result = await logger.time("tool.list_apex_logs", () =>
        client.get<{ records: Record<string, unknown>[]; totalSize: number }>(
          `/tooling/query/?q=${encodeURIComponent(soql)}`
        ), {}
      );

      const response = {
        records: (result.records || []).map((r) => ({
          id: r["Id"],
          application: r["Application"],
          durationMs: r["DurationMilliseconds"],
          location: r["Location"],
          logLength: r["LogLength"],
          logUserId: r["LogUserId"],
          operation: r["Operation"],
          request: r["Request"],
          startTime: r["StartTime"],
          status: r["Status"],
        })),
        meta: {
          total: result.totalSize,
          returned: (result.records || []).length,
          offset: params.offset,
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_apex_log: async (args) => {
      const { log_id } = GetApexLogSchema.parse(args);
      const content = await logger.time("tool.get_apex_log", () =>
        client.request<string>(`/tooling/sobjects/ApexLog/${log_id}/Body/`, {
          method: "GET",
          headers: { Accept: "text/plain" },
        }), {}
      );

      const response = { log_id, content: typeof content === "string" ? content : JSON.stringify(content) };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
