// Field Permissions tool group — Salesforce FieldPermissions (Profile/PermSet field access)
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListFieldPermissionsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(50),
  offset: z.number().min(0).optional().default(0),
  parent_id: z.string().optional().describe("Filter by Profile ID or PermissionSet ID"),
  sobject_type: z.string().optional().describe("Filter by SObject type (e.g. 'Account')"),
  field: z.string().optional().describe("Filter by field API name (e.g. 'Account.Name')"),
  readable_only: z.boolean().optional().describe("Return only readable fields"),
  editable_only: z.boolean().optional().describe("Return only editable fields"),
});

const GetFieldPermissionsForObjectSchema = z.object({
  parent_id: z.string().describe("Profile ID or PermissionSet ID (required)"),
  sobject_type: z.string().describe("SObject API name (required, e.g. 'Account')"),
});

const UpdateFieldPermissionSchema = z.object({
  permission_id: z.string().describe("FieldPermissions ID to update"),
  permissions_read: z.boolean().optional().describe("Grant/revoke read access"),
  permissions_edit: z.boolean().optional().describe("Grant/revoke edit access"),
});

const CreateFieldPermissionSchema = z.object({
  parent_id: z.string().describe("Profile ID or PermissionSet ID"),
  sobject_type: z.string().describe("SObject API name (e.g. 'Account')"),
  field: z.string().describe("Field API name (e.g. 'Account.Custom_Field__c')"),
  permissions_read: z.boolean().optional().default(false),
  permissions_edit: z.boolean().optional().default(false),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_field_permissions",
      title: "List Field Permissions",
      description: "List Salesforce FieldPermissions for Profiles or PermissionSets. Filter by Profile/PermSet ID, SObject type, or field name. Returns read/edit access for each field.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 50, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          parent_id: { type: "string", description: "Profile ID or PermissionSet ID" },
          sobject_type: { type: "string", description: "SObject type (e.g. 'Account')" },
          field: { type: "string", description: "Field API name (e.g. 'Account.Name')" },
          readable_only: { type: "boolean", description: "Return only readable fields" },
          editable_only: { type: "boolean", description: "Return only editable fields" },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_field_permissions_for_object",
      title: "Get Field Permissions for Object",
      description: "Get all field-level permissions for a specific SObject on a Profile or PermissionSet. Shows which fields are readable and/or editable.",
      inputSchema: {
        type: "object",
        properties: {
          parent_id: { type: "string", description: "Profile ID or PermissionSet ID (required)" },
          sobject_type: { type: "string", description: "SObject API name (required)" },
        },
        required: ["parent_id", "sobject_type"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "update_field_permission",
      title: "Update Field Permission",
      description: "Update read/edit access for a specific FieldPermissions record on a Profile or PermissionSet.",
      inputSchema: {
        type: "object",
        properties: {
          permission_id: { type: "string", description: "FieldPermissions ID (required)" },
          permissions_read: { type: "boolean", description: "Grant/revoke read access" },
          permissions_edit: { type: "boolean", description: "Grant/revoke edit access" },
        },
        required: ["permission_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_field_permission",
      title: "Create Field Permission",
      description: "Create a new FieldPermissions entry to grant read/edit access to a field on a PermissionSet.",
      inputSchema: {
        type: "object",
        properties: {
          parent_id: { type: "string", description: "PermissionSet ID (required; Profiles use metadata API)" },
          sobject_type: { type: "string", description: "SObject API name (required)" },
          field: { type: "string", description: "Field API name (required, e.g. 'Account.Custom_Field__c')" },
          permissions_read: { type: "boolean", description: "Grant read access" },
          permissions_edit: { type: "boolean", description: "Grant edit access" },
        },
        required: ["parent_id", "sobject_type", "field"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_field_permissions: async (args) => {
      const params = ListFieldPermissionsSchema.parse(args);
      const conditions: string[] = [];
      if (params.parent_id) conditions.push(`ParentId = '${params.parent_id}'`);
      if (params.sobject_type) conditions.push(`SobjectType = '${params.sobject_type}'`);
      if (params.field) conditions.push(`Field = '${params.field.replace(/'/g, "\\'")}'`);
      if (params.readable_only) conditions.push(`PermissionsRead = true`);
      if (params.editable_only) conditions.push(`PermissionsEdit = true`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,ParentId,SobjectType,Field,PermissionsRead,PermissionsEdit FROM FieldPermissions ${where} ORDER BY SobjectType ASC, Field ASC LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM FieldPermissions ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_field_permissions", () => client.query<Record<string, unknown>>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r["Id"],
          parentId: r["ParentId"],
          sobjectType: r["SobjectType"],
          field: r["Field"],
          permissionsRead: r["PermissionsRead"],
          permissionsEdit: r["PermissionsEdit"],
        })),
        meta: { total: countResult.totalSize, returned: result.records.length, hasMore: result.records.length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_field_permissions_for_object: async (args) => {
      const params = GetFieldPermissionsForObjectSchema.parse(args);
      const soql = `SELECT Id,Field,PermissionsRead,PermissionsEdit FROM FieldPermissions WHERE ParentId = '${params.parent_id}' AND SobjectType = '${params.sobject_type}' ORDER BY Field ASC`;
      const result = await logger.time("tool.get_field_permissions_for_object", () =>
        client.query<Record<string, unknown>>(soql), {}
      );

      const response = {
        parentId: params.parent_id,
        sobjectType: params.sobject_type,
        fieldPermissions: result.records.map((r) => ({
          id: r["Id"],
          field: r["Field"],
          permissionsRead: r["PermissionsRead"],
          permissionsEdit: r["PermissionsEdit"],
        })),
        meta: { total: result.totalSize },
        summary: {
          readableFields: result.records.filter((r) => r["PermissionsRead"]).length,
          editableFields: result.records.filter((r) => r["PermissionsEdit"]).length,
          totalFields: result.totalSize,
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    update_field_permission: async (args) => {
      const { permission_id, ...updates } = UpdateFieldPermissionSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.permissions_read !== undefined) payload["PermissionsRead"] = updates.permissions_read;
      if (updates.permissions_edit !== undefined) payload["PermissionsEdit"] = updates.permissions_edit;

      await logger.time("tool.update_field_permission", () =>
        client.patch(`/sobjects/FieldPermissions/${permission_id}`, payload), {}
      );

      const response = { success: true, permission_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_field_permission: async (args) => {
      const params = CreateFieldPermissionSchema.parse(args);
      const payload = {
        ParentId: params.parent_id,
        SobjectType: params.sobject_type,
        Field: params.field,
        PermissionsRead: params.permissions_read,
        PermissionsEdit: params.permissions_edit,
      };

      const result = await logger.time("tool.create_field_permission", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/FieldPermissions", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
