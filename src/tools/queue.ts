// Queue tool group — Salesforce Queue management
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListQueuesSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  name_filter: z.string().optional().describe("Filter by queue name (case-insensitive substring)"),
  sobject_type: z.string().optional().describe("Filter by supported SObject type"),
  order_by: z.enum(["Name", "DeveloperName", "CreatedDate"]).optional().default("Name"),
});

const GetQueueSchema = z.object({
  queue_id: z.string().describe("Queue ID (Group record of type 'Queue')"),
  include_members: z.boolean().optional().default(false).describe("Include queue members"),
  include_objects: z.boolean().optional().default(false).describe("Include supported SObject types"),
});

const CreateQueueSchema = z.object({
  name: z.string().describe("Queue name (required)"),
  developer_name: z.string().describe("Queue developer/API name (required, no spaces)"),
  email: z.string().optional().describe("Queue email address for routing notifications"),
  does_include_bosses: z.boolean().optional().default(false).describe("Include managers of assigned agents"),
  description: z.string().optional(),
  sobject_types: z.array(z.string()).optional().describe("SObject types this queue supports (e.g. ['Case','Lead'])"),
});

const AddQueueMemberSchema = z.object({
  queue_id: z.string().describe("Queue Group ID"),
  user_id: z.string().optional().describe("User ID to add to the queue"),
  group_id: z.string().optional().describe("Group ID to add to the queue"),
});

