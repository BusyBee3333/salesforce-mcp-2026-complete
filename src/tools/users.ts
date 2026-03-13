// Users tool group — Salesforce User object read operations
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const USER_FIELDS = "Id,Name,FirstName,LastName,Username,Email,Title,Department,Phone,MobilePhone,IsActive,UserType,ProfileId,Profile.Name,ManagerId,Manager.Name,TimeZoneSidKey,LanguageLocaleKey,LocaleSidKey,CreatedDate,LastModifiedDate,LastLoginDate";

const ListUsersSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  is_active: z.boolean().optional().describe("Filter by IsActive (default: no filter)"),
  user_type: z.string().optional().describe("Filter by UserType (e.g. 'Standard', 'Partner', 'Guest', 'PowerPartner')"),
  profile_id: z.string().optional().describe("Filter by ProfileId"),
  department: z.string().optional().describe("Filter by Department"),
  name_search: z.string().optional().describe("Search by name (partial match on Name field)"),
  order_by: z.enum(["Name", "CreatedDate", "LastModifiedDate", "LastLoginDate", "Username"]).optional().default("Name"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("ASC"),
});

const GetUserSchema = z.object({
  user_id: z.string().describe("Salesforce User ID"),
  include_permissions: z.boolean().optional().default(false).describe("Include user permission set assignments"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_users",
      title: "List Users",
      description: "List Salesforce users with optional filters by active status, user type, profile, or department. Supports name search and pagination.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          is_active: { type: "boolean", description: "Filter by active status" },
          user_type: { type: "string", description: "Filter by UserType (Standard/Partner/Guest)" },
          profile_id: { type: "string", description: "Filter by ProfileId" },
          department: { type: "string", description: "Filter by Department" },
          name_search: { type: "string", description: "Partial name search" },
          order_by: { type: "string", enum: ["Name", "CreatedDate", "LastModifiedDate", "LastLoginDate", "Username"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_user",
      title: "Get User",
      description: "Get full details for a Salesforce user by ID. Returns profile, manager, timezone, locale, and login history. Optionally includes permission set assignments.",
      inputSchema: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "Salesforce User ID" },
          include_permissions: { type: "boolean", description: "Include permission set assignments (default false)" },
        },
        required: ["user_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_current_user",
      title: "Get Current User",
      description: "Get the Salesforce user details for the currently authenticated API user. Useful for determining context, permissions, and org defaults.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_users: async (args) => {
      const params = ListUsersSchema.parse(args);
      const conditions: string[] = [];
      if (params.is_active !== undefined) conditions.push(`IsActive = ${params.is_active}`);
      if (params.user_type) conditions.push(`UserType = '${params.user_type.replace(/'/g, "\\'")}'`);
      if (params.profile_id) conditions.push(`ProfileId = '${params.profile_id}'`);
      if (params.department) conditions.push(`Department = '${params.department.replace(/'/g, "\\'")}'`);
      if (params.name_search) conditions.push(`Name LIKE '%${params.name_search.replace(/'/g, "\\'").replace(/%/g, "\\%")}%'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT ${USER_FIELDS} FROM User ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM User ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_users", () => client.query(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: (result.records as Record<string, unknown>[]).map((r) => {
          const profile = r["Profile"] as Record<string, unknown> | undefined;
          const manager = r["Manager"] as Record<string, unknown> | undefined;
          return {
            id: r["Id"],
            name: r["Name"],
            firstName: r["FirstName"],
            lastName: r["LastName"],
            username: r["Username"],
            email: r["Email"],
            title: r["Title"],
            department: r["Department"],
            isActive: r["IsActive"],
            userType: r["UserType"],
            profileId: r["ProfileId"],
            profileName: profile?.["Name"],
            managerId: r["ManagerId"],
            managerName: manager?.["Name"],
            lastLoginDate: r["LastLoginDate"],
          };
        }),
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

    get_user: async (args) => {
      const params = GetUserSchema.parse(args);

      const promises: Promise<unknown>[] = [
        logger.time("tool.get_user", () =>
          client.get<Record<string, unknown>>(`/sobjects/User/${params.user_id}`), {}
        ),
      ];

      if (params.include_permissions) {
        promises.push(
          client.query(
            `SELECT PermissionSetId, PermissionSet.Name, PermissionSet.Label FROM PermissionSetAssignment WHERE AssigneeId = '${params.user_id}' AND PermissionSet.IsOwnedByProfile = false`
          )
        );
      }

      const results = await Promise.all(promises);
      const user = results[0] as Record<string, unknown>;

      const response: Record<string, unknown> = {
        id: user["Id"],
        name: user["Name"],
        firstName: user["FirstName"],
        lastName: user["LastName"],
        username: user["Username"],
        email: user["Email"],
        title: user["Title"],
        department: user["Department"],
        phone: user["Phone"],
        mobilePhone: user["MobilePhone"],
        isActive: user["IsActive"],
        userType: user["UserType"],
        profileId: user["ProfileId"],
        managerId: user["ManagerId"],
        timeZone: user["TimeZoneSidKey"],
        language: user["LanguageLocaleKey"],
        locale: user["LocaleSidKey"],
        lastLoginDate: user["LastLoginDate"],
        createdDate: user["CreatedDate"],
        lastModifiedDate: user["LastModifiedDate"],
      };

      if (params.include_permissions) {
        const permResult = results[1] as { records: Record<string, unknown>[] };
        response.permissionSets = permResult.records.map((r) => {
          const ps = r["PermissionSet"] as Record<string, unknown> | undefined;
          return {
            permissionSetId: r["PermissionSetId"],
            name: ps?.["Name"],
            label: ps?.["Label"],
          };
        });
      }

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_current_user: async (_args) => {
      // The /chatter/users/me endpoint or /services/data/vXX.0/sobjects/User/me
      // Use identity URL approach: first get the identity, then fetch user details
      const identity = await logger.time("tool.get_current_user.identity", () =>
        client.get<Record<string, unknown>>("/chatter/users/me"), {}
      );

      const response = {
        id: identity["id"],
        name: identity["name"],
        username: identity["username"],
        email: identity["email"],
        firstName: identity["firstName"],
        lastName: identity["lastName"],
        title: identity["title"],
        isActive: identity["isActive"],
        userType: identity["userType"],
        profileId: identity["profileId"],
        profileName: identity["profileName"],
        timeZone: identity["utcOffset"],
        locale: identity["locale"],
        language: identity["language"],
        photoUrl: (identity["photo"] as Record<string, unknown> | undefined)?.["smallPhotoUrl"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
