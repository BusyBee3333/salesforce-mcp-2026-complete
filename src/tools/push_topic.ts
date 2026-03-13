// Push Topic tool group — Salesforce PushTopic (Streaming API subscriptions)
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListPushTopicsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  name_filter: z.string().optional().describe("Filter by topic name"),
  is_active: z.boolean().optional().describe("Filter by active status"),
  order_by: z.enum(["Name", "CreatedDate", "LastModifiedDate"]).optional().default("Name"),
});

const GetPushTopicSchema = z.object({
  push_topic_id: z.string().describe("PushTopic ID"),
});

const CreatePushTopicSchema = z.object({
  name: z.string().describe("PushTopic name (required, no spaces, used as channel name /topic/<name>)"),
  query: z.string().describe("SOQL query that defines which records to stream (required)"),
  api_version: z.number().optional().default(59.0).describe("API version for the PushTopic"),
  notify_for_fields: z.enum(["All", "Referenced", "Select", "Where"]).optional().default("Referenced").describe("Which field changes trigger notifications"),
  notify_for_operation_create: z.boolean().optional().default(true),
  notify_for_operation_update: z.boolean().optional().default(true),
  notify_for_operation_delete: z.boolean().optional().default(false),
  notify_for_operation_undelete: z.boolean().optional().default(false),
  is_active: z.boolean().optional().default(true),
  description: z.string().optional(),
});

const UpdatePushTopicSchema = z.object({
  push_topic_id: z.string().describe("PushTopic ID to update"),
  name: z.string().optional(),
  query: z.string().optional(),
  notify_for_fields: z.enum(["All", "Referenced", "Select", "Where"]).optional(),
  notify_for_operation_create: z.boolean().optional(),
  notify_for_operation_update: z.boolean().optional(),
  notify_for_operation_delete: z.boolean().optional(),
  notify_for_operation_undelete: z.boolean().optional(),
  is_active: z.boolean().optional(),
  description: z.string().optional(),
});

