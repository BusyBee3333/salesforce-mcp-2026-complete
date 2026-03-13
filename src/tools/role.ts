// Role tool group — Salesforce UserRole (role hierarchy)
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListRolesSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  name_filter: z.string().optional().describe("Filter by role name (case-insensitive substring)"),
  parent_role_id: z.string().optional().describe("Filter by parent role ID (direct children only)"),
  order_by: z.enum(["Name", "CreatedDate"]).optional().default("Name"),
});

const GetRoleSchema = z.object({
  role_id: z.string().describe("UserRole ID"),
  include_users: z.boolean().optional().default(false).describe("Include users in this role"),
  include_children: z.boolean().optional().default(false).describe("Include direct child roles"),
});

const CreateRoleSchema = z.object({
  name: z.string().describe("Role name (required)"),
  developer_name: z.string().describe("Role developer name / API name (required, no spaces)"),
  parent_role_id: z.string().optional().describe("Parent UserRole ID (null for top-level role)"),
  forecast_user_id: z.string().optional().describe("User ID for forecast manager"),
  may_forecast_manager_share: z.boolean().optional().default(false),
  rollup_description: z.string().optional(),
});

const UpdateRoleSchema = z.object({
  role_id: z.string().describe("UserRole ID to update"),
  name: z.string().optional(),
  parent_role_id: z.string().optional(),
  rollup_description: z.string().optional(),
});

const DeleteRoleSchema = z.object({
  role_id: z.string().describe("UserRole ID to delete"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_roles",
      title: "List Roles",
      description: "List Salesforce UserRoles (role hierarchy). Returns role names, parent roles, and developer names. Filter by name or parent role.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          name_filter: { type: "string", description: "Filter by name substring" },
          parent_role_id: { type: "string", description: "Filter by parent role ID" },
          order_by: { type: "string", enum: ["Name", "CreatedDate"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_role",
      title: "Get Role",
      description: "Get full details for a Salesforce UserRole by ID. Optionally include users in the role and direct child roles.",
      inputSchema: {
        type: "object",
        properties: {
          role_id: { type: "string", description: "UserRole ID (required)" },
          include_users: { type: "boolean", description: "Include users in this role" },
          include_children: { type: "boolean", description: "Include direct child roles" },
        },
        required: ["role_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_role",
      title: "Create Role",
      description: "Create a new Salesforce UserRole in the role hierarchy.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Role name (required)" },
          developer_name: { type: "string", description: "Developer/API name (required, no spaces)" },
          parent_role_id: { type: "string", description: "Parent role ID (null for top-level)" },
          forecast_user_id: { type: "string", description: "Forecast manager User ID" },
          may_forecast_manager_share: { type: "boolean" },
          rollup_description: { type: "string" },
        },
        required: ["name", "developer_name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_role",
      title: "Update Role",
      description: "Update an existing Salesforce UserRole.",
      inputSchema: {
        type: "object",
        properties: {
          role_id: { type: "string", description: "UserRole ID (required)" },
          name: { type: "string" },
          parent_role_id: { type: "string" },
          rollup_description: { type: "string" },
        },
        required: ["role_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "delete_role",
      title: "Delete Role",
      description: "Delete a Salesforce UserRole. Cannot delete roles that have users assigned or child roles.",
      inputSchema: {
        type: "object",
        properties: {
          role_id: { type: "string", description: "UserRole ID to delete" },
        },
        required: ["role_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_roles: async (args) => {
      const params = ListRolesSchema.parse(args);
      const conditions: string[] = [];
      if (params.name_filter) conditions.push(`Name LIKE '%${params.name_filter.replace(/'/g, "\\'")}%'`);
      if (params.parent_role_id) conditions.push(`ParentRoleId = '${params.parent_role_id}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,Name,DeveloperName,ParentRoleId,RollupDescription,ForecastUserId,CreatedDate FROM UserRole ${where} ORDER BY ${params.order_by} ASC LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM UserRole ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_roles", () => client.query<Record<string, unknown>>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r["Id"],
          name: r["Name"],
          developerName: r["DeveloperName"],
          parentRoleId: r["ParentRoleId"],
          rollupDescription: r["RollupDescription"],
          forecastUserId: r["ForecastUserId"],
          createdDate: r["CreatedDate"],
        })),
        meta: { total: countResult.totalSize, returned: result.records.length, hasMore: result.records.length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_role: async (args) => {
      const params = GetRoleSchema.parse(args);
      const promises: Promise<unknown>[] = [
        client.get<Record<string, unknown>>(`/sobjects/UserRole/${params.role_id}`),
      ];
      if (params.include_users) {
        promises.push(client.query<Record<string, unknown>>(`SELECT Id,Name,Username,Email FROM User WHERE UserRoleId = '${params.role_id}' LIMIT 50`));
      }
      if (params.include_children) {
        promises.push(client.query<Record<string, unknown>>(`SELECT Id,Name,DeveloperName FROM UserRole WHERE ParentRoleId = '${params.role_id}' LIMIT 50`));
      }

      const results = await Promise.all(promises);
      const role = results[0] as Record<string, unknown>;

      const response: Record<string, unknown> = {
        id: role["Id"],
        name: role["Name"],
        developerName: role["DeveloperName"],
        parentRoleId: role["ParentRoleId"],
        rollupDescription: role["RollupDescription"],
        forecastUserId: role["ForecastUserId"],
        createdDate: role["CreatedDate"],
        lastModifiedDate: role["LastModifiedDate"],
      };

      let idx = 1;
      if (params.include_users) {
        const ur = results[idx++] as { records: unknown[]; totalSize: number };
        response.users = ur.records;
        response.userCount = ur.totalSize;
      }
      if (params.include_children) {
        const cr = results[idx++] as { records: unknown[] };
        response.childRoles = cr.records;
      }

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_role: async (args) => {
      const params = CreateRoleSchema.parse(args);
      const payload: Record<string, unknown> = {
        Name: params.name,
        DeveloperName: params.developer_name,
        MayForecastManagerShare: params.may_forecast_manager_share,
      };
      if (params.parent_role_id) payload["ParentRoleId"] = params.parent_role_id;
      if (params.forecast_user_id) payload["ForecastUserId"] = params.forecast_user_id;
      if (params.rollup_description) payload["RollupDescription"] = params.rollup_description;

      const result = await logger.time("tool.create_role", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/UserRole", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    update_role: async (args) => {
      const { role_id, ...updates } = UpdateRoleSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.name !== undefined) payload["Name"] = updates.name;
      if (updates.parent_role_id !== undefined) payload["ParentRoleId"] = updates.parent_role_id;
      if (updates.rollup_description !== undefined) payload["RollupDescription"] = updates.rollup_description;

      await logger.time("tool.update_role", () =>
        client.patch(`/sobjects/UserRole/${role_id}`, payload), {}
      );

      const response = { success: true, role_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    delete_role: async (args) => {
      const { role_id } = DeleteRoleSchema.parse(args);
      await logger.time("tool.delete_role", () =>
        client.delete(`/sobjects/UserRole/${role_id}`), {}
      );
      const response = { success: true, role_id, deleted: true };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
