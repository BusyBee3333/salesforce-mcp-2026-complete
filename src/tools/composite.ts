// Composite tool group — Salesforce Composite API (batch, tree, sobjects)
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const CompositeRequestSchema = z.object({
  subrequests: z.array(z.object({
    method: z.enum(["GET", "POST", "PATCH", "DELETE"]).describe("HTTP method"),
    url: z.string().describe("Salesforce API URL (relative to /services/data/vXX.X/, e.g. '/sobjects/Account/')"),
    reference_id: z.string().describe("Reference ID for this subrequest (used to reference results in later subrequests)"),
    body: z.record(z.unknown()).optional().describe("Request body for POST/PATCH"),
    http_headers: z.record(z.string()).optional().describe("Optional HTTP headers"),
  })).min(1).max(25).describe("Subrequests to execute (max 25)"),
  all_or_none: z.boolean().optional().default(false).describe("Roll back all subrequests on any failure"),
  halt_on_error: z.boolean().optional().default(false).describe("Stop processing on first error"),
});

const BatchRequestSchema = z.object({
  subrequests: z.array(z.object({
    method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
    url: z.string().describe("Relative URL path"),
    rich_input: z.record(z.unknown()).optional().describe("Request body"),
  })).min(1).max(25).describe("Batch subrequests (max 25)"),
  halt_on_error: z.boolean().optional().default(false),
});

const CompositeTreeSchema = z.object({
  sobject: z.string().describe("SObject type for the tree root (e.g. 'Account')"),
  records: z.array(z.record(z.unknown())).min(1).max(200).describe("Records to insert with nested child records in 'records' arrays"),
});

