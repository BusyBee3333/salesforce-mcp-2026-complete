// Flows tool group — Salesforce Flow invocation via /actions/custom/flow/ endpoint
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListFlowsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  api_name_search: z.string().optional().describe("Search flows by API name (LIKE match)"),
  is_active: z.boolean().optional().describe("Filter by active flows only"),
  flow_type: z.string().optional().describe("Filter by ProcessType (e.g. 'Flow', 'AutoLaunchedFlow', 'Workflow')"),
  order_by: z.enum(["LastModifiedDate", "CreatedDate", "ApiName", "Label"]).optional().default("LastModifiedDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

const GetFlowSchema = z.object({
  flow_id: z.string().describe("Salesforce Flow definition ID"),
});

const InvokeFlowSchema = z.object({
  flow_api_name: z.string().describe("The API name of the Flow to invoke (required)"),
  inputs: z.record(z.unknown()).optional().describe("Input variable values for the flow as key-value pairs"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_flows",
      title: "List Flows",
      description: "List Salesforce Flow definitions. Returns flow name, API name, type, status, and last modified date. Use to discover available flows before invoking them.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          api_name_search: { type: "string", description: "Search by API name (LIKE filter)" },
          is_active: { type: "boolean", description: "Filter by active status" },
          flow_type: { type: "string", description: "Filter by ProcessType (e.g. 'AutoLaunchedFlow')" },
          order_by: { type: "string", enum: ["LastModifiedDate", "CreatedDate", "ApiName", "Label"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_flow",
      title: "Get Flow",
      description: "Get full details for a Salesforce Flow definition by its record ID including version, type, status, and variable definitions.",
      inputSchema: {
        type: "object",
        properties: { flow_id: { type: "string", description: "Flow definition ID" } },
        required: ["flow_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "invoke_flow",
      title: "Invoke Flow",
      description: "Invoke (run) a Salesforce autolaunched Flow via the REST Actions API (/actions/custom/flow/<ApiName>). Pass input variables as key-value pairs. The flow must be an autolaunched Flow type.",
      inputSchema: {
        type: "object",
        properties: {
          flow_api_name: { type: "string", description: "Flow API name to invoke (required)" },
          inputs: { type: "object", description: "Input variable values for the flow (key-value pairs)" },
        },
        required: ["flow_api_name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_flows: async (args) => {
      const params = ListFlowsSchema.parse(args);
      const conditions: string[] = [];
      if (params.api_name_search) conditions.push(`ApiName LIKE '%${params.api_name_search.replace(/'/g, "\\'")}%'`);
      if (params.is_active !== undefined) conditions.push(`Status = '${params.is_active ? "Active" : "Inactive"}'`);
      if (params.flow_type) conditions.push(`ProcessType = '${params.flow_type.replace(/'/g, "\\'")}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id, ApiName, Label, ProcessType, Status, Description, LastModifiedDate, CreatedDate FROM FlowDefinition ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM FlowDefinition ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_flows", () => client.query(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: (result.records as Record<string, unknown>[]).map((r) => ({
          id: r["Id"],
          apiName: r["ApiName"],
          label: r["Label"],
          processType: r["ProcessType"],
          status: r["Status"],
          description: r["Description"],
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

    get_flow: async (args) => {
      const { flow_id } = GetFlowSchema.parse(args);
      const result = await logger.time("tool.get_flow", () =>
        client.get<Record<string, unknown>>(`/sobjects/FlowDefinition/${flow_id}`), {}
      );

      const response = {
        id: result["Id"],
        apiName: result["ApiName"],
        label: result["Label"],
        processType: result["ProcessType"],
        status: result["Status"],
        description: result["Description"],
        lastModifiedDate: result["LastModifiedDate"],
        createdDate: result["CreatedDate"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    invoke_flow: async (args) => {
      const params = InvokeFlowSchema.parse(args);

      // Build the inputs array in Salesforce actions format
      const inputRecord: Record<string, unknown> = {};
      if (params.inputs) {
        Object.assign(inputRecord, params.inputs);
      }

      const body = { inputs: [inputRecord] };

      const result = await logger.time("tool.invoke_flow", () =>
        client.post<unknown[]>(`/actions/custom/flow/${params.flow_api_name}`, body), {}
      );

      const response = {
        success: true,
        flowApiName: params.flow_api_name,
        outputs: Array.isArray(result) ? result : [result],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