const DeletePushTopicSchema = z.object({
  push_topic_id: z.string().describe("PushTopic ID to delete"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_push_topics",
      title: "List Push Topics",
      description: "List Salesforce PushTopics used for the Streaming API. Returns topic names (also the CometD channel names as /topic/<name>), SOQL queries, and notification settings.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          name_filter: { type: "string", description: "Filter by name" },
          is_active: { type: "boolean", description: "Filter by active status" },
          order_by: { type: "string", enum: ["Name", "CreatedDate", "LastModifiedDate"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_push_topic",
      title: "Get Push Topic",
      description: "Get full details for a Salesforce PushTopic by ID, including SOQL query, notification settings, and streaming channel name.",
      inputSchema: {
        type: "object",
        properties: {
          push_topic_id: { type: "string", description: "PushTopic ID (required)" },
        },
        required: ["push_topic_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_push_topic",
      title: "Create Push Topic",
      description: "Create a new Salesforce PushTopic to enable Streaming API subscriptions. Clients subscribe to /topic/<name> via CometD to receive real-time record change notifications matching the SOQL query.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Topic name (channel will be /topic/<name>)" },
          query: { type: "string", description: "SOQL query defining which records to stream" },
          api_version: { type: "number", description: "API version (default 59.0)" },
          notify_for_fields: { type: "string", enum: ["All", "Referenced", "Select", "Where"], description: "Which fields trigger notifications" },
          notify_for_operation_create: { type: "boolean" },
          notify_for_operation_update: { type: "boolean" },
          notify_for_operation_delete: { type: "boolean" },
          notify_for_operation_undelete: { type: "boolean" },
          is_active: { type: "boolean" },
          description: { type: "string" },
        },
        required: ["name", "query"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_push_topic",
      title: "Update Push Topic",
      description: "Update an existing Salesforce PushTopic — change SOQL query, notification settings, or active status.",
      inputSchema: {
        type: "object",
        properties: {
          push_topic_id: { type: "string", description: "PushTopic ID (required)" },
          name: { type: "string" },
          query: { type: "string" },
          notify_for_fields: { type: "string", enum: ["All", "Referenced", "Select", "Where"] },
          notify_for_operation_create: { type: "boolean" },
          notify_for_operation_update: { type: "boolean" },
          notify_for_operation_delete: { type: "boolean" },
          notify_for_operation_undelete: { type: "boolean" },
          is_active: { type: "boolean" },
          description: { type: "string" },
        },
        required: ["push_topic_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "delete_push_topic",
      title: "Delete Push Topic",
      description: "Delete a Salesforce PushTopic. This disables the streaming channel /topic/<name> for all subscribers.",
      inputSchema: {
        type: "object",
        properties: {
          push_topic_id: { type: "string", description: "PushTopic ID to delete" },
        },
        required: ["push_topic_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_push_topics: async (args) => {
      const params = ListPushTopicsSchema.parse(args);
      const conditions: string[] = [];
      if (params.name_filter) conditions.push(`Name LIKE '%${params.name_filter.replace(/'/g, "\\'")}%'`);
      if (params.is_active !== undefined) conditions.push(`IsActive = ${params.is_active}`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,Name,Query,ApiVersion,IsActive,NotifyForFields,NotifyForOperationCreate,NotifyForOperationUpdate,NotifyForOperationDelete,NotifyForOperationUndelete,Description,CreatedDate,LastModifiedDate FROM PushTopic ${where} ORDER BY ${params.order_by} ASC LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM PushTopic ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_push_topics", () => client.query<Record<string, unknown>>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r["Id"],
          name: r["Name"],
          channelName: `/topic/${r["Name"]}`,
          query: r["Query"],
          apiVersion: r["ApiVersion"],
          isActive: r["IsActive"],
          notifyForFields: r["NotifyForFields"],
          notifyForCreate: r["NotifyForOperationCreate"],
          notifyForUpdate: r["NotifyForOperationUpdate"],
          notifyForDelete: r["NotifyForOperationDelete"],
          description: r["Description"],
          createdDate: r["CreatedDate"],
        })),
        meta: { total: countResult.totalSize, returned: result.records.length, hasMore: result.records.length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_push_topic: async (args) => {
      const { push_topic_id } = GetPushTopicSchema.parse(args);
      const result = await logger.time("tool.get_push_topic", () =>
        client.get<Record<string, unknown>>(`/sobjects/PushTopic/${push_topic_id}`), {}
      );

      const response = {
        id: result["Id"],
        name: result["Name"],
        channelName: `/topic/${result["Name"]}`,
        query: result["Query"],
        apiVersion: result["ApiVersion"],
        isActive: result["IsActive"],
        notifyForFields: result["NotifyForFields"],
        notifyForCreate: result["NotifyForOperationCreate"],
        notifyForUpdate: result["NotifyForOperationUpdate"],
        notifyForDelete: result["NotifyForOperationDelete"],
        notifyForUndelete: result["NotifyForOperationUndelete"],
        description: result["Description"],
        createdDate: result["CreatedDate"],
        lastModifiedDate: result["LastModifiedDate"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_push_topic: async (args) => {
      const params = CreatePushTopicSchema.parse(args);
      const payload: Record<string, unknown> = {
        Name: params.name,
        Query: params.query,
        ApiVersion: params.api_version,
        IsActive: params.is_active,
        NotifyForFields: params.notify_for_fields,
        NotifyForOperationCreate: params.notify_for_operation_create,
        NotifyForOperationUpdate: params.notify_for_operation_update,
        NotifyForOperationDelete: params.notify_for_operation_delete,
        NotifyForOperationUndelete: params.notify_for_operation_undelete,
      };
      if (params.description) payload["Description"] = params.description;

      const result = await logger.time("tool.create_push_topic", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/PushTopic", payload), {}
      );

      const response = {
        success: result.success,
        pushTopicId: result.id,
        channelName: `/topic/${params.name}`,
        name: params.name,
        errors: result.errors,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    update_push_topic: async (args) => {
      const { push_topic_id, ...updates } = UpdatePushTopicSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.name !== undefined) payload["Name"] = updates.name;
      if (updates.query !== undefined) payload["Query"] = updates.query;
      if (updates.notify_for_fields !== undefined) payload["NotifyForFields"] = updates.notify_for_fields;
      if (updates.notify_for_operation_create !== undefined) payload["NotifyForOperationCreate"] = updates.notify_for_operation_create;
      if (updates.notify_for_operation_update !== undefined) payload["NotifyForOperationUpdate"] = updates.notify_for_operation_update;
      if (updates.notify_for_operation_delete !== undefined) payload["NotifyForOperationDelete"] = updates.notify_for_operation_delete;
      if (updates.notify_for_operation_undelete !== undefined) payload["NotifyForOperationUndelete"] = updates.notify_for_operation_undelete;
      if (updates.is_active !== undefined) payload["IsActive"] = updates.is_active;
      if (updates.description !== undefined) payload["Description"] = updates.description;

      await logger.time("tool.update_push_topic", () =>
        client.patch(`/sobjects/PushTopic/${push_topic_id}`, payload), {}
      );

      const response = { success: true, push_topic_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    delete_push_topic: async (args) => {
      const { push_topic_id } = DeletePushTopicSchema.parse(args);
      await logger.time("tool.delete_push_topic", () =>
        client.delete(`/sobjects/PushTopic/${push_topic_id}`), {}
      );
      const response = { success: true, push_topic_id, deleted: true };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