const CompositeGraphSchema = z.object({
  graphs: z.array(z.object({
    graph_id: z.string().describe("Unique graph identifier"),
    composite_request: z.array(z.object({
      method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
      url: z.string(),
      reference_id: z.string(),
      body: z.record(z.unknown()).optional(),
    })),
  })).min(1).max(500).describe("Graphs to process (each graph is independent)"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "composite_request",
      title: "Composite Request",
      description: "Execute up to 25 Salesforce REST API subrequests in a single network call using the Composite API. Subrequests can reference results of earlier subrequests via @{referenceId.field} notation. Supports all_or_none and halt_on_error modes.",
      inputSchema: {
        type: "object",
        properties: {
          subrequests: {
            type: "array",
            description: "Up to 25 subrequests to execute sequentially",
            items: {
              type: "object",
              properties: {
                method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"] },
                url: { type: "string", description: "Relative API URL (e.g. '/sobjects/Account/')" },
                reference_id: { type: "string", description: "Unique reference ID for this subrequest" },
                body: { type: "object", description: "Request body" },
                http_headers: { type: "object", description: "Optional headers" },
              },
              required: ["method", "url", "reference_id"],
            },
          },
          all_or_none: { type: "boolean", description: "Roll back all on any failure (default false)" },
          halt_on_error: { type: "boolean", description: "Stop on first error (default false)" },
        },
        required: ["subrequests"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "batch_request",
      title: "Batch Request",
      description: "Execute up to 25 independent Salesforce REST API subrequests as a batch. Unlike composite, batch subrequests cannot reference each other. Each is processed independently.",
      inputSchema: {
        type: "object",
        properties: {
          subrequests: {
            type: "array",
            items: {
              type: "object",
              properties: {
                method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"] },
                url: { type: "string" },
                rich_input: { type: "object" },
              },
              required: ["method", "url"],
            },
          },
          halt_on_error: { type: "boolean" },
        },
        required: ["subrequests"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "composite_tree",
      title: "Composite Tree Insert",
      description: "Insert up to 200 SObject records with nested child records in a single API call using the Composite Tree API. Ideal for creating Accounts with Contacts, or Cases with Tasks, in one request.",
      inputSchema: {
        type: "object",
        properties: {
          sobject: { type: "string", description: "Root SObject type (e.g. 'Account')" },
          records: {
            type: "array",
            description: "Records to insert (can include nested child 'records' arrays)",
            items: { type: "object" },
          },
        },
        required: ["sobject", "records"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "composite_graph",
      title: "Composite Graph",
      description: "Execute multiple independent composite graphs in a single API call. Each graph can contain up to 500 subrequests. Graphs are independent — failures in one don't affect others.",
      inputSchema: {
        type: "object",
        properties: {
          graphs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                graph_id: { type: "string" },
                composite_request: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      method: { type: "string" },
                      url: { type: "string" },
                      reference_id: { type: "string" },
                      body: { type: "object" },
                    },
                    required: ["method", "url", "reference_id"],
                  },
                },
              },
              required: ["graph_id", "composite_request"],
            },
          },
        },
        required: ["graphs"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    composite_request: async (args) => {
      const params = CompositeRequestSchema.parse(args);
      const body = {
        allOrNone: params.all_or_none,
        haltOnError: params.halt_on_error,
        compositeRequest: params.subrequests.map((s) => ({
          method: s.method,
          url: s.url.startsWith("/services") ? s.url : `/services/data/v59.0${s.url.startsWith("/") ? "" : "/"}${s.url}`,
          referenceId: s.reference_id,
          body: s.body,
          httpHeaders: s.http_headers,
        })),
      };

      const result = await logger.time("tool.composite_request", () =>
        client.post<{ compositeResponse: Record<string, unknown>[] }>("/composite/", body), {}
      );

      const response = {
        results: (result.compositeResponse || []).map((r) => ({
          referenceId: r["referenceId"],
          httpStatusCode: r["httpStatusCode"],
          body: r["body"],
        })),
        allOrNone: params.all_or_none,
        errors: (result.compositeResponse || []).filter((r) => {
          const status = Number(r["httpStatusCode"] || 0);
          return status >= 400;
        }).length,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    batch_request: async (args) => {
      const params = BatchRequestSchema.parse(args);
      const body = {
        haltOnError: params.halt_on_error,
        batchRequests: params.subrequests.map((s) => ({
          method: s.method,
          url: s.url.startsWith("/services") ? s.url : `/services/data/v59.0${s.url.startsWith("/") ? "" : "/"}${s.url}`,
          richInput: s.rich_input,
        })),
      };

      const result = await logger.time("tool.batch_request", () =>
        client.post<{ hasErrors: boolean; results: Record<string, unknown>[] }>("/composite/batch/", body), {}
      );

      const response = {
        hasErrors: result.hasErrors,
        results: (result.results || []).map((r) => ({
          statusCode: r["statusCode"],
          result: r["result"],
        })),
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    composite_tree: async (args) => {
      const params = CompositeTreeSchema.parse(args);
      const result = await logger.time("tool.composite_tree", () =>
        client.post<{ hasErrors: boolean; results: Record<string, unknown>[] }>(
          `/composite/tree/${params.sobject}/`,
          { records: params.records }
        ), {}
      );

      const response = {
        hasErrors: result.hasErrors,
        results: result.results || [],
        created: (result.results || []).filter((r) => r["success"]).length,
        failed: (result.results || []).filter((r) => !r["success"]).length,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    composite_graph: async (args) => {
      const params = CompositeGraphSchema.parse(args);
      const body = {
        graphs: params.graphs.map((g) => ({
          graphId: g.graph_id,
          compositeRequest: g.composite_request.map((r) => ({
            method: r.method,
            url: r.url.startsWith("/services") ? r.url : `/services/data/v59.0${r.url.startsWith("/") ? "" : "/"}${r.url}`,
            referenceId: r.reference_id,
            body: r.body,
          })),
        })),
      };

      const result = await logger.time("tool.composite_graph", () =>
        client.post<{ graphs: Record<string, unknown>[] }>("/composite/graph/", body), {}
      );

      const response = {
        graphs: (result.graphs || []).map((g) => ({
          graphId: g["graphId"],
          isSuccessful: g["isSuccessful"],
          graphResponse: g["graphResponse"],
        })),
        total: (result.graphs || []).length,
        successful: (result.graphs || []).filter((g) => g["isSuccessful"]).length,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
