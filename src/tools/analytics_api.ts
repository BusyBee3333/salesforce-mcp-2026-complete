// Analytics API tool group — Salesforce Analytics REST API (Wave/Einstein Analytics)
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListDatasetsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  name_filter: z.string().optional().describe("Filter by dataset name"),
  dataset_type: z.string().optional().describe("Filter by dataset type (e.g. 'Default', 'Live')"),
  order_by: z.enum(["name", "createdDate", "lastModifiedDate"]).optional().default("name"),
  order_dir: z.enum(["asc", "desc"]).optional().default("asc"),
});

const GetDatasetSchema = z.object({
  dataset_id_or_name: z.string().describe("Dataset ID or API name"),
  include_xmd: z.boolean().optional().default(false).describe("Include extended metadata (field descriptions)"),
});

const RunSoqlQuerySchema = z.object({
  query: z.string().describe("SAQL or SQL query string against Analytics datasets"),
  query_language: z.enum(["Saql", "Sql"]).optional().default("Saql"),
  timezone: z.string().optional().describe("Timezone for date calculations (e.g. 'America/New_York')"),
});

const ListLensesSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  name_filter: z.string().optional().describe("Filter by lens name"),
});

const ListDashboardsWaveSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  name_filter: z.string().optional().describe("Filter by dashboard name"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_analytics_datasets",
      title: "List Analytics Datasets",
      description: "List Salesforce Analytics (Einstein Analytics / CRM Analytics) datasets. Returns dataset names, API names, types, record counts, and last modified dates.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          name_filter: { type: "string", description: "Filter by dataset name" },
          dataset_type: { type: "string", description: "Filter by type (e.g. 'Default')" },
          order_by: { type: "string", enum: ["name", "createdDate", "lastModifiedDate"] },
          order_dir: { type: "string", enum: ["asc", "desc"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_analytics_dataset",
      title: "Get Analytics Dataset",
      description: "Get full details for a Salesforce Analytics dataset by ID or name, including field definitions and record count.",
      inputSchema: {
        type: "object",
        properties: {
          dataset_id_or_name: { type: "string", description: "Dataset ID or API name (required)" },
          include_xmd: { type: "boolean", description: "Include extended metadata" },
        },
        required: ["dataset_id_or_name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "run_analytics_query",
      title: "Run Analytics Query",
      description: "Execute a SAQL or SQL query against Salesforce CRM Analytics datasets via the Analytics API. Returns query results with records and metadata.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "SAQL or SQL query string (required)" },
          query_language: { type: "string", enum: ["Saql", "Sql"], description: "Query language (default: Saql)" },
          timezone: { type: "string", description: "Timezone for date calculations" },
        },
        required: ["query"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "list_analytics_lenses",
      title: "List Analytics Lenses",
      description: "List Salesforce Analytics (Einstein Analytics) lenses (explorations). Returns lens names, descriptions, and related datasets.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          name_filter: { type: "string", description: "Filter by lens name" },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "list_analytics_dashboards",
      title: "List Analytics Dashboards",
      description: "List Salesforce Analytics (Einstein Analytics / CRM Analytics) dashboards — different from standard Salesforce Reports & Dashboards. Returns dashboard names, descriptions, and creation dates.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          name_filter: { type: "string", description: "Filter by dashboard name" },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_analytics_datasets: async (args) => {
      const params = ListDatasetsSchema.parse(args);
      let endpoint = `/wave/datasets?pageSize=${params.limit}&offset=${params.offset}&sort=${params.order_by}`;
      if (params.name_filter) endpoint += `&q=${encodeURIComponent(params.name_filter)}`;
      if (params.dataset_type) endpoint += `&datasetTypes=${encodeURIComponent(params.dataset_type)}`;
      if (params.order_dir === "desc") endpoint += `&sortDesc=true`;

      const result = await logger.time("tool.list_analytics_datasets", () =>
        client.get<{ datasets: Record<string, unknown>[]; totalSize: number; url: string }>(endpoint), {}
      );

      const response = {
        records: (result.datasets || []).map((d) => ({
          id: d["id"],
          name: d["name"],
          label: d["label"],
          type: d["datasetType"],
          rowCount: d["rowCount"],
          createdDate: d["createdDate"],
          lastModifiedDate: d["lastModifiedDate"],
          currentVersionId: (d["currentVersionId"] as string) || undefined,
        })),
        meta: { total: result.totalSize, returned: (result.datasets || []).length, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_analytics_dataset: async (args) => {
      const params = GetDatasetSchema.parse(args);
      const result = await logger.time("tool.get_analytics_dataset", () =>
        client.get<Record<string, unknown>>(`/wave/datasets/${encodeURIComponent(params.dataset_id_or_name)}`), {}
      );

      const response: Record<string, unknown> = {
        id: result["id"],
        name: result["name"],
        label: result["label"],
        description: result["description"],
        type: result["datasetType"],
        rowCount: result["rowCount"],
        currentVersionId: result["currentVersionId"],
        createdDate: result["createdDate"],
        lastModifiedDate: result["lastModifiedDate"],
        createdBy: (result["createdBy"] as Record<string, unknown> | undefined)?.["name"],
      };

      if (params.include_xmd) {
        response.xmd = result["xmd"];
      }

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    run_analytics_query: async (args) => {
      const params = RunSoqlQuerySchema.parse(args);
      const body: Record<string, unknown> = {
        query: params.query,
        queryLanguage: params.query_language,
      };
      if (params.timezone) body["timezone"] = params.timezone;

      const result = await logger.time("tool.run_analytics_query", () =>
        client.post<Record<string, unknown>>("/wave/query", body), {}
      );

      const response = {
        queryId: result["id"],
        query: params.query,
        results: result["results"],
        metadata: result["metadata"],
        query_language: params.query_language,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    list_analytics_lenses: async (args) => {
      const params = ListLensesSchema.parse(args);
      let endpoint = `/wave/lenses?pageSize=${params.limit}&offset=${params.offset}`;
      if (params.name_filter) endpoint += `&q=${encodeURIComponent(params.name_filter)}`;

      const result = await logger.time("tool.list_analytics_lenses", () =>
        client.get<{ lenses: Record<string, unknown>[]; totalSize: number }>(endpoint), {}
      );

      const response = {
        records: (result.lenses || []).map((l) => ({
          id: l["id"],
          name: l["name"],
          label: l["label"],
          description: l["description"],
          createdDate: l["createdDate"],
          lastModifiedDate: l["lastModifiedDate"],
        })),
        meta: { total: result.totalSize, returned: (result.lenses || []).length, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    list_analytics_dashboards: async (args) => {
      const params = ListDashboardsWaveSchema.parse(args);
      let endpoint = `/wave/dashboards?pageSize=${params.limit}&offset=${params.offset}`;
      if (params.name_filter) endpoint += `&q=${encodeURIComponent(params.name_filter)}`;

      const result = await logger.time("tool.list_analytics_dashboards", () =>
        client.get<{ dashboards: Record<string, unknown>[]; totalSize: number }>(endpoint), {}
      );

      const response = {
        records: (result.dashboards || []).map((d) => ({
          id: d["id"],
          name: d["name"],
          label: d["label"],
          description: d["description"],
          createdDate: d["createdDate"],
          lastModifiedDate: d["lastModifiedDate"],
        })),
        meta: { total: result.totalSize, returned: (result.dashboards || []).length, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
