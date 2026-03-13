// Reports tool group — Salesforce Reports API (list, run, metadata)
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListReportsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  report_type: z.string().optional().describe("Filter by report type (e.g. 'tabular', 'summary', 'matrix')"),
  folder_id: z.string().optional().describe("Filter by FolderId to scope to a specific report folder"),
  order_by: z.enum(["LastModifiedDate", "CreatedDate", "Name"]).optional().default("LastModifiedDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

const RunReportSchema = z.object({
  report_id: z.string().describe("Salesforce Report ID (15 or 18 character)"),
  include_details: z.boolean().optional().default(true).describe("Include detail rows in results (default true)"),
  filter_overrides: z.array(z.object({
    column: z.string().describe("API name of the field to filter on"),
    operator: z.string().describe("Filter operator (e.g. 'equals', 'greaterThan')"),
    value: z.string().describe("Filter value"),
  })).optional().describe("Override report filters at runtime"),
});

const GetReportMetadataSchema = z.object({
  report_id: z.string().describe("Salesforce Report ID"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_reports",
      title: "List Reports",
      description: "List Salesforce reports available to the current user. Supports filtering by report type and folder, with pagination.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          report_type: { type: "string", description: "Filter by report type (tabular/summary/matrix)" },
          folder_id: { type: "string", description: "Filter by report folder ID" },
          order_by: { type: "string", enum: ["LastModifiedDate", "CreatedDate", "Name"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "run_report",
      title: "Run Report",
      description: "Execute a Salesforce report and return its results. Supports detail rows and optional filter overrides for ad-hoc filtering at runtime.",
      inputSchema: {
        type: "object",
        properties: {
          report_id: { type: "string", description: "Salesforce Report ID" },
          include_details: { type: "boolean", description: "Include detail rows (default true)" },
          filter_overrides: {
            type: "array",
            items: {
              type: "object",
              properties: {
                column: { type: "string" },
                operator: { type: "string" },
                value: { type: "string" },
              },
              required: ["column", "operator", "value"],
            },
            description: "Runtime filter overrides",
          },
        },
        required: ["report_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "get_report_metadata",
      title: "Get Report Metadata",
      description: "Retrieve the metadata for a Salesforce report including columns, filters, groupings, and report type. Useful for understanding report structure before running it.",
      inputSchema: {
        type: "object",
        properties: { report_id: { type: "string", description: "Salesforce Report ID" } },
        required: ["report_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_reports: async (args) => {
      const params = ListReportsSchema.parse(args);
      const conditions: string[] = [];
      if (params.report_type) conditions.push(`ReportType = '${params.report_type.replace(/'/g, "\\'")}'`);
      if (params.folder_id) conditions.push(`FolderId = '${params.folder_id}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,Name,DeveloperName,FolderName,LastModifiedById,LastModifiedDate,CreatedDate,Description FROM Report ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Report ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_reports", () => client.query(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: (result.records as Record<string, unknown>[]).map((r) => ({
          id: r["Id"],
          name: r["Name"],
          developerName: r["DeveloperName"],
          folderName: r["FolderName"],
          lastModifiedDate: r["LastModifiedDate"],
          createdDate: r["CreatedDate"],
          description: r["Description"],
        })),
        meta: {
          total: countResult.totalSize,
          returned: result.records.length,
          hasMore: !result.done || result.records.length === params.limit,
          offset: params.offset,
          limit: params.limit,
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    run_report: async (args) => {
      const params = RunReportSchema.parse(args);

      // Build the request body for the Analytics API
      const body: Record<string, unknown> = {
        reportMetadata: {},
      };

      if (params.filter_overrides && params.filter_overrides.length > 0) {
        body.reportMetadata = {
          reportFilters: params.filter_overrides.map((f) => ({
            column: f.column,
            operator: f.operator,
            value: f.value,
          })),
        };
      }

      const url = `/analytics/reports/${params.report_id}?includeDetails=${params.include_details}`;

      const result = await logger.time("tool.run_report", () =>
        client.post<Record<string, unknown>>(url, body), {}
      );

      // Extract key info from the analytics response
      const factMap = result["factMap"] as Record<string, unknown> | undefined;
      const reportMetadata = result["reportMetadata"] as Record<string, unknown> | undefined;
      const hasDetailRows = params.include_details && factMap;

      const response = {
        reportId: params.report_id,
        reportName: reportMetadata?.["name"],
        reportType: reportMetadata?.["reportType"],
        factMap: hasDetailRows ? factMap : undefined,
        aggregates: (result["groupingsDown"] as Record<string, unknown> | undefined) ?? {},
        metadata: {
          columns: (reportMetadata?.["detailColumns"] as unknown[]) ?? [],
          filters: (reportMetadata?.["reportFilters"] as unknown[]) ?? [],
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_report_metadata: async (args) => {
      const { report_id } = GetReportMetadataSchema.parse(args);

      const result = await logger.time("tool.get_report_metadata", () =>
        client.get<Record<string, unknown>>(`/analytics/reports/${report_id}/describe`), {}
      );

      const reportMetadata = result["reportMetadata"] as Record<string, unknown> | undefined;
      const reportExtendedMetadata = result["reportExtendedMetadata"] as Record<string, unknown> | undefined;

      const response = {
        reportId: report_id,
        name: reportMetadata?.["name"],
        developerName: reportMetadata?.["developerName"],
        reportType: reportMetadata?.["reportType"],
        reportFormat: reportMetadata?.["reportFormat"],
        detailColumns: reportMetadata?.["detailColumns"],
        groupingsDown: reportMetadata?.["groupingsDown"],
        groupingsAcross: reportMetadata?.["groupingsAcross"],
        reportFilters: reportMetadata?.["reportFilters"],
        currency: reportMetadata?.["currency"],
        columnMetadata: reportExtendedMetadata?.["detailColumnInfo"],
        aggregateColumnMetadata: reportExtendedMetadata?.["aggregateColumnInfo"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
