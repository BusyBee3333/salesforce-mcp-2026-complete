// Layout tool group — Salesforce Page Layout descriptions and assignments
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListLayoutsSchema = z.object({
  sobject_type: z.string().describe("SObject API name (required, e.g. 'Account', 'Contact')"),
  record_type_id: z.string().optional().describe("Filter by RecordType ID (get layout for specific record type)"),
});

const DescribeLayoutSchema = z.object({
  sobject_type: z.string().describe("SObject API name (required)"),
  record_type_id: z.string().optional().describe("RecordType ID (optional — returns default layout if omitted)"),
});

const ListLayoutAssignmentsSchema = z.object({
  sobject_type: z.string().describe("SObject API name to get layout assignments for"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_layouts",
      title: "List Page Layouts",
      description: "List available page layouts for a Salesforce SObject type. Returns layout names, IDs, and record type associations. Use to discover which layouts exist for an object.",
      inputSchema: {
        type: "object",
        properties: {
          sobject_type: { type: "string", description: "SObject API name (required, e.g. 'Account')" },
          record_type_id: { type: "string", description: "Filter by RecordType ID" },
        },
        required: ["sobject_type"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "describe_layout",
      title: "Describe Page Layout",
      description: "Get the detailed layout description for a Salesforce SObject page layout. Returns sections, fields, and their positions. Optionally specify a RecordType ID to get that record type's layout.",
      inputSchema: {
        type: "object",
        properties: {
          sobject_type: { type: "string", description: "SObject API name (required)" },
          record_type_id: { type: "string", description: "RecordType ID (optional)" },
        },
        required: ["sobject_type"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "list_layout_assignments",
      title: "List Layout Assignments",
      description: "Get the profile-to-layout and record-type-to-layout assignments for a Salesforce SObject. Shows which layout is used for each Profile/RecordType combination.",
      inputSchema: {
        type: "object",
        properties: {
          sobject_type: { type: "string", description: "SObject API name (required)" },
        },
        required: ["sobject_type"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_layouts: async (args) => {
      const params = ListLayoutsSchema.parse(args);

      const result = await logger.time("tool.list_layouts", () =>
        client.get<{
          recordTypeMappings: Record<string, unknown>[];
          layouts: Record<string, unknown>[];
        }>(`/sobjects/${params.sobject_type}/describe/layouts/`), {}
      );

      let layouts = result.layouts || [];
      let recordTypeMappings = result.recordTypeMappings || [];

      if (params.record_type_id) {
        const mapping = recordTypeMappings.find((m) => m["recordTypeId"] === params.record_type_id);
        const layoutId = mapping ? (mapping["layoutId"] as string) : undefined;
        if (layoutId) {
          layouts = layouts.filter((l) => l["id"] === layoutId);
        }
      }

      const response = {
        sobjectType: params.sobject_type,
        layouts: layouts.map((l) => ({
          id: l["id"],
          name: l["name"],
        })),
        recordTypeMappings: recordTypeMappings.map((m) => ({
          recordTypeId: m["recordTypeId"],
          recordTypeName: m["name"],
          layoutId: m["layoutId"],
          available: m["available"],
          defaultRecordTypeMapping: m["defaultRecordTypeMapping"],
        })),
        meta: { layoutCount: layouts.length, recordTypeMappingCount: recordTypeMappings.length },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    describe_layout: async (args) => {
      const params = DescribeLayoutSchema.parse(args);
      const endpoint = params.record_type_id
        ? `/sobjects/${params.sobject_type}/describe/layouts/${params.record_type_id}`
        : `/sobjects/${params.sobject_type}/describe/layouts/`;

      const result = await logger.time("tool.describe_layout", () =>
        client.get<Record<string, unknown>>(endpoint), {}
      );

      // If no record_type_id, we get the full structure — return the first layout
      const layoutData = params.record_type_id ? result : ((result["layouts"] as Record<string, unknown>[] | undefined)?.[0] || result);

      const editLayoutSections = layoutData["editLayoutSections"] as Record<string, unknown>[] | undefined;
      const detailLayoutSections = layoutData["detailLayoutSections"] as Record<string, unknown>[] | undefined;

      const mapSection = (section: Record<string, unknown>) => ({
        heading: section["heading"],
        columns: section["columns"],
        rows: section["rows"],
        layoutRows: (section["layoutRows"] as Record<string, unknown>[] | undefined)?.map((row) => ({
          layoutItems: (row["layoutItems"] as Record<string, unknown>[] | undefined)?.map((item) => ({
            label: item["label"],
            required: item["required"],
            editable: item["editable"],
            field: (item["layoutComponents"] as Record<string, unknown>[] | undefined)?.[0]?.["value"],
            componentType: (item["layoutComponents"] as Record<string, unknown>[] | undefined)?.[0]?.["type"],
          })),
        })),
      });

      const response = {
        sobjectType: params.sobject_type,
        recordTypeId: params.record_type_id,
        layoutId: layoutData["id"],
        layoutName: layoutData["name"],
        editLayoutSections: (editLayoutSections || []).map(mapSection),
        detailLayoutSections: (detailLayoutSections || []).map(mapSection),
        relatedLists: (layoutData["relatedLists"] as Record<string, unknown>[] | undefined)?.map((rl) => ({
          name: rl["name"],
          label: rl["label"],
          sobject: rl["sobject"],
        })),
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    list_layout_assignments: async (args) => {
      const { sobject_type } = ListLayoutAssignmentsSchema.parse(args);
      const soql = `SELECT Id,LayoutId,Layout.Name,ProfileId,Profile.Name,RecordTypeId,RecordType.Name FROM ProfileLayout WHERE SobjectType = '${sobject_type}' ORDER BY Profile.Name ASC LIMIT 200`;

      const result = await logger.time("tool.list_layout_assignments", () =>
        client.query<Record<string, unknown>>(soql), {}
      );

      const response = {
        sobjectType: sobject_type,
        assignments: result.records.map((r) => {
          const layout = r["Layout"] as Record<string, unknown> | undefined;
          const profile = r["Profile"] as Record<string, unknown> | undefined;
          const recordType = r["RecordType"] as Record<string, unknown> | undefined;
          return {
            id: r["Id"],
            layoutId: r["LayoutId"],
            layoutName: layout?.["Name"],
            profileId: r["ProfileId"],
            profileName: profile?.["Name"],
            recordTypeId: r["RecordTypeId"],
            recordTypeName: recordType?.["Name"],
          };
        }),
        meta: { total: result.totalSize },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
