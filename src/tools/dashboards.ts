// Dashboards tool group — Salesforce Analytics REST API
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListDashboardsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  folder_id: z.string().optional().describe("Filter by dashboard folder ID"),
  search: z.string().optional().describe("Search dashboards by name"),
});

const GetDashboardSchema = z.object({
  dashboard_id: z.string().describe("Salesforce Dashboard ID"),
  include_metadata: z.boolean().optional().default(false).describe("Include dashboard component metadata"),
});

const RefreshDashboardSchema = z.object({
  dashboard_id: z.string().describe("Salesforce Dashboard ID to refresh"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_dashboards",
      title: "List Dashboards",
      description: "List Salesforce dashboards using the Analytics REST API. Returns dashboard names, IDs, last refresh dates, and folder info. Supports pagination and search.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          folder_id: { type: "string", description: "Filter by folder ID" },
          search: { type: "string", description: "Search by dashboard name" },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_dashboard",
      title: "Get Dashboard",
      description: "Get full details for a Salesforce dashboard by ID using the Analytics REST API. Returns status, last refresh, running user, and optionally component metadata.",
      inputSchema: {
        type: "object",
        properties: {
          dashboard_id: { type: "string", description: "Salesforce Dashboard ID" },
          include_metadata: { type: "boolean", description: "Include component metadata (default false)" },
        },
        required: ["dashboard_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "refresh_dashboard",
      title: "Refresh Dashboard",
      description: "Trigger a refresh of a Salesforce dashboard using the Analytics REST API. This queues the dashboard for a data refresh.",
      inputSchema: {
        type: "object",
        properties: { dashboard_id: { type: "string", description: "Dashboard ID to refresh" } },
        required: ["dashboard_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_dashboards: async (args) => {
      const params = ListDashboardsSchema.parse(args);

      // Build SOQL to fetch dashboards via sobjects (Analytics API requires instance-level calls)
      const conditions: string[] = [];
      if (params.folder_id) conditions.push(`FolderId = '${params.folder_id}'`);
      if (params.search) conditions.push(`Name LIKE '%${params.search.replace(/'/g, "\\'")}%'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id, Title, DeveloperName, FolderId, FolderName, LastRunDate, RunningUserId, Type, LastModifiedDate, CreatedDate FROM Dashboard ${where} ORDER BY LastModifiedDate DESC LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Dashboard ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_dashboards", () => client.query(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: (result.records as Record<string, unknown>[]).map((r) => ({
          id: r["Id"],
          title: r["Title"],
          developerName: r["DeveloperName"],
          folderId: r["FolderId"],
          folderName: r["FolderName"],
          lastRunDate: r["LastRunDate"],
          runningUserId: r["RunningUserId"],
          type: r["Type"],
          lastModifiedDate: r["LastModifiedDate"],
          createdDate: r["CreatedDate"],
        })),
        meta: {
          total: countResult.totalSize,
          returned: result.records.length,
          hasMore: !result.done || result.records.length === params.limit,
          offset: params.offset,
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_dashboard: async (args) => {
      const params = GetDashboardSchema.parse(args);

      // Use Analytics REST API endpoint
      const endpoint = `/analytics/dashboards/${params.dashboard_id}${params.include_metadata ? "?includeDetails=true" : ""}`;
      const result = await logger.time("tool.get_dashboard", () =>
        client.get<Record<string, unknown>>(endpoint), {}
      );

      const response: Record<string, unknown> = {
        id: result["id"] ?? result["Id"],
        name: result["name"] ?? result["Name"],
        title: result["reportMetadata"] ? (result["reportMetadata"] as Record<string, unknown>)["name"] : undefined,
        description: result["description"],
        dashboardMetadata: params.include_metadata ? result["dashboardMetadata"] : undefined,
        lastRefreshed: result["lastRefreshed"],
        status: result["status"],
        reportMetadata: params.include_metadata ? result["reportMetadata"] : undefined,
        runningUser: result["runningUser"],
        rawData: params.include_metadata ? undefined : result,
      };

      // Clean undefined
      Object.keys(response).forEach((k) => response[k] === undefined && delete response[k]);

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    refresh_dashboard: async (args) => {
      const { dashboard_id } = RefreshDashboardSchema.parse(args);

      // PUT to /analytics/dashboards/<id> triggers a refresh
      const result = await logger.time("tool.refresh_dashboard", () =>
        client.request<Record<string, unknown>>(`/analytics/dashboards/${dashboard_id}`, { method: "PUT", body: JSON.stringify({}) }), {}
      );

      const response = {
        success: true,
        dashboard_id,
        refreshStatus: result["status"] ?? result["refreshStatus"] ?? "queued",
        details: result,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
