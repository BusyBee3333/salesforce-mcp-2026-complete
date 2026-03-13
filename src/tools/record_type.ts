// Record Type tool group — Salesforce RecordType management
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListRecordTypesSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  sobject_type: z.string().optional().describe("Filter by SObject type (e.g. 'Account', 'Opportunity')"),
  name_filter: z.string().optional().describe("Filter by developer name or label"),
  active_only: z.boolean().optional().default(false).describe("Return only active record types"),
  order_by: z.enum(["Name", "SobjectType", "CreatedDate"]).optional().default("SobjectType"),
});

const GetRecordTypeSchema = z.object({
  record_type_id: z.string().describe("RecordType ID"),
  include_picklist_values: z.boolean().optional().default(false).describe("Include picklist values for this record type"),
});

const CreateRecordTypeSchema = z.object({
  name: z.string().describe("Developer name (required, no spaces)"),
  sobject_type: z.string().describe("SObject API name (required, e.g. 'Account')"),
  label: z.string().describe("Display label (required)"),
  description: z.string().optional(),
  is_active: z.boolean().optional().default(true),
  business_process_id: z.string().optional().describe("Business process ID (for Opportunity, Lead, Case stages)"),
});

const UpdateRecordTypeSchema = z.object({
  record_type_id: z.string().describe("RecordType ID to update"),
  label: z.string().optional(),
  description: z.string().optional(),
  is_active: z.boolean().optional(),
  business_process_id: z.string().optional(),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_record_types",
      title: "List Record Types",
      description: "List Salesforce RecordTypes across all or a specific SObject. Returns record type names, labels, SObject types, and active status. Filter by object type or active status.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          sobject_type: { type: "string", description: "Filter by SObject type (e.g. 'Account')" },
          name_filter: { type: "string", description: "Filter by name or label substring" },
          active_only: { type: "boolean", description: "Return only active record types" },
          order_by: { type: "string", enum: ["Name", "SobjectType", "CreatedDate"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_record_type",
      title: "Get Record Type",
      description: "Get full details for a Salesforce RecordType by ID. Optionally includes picklist values specific to this record type.",
      inputSchema: {
        type: "object",
        properties: {
          record_type_id: { type: "string", description: "RecordType ID (required)" },
          include_picklist_values: { type: "boolean", description: "Include picklist values (default false)" },
        },
        required: ["record_type_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_record_type",
      title: "Create Record Type",
      description: "Create a new Salesforce RecordType for a specific SObject. Record types allow different page layouts, picklist values, and business processes per record type.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Developer name (no spaces, required)" },
          sobject_type: { type: "string", description: "SObject API name (required)" },
          label: { type: "string", description: "Display label (required)" },
          description: { type: "string" },
          is_active: { type: "boolean", description: "Active status (default true)" },
          business_process_id: { type: "string", description: "Business process ID" },
        },
        required: ["name", "sobject_type", "label"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_record_type",
      title: "Update Record Type",
      description: "Update a Salesforce RecordType — change label, description, active status, or business process.",
      inputSchema: {
        type: "object",
        properties: {
          record_type_id: { type: "string", description: "RecordType ID (required)" },
          label: { type: "string" },
          description: { type: "string" },
          is_active: { type: "boolean" },
          business_process_id: { type: "string" },
        },
        required: ["record_type_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_record_types: async (args) => {
      const params = ListRecordTypesSchema.parse(args);
      const conditions: string[] = [];
      if (params.sobject_type) conditions.push(`SobjectType = '${params.sobject_type}'`);
      if (params.name_filter) {
        conditions.push(`(Name LIKE '%${params.name_filter.replace(/'/g, "\\'")}%' OR Description LIKE '%${params.name_filter.replace(/'/g, "\\'")}%')`);
      }
      if (params.active_only) conditions.push(`IsActive = true`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,Name,DeveloperName,SobjectType,Description,IsActive,BusinessProcessId,CreatedDate FROM RecordType ${where} ORDER BY ${params.order_by} ASC LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM RecordType ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_record_types", () => client.query<Record<string, unknown>>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r["Id"],
          name: r["Name"],
          developerName: r["DeveloperName"],
          sobjectType: r["SobjectType"],
          description: r["Description"],
          isActive: r["IsActive"],
          businessProcessId: r["BusinessProcessId"],
          createdDate: r["CreatedDate"],
        })),
        meta: { total: countResult.totalSize, returned: result.records.length, hasMore: result.records.length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_record_type: async (args) => {
      const params = GetRecordTypeSchema.parse(args);
      const promises: Promise<unknown>[] = [
        client.get<Record<string, unknown>>(`/sobjects/RecordType/${params.record_type_id}`),
      ];

      if (params.include_picklist_values) {
        promises.push(
          client.get<Record<string, unknown>>(`/sobjects/RecordType/${params.record_type_id}/describe/`).catch(() => ({}))
        );
      }

      const results = await Promise.all(promises);
      const rt = results[0] as Record<string, unknown>;

      const response: Record<string, unknown> = {
        id: rt["Id"],
        name: rt["Name"],
        developerName: rt["DeveloperName"],
        sobjectType: rt["SobjectType"],
        description: rt["Description"],
        isActive: rt["IsActive"],
        businessProcessId: rt["BusinessProcessId"],
        createdDate: rt["CreatedDate"],
        lastModifiedDate: rt["LastModifiedDate"],
      };

      if (params.include_picklist_values) {
        response.describeInfo = results[1];
      }

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_record_type: async (args) => {
      const params = CreateRecordTypeSchema.parse(args);
      const payload: Record<string, unknown> = {
        Name: params.name,
        DeveloperName: params.name,
        SobjectType: params.sobject_type,
        Description: params.description,
        IsActive: params.is_active,
      };
      if (params.business_process_id) payload["BusinessProcessId"] = params.business_process_id;

      const result = await logger.time("tool.create_record_type", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/RecordType", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    update_record_type: async (args) => {
      const { record_type_id, ...updates } = UpdateRecordTypeSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.label !== undefined) payload["Description"] = updates.label;
      if (updates.description !== undefined) payload["Description"] = updates.description;
      if (updates.is_active !== undefined) payload["IsActive"] = updates.is_active;
      if (updates.business_process_id !== undefined) payload["BusinessProcessId"] = updates.business_process_id;

      await logger.time("tool.update_record_type", () =>
        client.patch(`/sobjects/RecordType/${record_type_id}`, payload), {}
      );

      const response = { success: true, record_type_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
