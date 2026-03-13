// Group tool group — Salesforce Public Groups management
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListGroupsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  name_filter: z.string().optional().describe("Filter by group name"),
  group_type: z.enum(["Regular", "Role", "RoleAndSubordinates", "AllCustomerPortal"]).optional().describe("Filter by group type (Regular = Public Group)"),
  order_by: z.enum(["Name", "DeveloperName", "CreatedDate"]).optional().default("Name"),
});

const GetGroupSchema = z.object({
  group_id: z.string().describe("Group ID"),
  include_members: z.boolean().optional().default(false).describe("Include group members"),
});

const CreateGroupSchema = z.object({
  name: z.string().describe("Group name (required)"),
  developer_name: z.string().describe("Group developer name (required, no spaces)"),
  does_include_bosses: z.boolean().optional().default(false),
  email: z.string().optional(),
  description: z.string().optional(),
});

const AddGroupMemberSchema = z.object({
  group_id: z.string().describe("Group ID"),
  user_or_group_id: z.string().describe("User ID or Group ID to add as a member"),
});

const DeleteGroupSchema = z.object({
  group_id: z.string().describe("Group ID to delete"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_groups",
      title: "List Public Groups",
      description: "List Salesforce Public Groups. Can also list Role groups, RoleAndSubordinates groups, etc. Returns group names, types, and developer names.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          name_filter: { type: "string", description: "Filter by name" },
          group_type: { type: "string", enum: ["Regular", "Role", "RoleAndSubordinates", "AllCustomerPortal"], description: "Regular = Public Group" },
          order_by: { type: "string", enum: ["Name", "DeveloperName", "CreatedDate"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_group",
      title: "Get Group",
      description: "Get details for a Salesforce Public Group by ID, optionally including its members.",
      inputSchema: {
        type: "object",
        properties: {
          group_id: { type: "string", description: "Group ID (required)" },
          include_members: { type: "boolean", description: "Include group members" },
        },
        required: ["group_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_group",
      title: "Create Public Group",
      description: "Create a new Salesforce Public Group for sharing rules, queues, or permission assignments.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Group name (required)" },
          developer_name: { type: "string", description: "Developer name (required, no spaces)" },
          does_include_bosses: { type: "boolean" },
          email: { type: "string" },
          description: { type: "string" },
        },
        required: ["name", "developer_name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "add_group_member",
      title: "Add Group Member",
      description: "Add a user or group to a Salesforce Public Group by creating a GroupMember record.",
      inputSchema: {
        type: "object",
        properties: {
          group_id: { type: "string", description: "Group ID (required)" },
          user_or_group_id: { type: "string", description: "User ID or Group ID to add (required)" },
        },
        required: ["group_id", "user_or_group_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "delete_group",
      title: "Delete Group",
      description: "Delete a Salesforce Public Group. This will also remove its sharing rules and membership records.",
      inputSchema: {
        type: "object",
        properties: {
          group_id: { type: "string", description: "Group ID to delete" },
        },
        required: ["group_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_groups: async (args) => {
      const params = ListGroupsSchema.parse(args);
      const conditions: string[] = [];
      if (params.group_type) conditions.push(`Type = '${params.group_type}'`);
      else conditions.push(`Type = 'Regular'`);
      if (params.name_filter) conditions.push(`Name LIKE '%${params.name_filter.replace(/'/g, "\\'")}%'`);
      const where = `WHERE ${conditions.join(" AND ")}`;
      const soql = `SELECT Id,Name,DeveloperName,Type,Email,DoesIncludeBosses,Description,CreatedDate FROM Group ${where} ORDER BY ${params.order_by} ASC LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Group ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_groups", () => client.query<Record<string, unknown>>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r["Id"],
          name: r["Name"],
          developerName: r["DeveloperName"],
          type: r["Type"],
          email: r["Email"],
          doesIncludeBosses: r["DoesIncludeBosses"],
          description: r["Description"],
          createdDate: r["CreatedDate"],
        })),
        meta: { total: countResult.totalSize, returned: result.records.length, hasMore: result.records.length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_group: async (args) => {
      const params = GetGroupSchema.parse(args);
      const promises: Promise<unknown>[] = [
        client.get<Record<string, unknown>>(`/sobjects/Group/${params.group_id}`),
      ];
      if (params.include_members) {
        promises.push(client.query<Record<string, unknown>>(`SELECT Id,UserOrGroupId FROM GroupMember WHERE GroupId = '${params.group_id}' LIMIT 100`));
      }

      const results = await Promise.all(promises);
      const group = results[0] as Record<string, unknown>;

      const response: Record<string, unknown> = {
        id: group["Id"],
        name: group["Name"],
        developerName: group["DeveloperName"],
        type: group["Type"],
        email: group["Email"],
        doesIncludeBosses: group["DoesIncludeBosses"],
        description: group["Description"],
        createdDate: group["CreatedDate"],
        lastModifiedDate: group["LastModifiedDate"],
      };

      if (params.include_members) {
        const mr = results[1] as { records: unknown[] };
        response.members = mr.records;
      }

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_group: async (args) => {
      const params = CreateGroupSchema.parse(args);
      const payload: Record<string, unknown> = {
        Name: params.name,
        DeveloperName: params.developer_name,
        Type: "Regular",
        DoesIncludeBosses: params.does_include_bosses,
      };
      if (params.email) payload["Email"] = params.email;
      if (params.description) payload["Description"] = params.description;

      const result = await logger.time("tool.create_group", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/Group", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    add_group_member: async (args) => {
      const params = AddGroupMemberSchema.parse(args);
      const payload = { GroupId: params.group_id, UserOrGroupId: params.user_or_group_id };
      const result = await logger.time("tool.add_group_member", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/GroupMember", payload), {}
      );

      const response = {
        success: result.success,
        groupMemberId: result.id,
        groupId: params.group_id,
        userOrGroupId: params.user_or_group_id,
        errors: result.errors,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    delete_group: async (args) => {
      const { group_id } = DeleteGroupSchema.parse(args);
      await logger.time("tool.delete_group", () =>
        client.delete(`/sobjects/Group/${group_id}`), {}
      );
      const response = { success: true, group_id, deleted: true };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
