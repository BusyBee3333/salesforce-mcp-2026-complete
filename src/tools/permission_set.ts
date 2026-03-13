// Permission Set tool group — Salesforce PermissionSet, PermissionSetAssignment
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListPermissionSetsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  name_filter: z.string().optional().describe("Filter by Name (case-insensitive substring)"),
  custom_only: z.boolean().optional().default(false).describe("Return only custom permission sets"),
  order_by: z.enum(["Name", "Label", "CreatedDate"]).optional().default("Name"),
});

const GetPermissionSetSchema = z.object({
  permission_set_id: z.string().describe("PermissionSet ID or API Name"),
});

const AssignPermissionSetSchema = z.object({
  permission_set_id: z.string().describe("PermissionSet ID to assign"),
  user_id: z.string().describe("User ID to assign the permission set to"),
  expiration_date: z.string().optional().describe("Optional expiration date (ISO 8601, e.g. '2025-12-31')"),
});

const RemovePermissionSetSchema = z.object({
  assignment_id: z.string().describe("PermissionSetAssignment ID to remove"),
});

const ListUserPermissionsSchema = z.object({
  user_id: z.string().describe("User ID to retrieve permission set assignments for"),
  limit: z.number().min(1).max(200).optional().default(50),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_permission_sets",
      title: "List Permission Sets",
      description: "List Salesforce PermissionSets in the org. Returns name, label, description, license type, and whether the set is custom. Filter by name or custom status.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          name_filter: { type: "string", description: "Filter by name substring" },
          custom_only: { type: "boolean", description: "Return only custom permission sets" },
          order_by: { type: "string", enum: ["Name", "Label", "CreatedDate"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_permission_set",
      title: "Get Permission Set",
      description: "Get full details for a Salesforce PermissionSet by ID, including description, license type, and object/field permissions summary.",
      inputSchema: {
        type: "object",
        properties: {
          permission_set_id: { type: "string", description: "PermissionSet ID (required)" },
        },
        required: ["permission_set_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "assign_permission_set",
      title: "Assign Permission Set to User",
      description: "Assign a Salesforce PermissionSet to a user by creating a PermissionSetAssignment. Optionally specify an expiration date.",
      inputSchema: {
        type: "object",
        properties: {
          permission_set_id: { type: "string", description: "PermissionSet ID (required)" },
          user_id: { type: "string", description: "User ID to assign to (required)" },
          expiration_date: { type: "string", description: "Optional expiration date (ISO 8601)" },
        },
        required: ["permission_set_id", "user_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "remove_permission_set_assignment",
      title: "Remove Permission Set Assignment",
      description: "Remove a PermissionSet assignment from a user by deleting the PermissionSetAssignment record.",
      inputSchema: {
        type: "object",
        properties: {
          assignment_id: { type: "string", description: "PermissionSetAssignment ID (required)" },
        },
        required: ["assignment_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "list_user_permission_sets",
      title: "List User Permission Sets",
      description: "List all PermissionSet assignments for a specific Salesforce user. Returns assignment IDs, permission set names, and expiration dates.",
      inputSchema: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "User ID (required)" },
          limit: { type: "number", description: "Max records (default 50, max 200)" },
        },
        required: ["user_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_permission_sets: async (args) => {
      const params = ListPermissionSetsSchema.parse(args);
      const conditions: string[] = [];
      if (params.name_filter) conditions.push(`Name LIKE '%${params.name_filter.replace(/'/g, "\\'")}%'`);
      if (params.custom_only) conditions.push(`IsCustom = true`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,Name,Label,Description,IsCustom,LicenseId,PermissionSetGroupId,CreatedDate FROM PermissionSet ${where} ORDER BY ${params.order_by} ASC LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM PermissionSet ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_permission_sets", () => client.query<Record<string, unknown>>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r["Id"],
          name: r["Name"],
          label: r["Label"],
          description: r["Description"],
          isCustom: r["IsCustom"],
          licenseId: r["LicenseId"],
          permissionSetGroupId: r["PermissionSetGroupId"],
          createdDate: r["CreatedDate"],
        })),
        meta: { total: countResult.totalSize, returned: result.records.length, hasMore: result.records.length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_permission_set: async (args) => {
      const { permission_set_id } = GetPermissionSetSchema.parse(args);
      const result = await logger.time("tool.get_permission_set", () =>
        client.get<Record<string, unknown>>(`/sobjects/PermissionSet/${permission_set_id}`), {}
      );

      const response = {
        id: result["Id"],
        name: result["Name"],
        label: result["Label"],
        description: result["Description"],
        isCustom: result["IsCustom"],
        licenseId: result["LicenseId"],
        hasActivationRequired: result["HasActivationRequired"],
        permissionSetGroupId: result["PermissionSetGroupId"],
        createdDate: result["CreatedDate"],
        lastModifiedDate: result["LastModifiedDate"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    assign_permission_set: async (args) => {
      const params = AssignPermissionSetSchema.parse(args);
      const payload: Record<string, unknown> = {
        PermissionSetId: params.permission_set_id,
        AssigneeId: params.user_id,
      };
      if (params.expiration_date) payload["ExpirationDate"] = params.expiration_date;

      const result = await logger.time("tool.assign_permission_set", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/PermissionSetAssignment", payload), {}
      );

      const response = {
        success: result.success,
        assignmentId: result.id,
        permissionSetId: params.permission_set_id,
        userId: params.user_id,
        expirationDate: params.expiration_date,
        errors: result.errors,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    remove_permission_set_assignment: async (args) => {
      const { assignment_id } = RemovePermissionSetSchema.parse(args);
      await logger.time("tool.remove_permission_set_assignment", () =>
        client.delete(`/sobjects/PermissionSetAssignment/${assignment_id}`), {}
      );
      const response = { success: true, assignment_id, deleted: true };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    list_user_permission_sets: async (args) => {
      const params = ListUserPermissionsSchema.parse(args);
      const soql = `SELECT Id,PermissionSetId,PermissionSet.Name,PermissionSet.Label,ExpirationDate,AssigneeId FROM PermissionSetAssignment WHERE AssigneeId = '${params.user_id}' LIMIT ${params.limit}`;
      const result = await logger.time("tool.list_user_permission_sets", () =>
        client.query<Record<string, unknown>>(soql), {}
      );

      const response = {
        userId: params.user_id,
        assignments: result.records.map((r) => {
          const ps = r["PermissionSet"] as Record<string, unknown> | undefined;
          return {
            assignmentId: r["Id"],
            permissionSetId: r["PermissionSetId"],
            name: ps?.["Name"],
            label: ps?.["Label"],
            expirationDate: r["ExpirationDate"],
          };
        }),
        meta: { total: result.totalSize, returned: result.records.length },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