const RemoveQueueMemberSchema = z.object({
  group_member_id: z.string().describe("GroupMember ID to remove from queue"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_queues",
      title: "List Queues",
      description: "List Salesforce Queues (Group records of type Queue). Returns queue names, developer names, email addresses, and member counts. Filter by name or supported SObject type.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          name_filter: { type: "string", description: "Filter by queue name" },
          sobject_type: { type: "string", description: "Filter by supported SObject type" },
          order_by: { type: "string", enum: ["Name", "DeveloperName", "CreatedDate"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_queue",
      title: "Get Queue",
      description: "Get full details for a Salesforce Queue by ID. Optionally includes queue members and supported SObject types.",
      inputSchema: {
        type: "object",
        properties: {
          queue_id: { type: "string", description: "Queue ID (required)" },
          include_members: { type: "boolean", description: "Include queue members" },
          include_objects: { type: "boolean", description: "Include supported SObject types" },
        },
        required: ["queue_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_queue",
      title: "Create Queue",
      description: "Create a new Salesforce Queue with optional supported SObject types and email routing address.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Queue name (required)" },
          developer_name: { type: "string", description: "Developer name (required, no spaces)" },
          email: { type: "string", description: "Queue email address" },
          does_include_bosses: { type: "boolean" },
          description: { type: "string" },
          sobject_types: { type: "array", items: { type: "string" }, description: "SObject types (e.g. ['Case'])" },
        },
        required: ["name", "developer_name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "add_queue_member",
      title: "Add Queue Member",
      description: "Add a user or group to a Salesforce Queue by creating a GroupMember record.",
      inputSchema: {
        type: "object",
        properties: {
          queue_id: { type: "string", description: "Queue Group ID (required)" },
          user_id: { type: "string", description: "User ID to add" },
          group_id: { type: "string", description: "Group ID to add" },
        },
        required: ["queue_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "remove_queue_member",
      title: "Remove Queue Member",
      description: "Remove a member from a Salesforce Queue by deleting the GroupMember record.",
      inputSchema: {
        type: "object",
        properties: {
          group_member_id: { type: "string", description: "GroupMember ID to remove (required)" },
        },
        required: ["group_member_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_queues: async (args) => {
      const params = ListQueuesSchema.parse(args);
      const conditions = ["Type = 'Queue'"];
      if (params.name_filter) conditions.push(`Name LIKE '%${params.name_filter.replace(/'/g, "\\'")}%'`);
      const where = `WHERE ${conditions.join(" AND ")}`;
      const soql = `SELECT Id,Name,DeveloperName,Email,DoesIncludeBosses,Description,CreatedDate FROM Group ${where} ORDER BY ${params.order_by} ASC LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Group ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_queues", () => client.query<Record<string, unknown>>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r["Id"],
          name: r["Name"],
          developerName: r["DeveloperName"],
          email: r["Email"],
          doesIncludeBosses: r["DoesIncludeBosses"],
          description: r["Description"],
          createdDate: r["CreatedDate"],
        })),
        meta: { total: countResult.totalSize, returned: result.records.length, hasMore: result.records.length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_queue: async (args) => {
      const params = GetQueueSchema.parse(args);
      const promises: Promise<unknown>[] = [
        client.get<Record<string, unknown>>(`/sobjects/Group/${params.queue_id}`),
      ];
      if (params.include_members) {
        promises.push(client.query<Record<string, unknown>>(`SELECT Id,UserOrGroupId,Group.Name FROM GroupMember WHERE GroupId = '${params.queue_id}' LIMIT 100`));
      }
      if (params.include_objects) {
        promises.push(client.query<Record<string, unknown>>(`SELECT Id,SobjectType FROM QueueSobject WHERE QueueId = '${params.queue_id}'`));
      }

      const results = await Promise.all(promises);
      const queue = results[0] as Record<string, unknown>;

      const response: Record<string, unknown> = {
        id: queue["Id"],
        name: queue["Name"],
        developerName: queue["DeveloperName"],
        email: queue["Email"],
        doesIncludeBosses: queue["DoesIncludeBosses"],
        description: queue["Description"],
        type: queue["Type"],
        createdDate: queue["CreatedDate"],
        lastModifiedDate: queue["LastModifiedDate"],
      };

      let idx = 1;
      if (params.include_members) {
        const mr = results[idx++] as { records: unknown[] };
        response.members = mr.records;
      }
      if (params.include_objects) {
        const or = results[idx++] as { records: Record<string, unknown>[] };
        response.supportedObjects = or.records.map((r) => r["SobjectType"]);
      }

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_queue: async (args) => {
      const params = CreateQueueSchema.parse(args);
      const payload: Record<string, unknown> = {
        Name: params.name,
        DeveloperName: params.developer_name,
        Type: "Queue",
        DoesIncludeBosses: params.does_include_bosses,
      };
      if (params.email) payload["Email"] = params.email;
      if (params.description) payload["Description"] = params.description;

      const result = await logger.time("tool.create_queue", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/Group", payload), {}
      );

      // Add supported SObject types if provided
      if (params.sobject_types && params.sobject_types.length > 0 && result.id) {
        await Promise.all(
          params.sobject_types.map((sobjectType) =>
            client.post("/sobjects/QueueSobject", { QueueId: result.id, SobjectType: sobjectType }).catch(() => null)
          )
        );
      }

      const response = {
        success: result.success,
        queueId: result.id,
        name: params.name,
        supportedObjects: params.sobject_types,
        errors: result.errors,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    add_queue_member: async (args) => {
      const params = AddQueueMemberSchema.parse(args);
      if (!params.user_id && !params.group_id) {
        throw new Error("Must provide either user_id or group_id");
      }
      const payload = {
        GroupId: params.queue_id,
        UserOrGroupId: params.user_id || params.group_id,
      };

      const result = await logger.time("tool.add_queue_member", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/GroupMember", payload), {}
      );

      const response = {
        success: result.success,
        groupMemberId: result.id,
        queueId: params.queue_id,
        memberUserId: params.user_id,
        memberGroupId: params.group_id,
        errors: result.errors,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    remove_queue_member: async (args) => {
      const { group_member_id } = RemoveQueueMemberSchema.parse(args);
      await logger.time("tool.remove_queue_member", () =>
        client.delete(`/sobjects/GroupMember/${group_member_id}`), {}
      );
      const response = { success: true, group_member_id, deleted: true };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
