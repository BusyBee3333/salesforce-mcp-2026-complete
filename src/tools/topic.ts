// Topic tool group — Salesforce Topics (tagging/categorization system)
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListTopicsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  name_filter: z.string().optional().describe("Filter by topic name (case-insensitive substring)"),
  managed_topic_type: z.enum(["Featured", "Navigational"]).optional().describe("Filter by managed topic type"),
  order_by: z.enum(["Name", "CreatedDate", "TalkingAbout"]).optional().default("Name"),
});

const GetTopicSchema = z.object({
  topic_id: z.string().describe("Topic ID"),
  include_tagged_records: z.boolean().optional().default(false).describe("Include records tagged with this topic"),
});

const CreateTopicSchema = z.object({
  name: z.string().describe("Topic name (required)"),
  description: z.string().optional().describe("Topic description"),
});

const UpdateTopicSchema = z.object({
  topic_id: z.string().describe("Topic ID to update"),
  name: z.string().optional(),
  description: z.string().optional(),
});

const DeleteTopicSchema = z.object({
  topic_id: z.string().describe("Topic ID to delete"),
});

const AssignTopicSchema = z.object({
  topic_id: z.string().describe("Topic ID to assign"),
  entity_id: z.string().describe("Record ID to tag with the topic"),
  entity_type: z.string().describe("SObject type of the record (e.g. 'Account', 'Case')"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_topics",
      title: "List Topics",
      description: "List Salesforce Topics used for tagging records and Chatter posts. Returns topic names, descriptions, and talking-about counts. Filter by name or managed topic type.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          name_filter: { type: "string", description: "Filter by name" },
          managed_topic_type: { type: "string", enum: ["Featured", "Navigational"] },
          order_by: { type: "string", enum: ["Name", "CreatedDate", "TalkingAbout"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_topic",
      title: "Get Topic",
      description: "Get full details for a Salesforce Topic by ID, including description and talking-about count. Optionally include records tagged with the topic.",
      inputSchema: {
        type: "object",
        properties: {
          topic_id: { type: "string", description: "Topic ID (required)" },
          include_tagged_records: { type: "boolean", description: "Include tagged records" },
        },
        required: ["topic_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_topic",
      title: "Create Topic",
      description: "Create a new Salesforce Topic for tagging records and Chatter posts.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Topic name (required)" },
          description: { type: "string", description: "Topic description" },
        },
        required: ["name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_topic",
      title: "Update Topic",
      description: "Update an existing Salesforce Topic.",
      inputSchema: {
        type: "object",
        properties: {
          topic_id: { type: "string", description: "Topic ID (required)" },
          name: { type: "string" },
          description: { type: "string" },
        },
        required: ["topic_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "delete_topic",
      title: "Delete Topic",
      description: "Delete a Salesforce Topic. This removes the topic and all its assignments from records.",
      inputSchema: {
        type: "object",
        properties: {
          topic_id: { type: "string", description: "Topic ID to delete" },
        },
        required: ["topic_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "assign_topic",
      title: "Assign Topic to Record",
      description: "Assign (tag) a Salesforce Topic to a record by creating a TopicAssignment.",
      inputSchema: {
        type: "object",
        properties: {
          topic_id: { type: "string", description: "Topic ID (required)" },
          entity_id: { type: "string", description: "Record ID to tag (required)" },
          entity_type: { type: "string", description: "SObject type of the record (e.g. 'Account')" },
        },
        required: ["topic_id", "entity_id", "entity_type"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_topics: async (args) => {
      const params = ListTopicsSchema.parse(args);
      const conditions: string[] = [];
      if (params.name_filter) conditions.push(`Name LIKE '%${params.name_filter.replace(/'/g, "\\'")}%'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const orderField = params.order_by === "TalkingAbout" ? "TalkingAbout" : params.order_by;
      const soql = `SELECT Id,Name,Description,TalkingAbout,CreatedDate FROM Topic ${where} ORDER BY ${orderField} ASC LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Topic ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_topics", () => client.query<Record<string, unknown>>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r["Id"],
          name: r["Name"],
          description: r["Description"],
          talkingAbout: r["TalkingAbout"],
          createdDate: r["CreatedDate"],
        })),
        meta: { total: countResult.totalSize, returned: result.records.length, hasMore: result.records.length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_topic: async (args) => {
      const params = GetTopicSchema.parse(args);
      const promises: Promise<unknown>[] = [
        client.get<Record<string, unknown>>(`/sobjects/Topic/${params.topic_id}`),
      ];
      if (params.include_tagged_records) {
        promises.push(client.query<Record<string, unknown>>(`SELECT Id,EntityId,EntityType FROM TopicAssignment WHERE TopicId = '${params.topic_id}' LIMIT 50`));
      }

      const results = await Promise.all(promises);
      const topic = results[0] as Record<string, unknown>;

      const response: Record<string, unknown> = {
        id: topic["Id"],
        name: topic["Name"],
        description: topic["Description"],
        talkingAbout: topic["TalkingAbout"],
        createdDate: topic["CreatedDate"],
        lastModifiedDate: topic["LastModifiedDate"],
      };

      if (params.include_tagged_records) {
        const tr = results[1] as { records: unknown[] };
        response.taggedRecords = tr.records;
      }

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_topic: async (args) => {
      const params = CreateTopicSchema.parse(args);
      const payload: Record<string, unknown> = { Name: params.name };
      if (params.description) payload["Description"] = params.description;

      const result = await logger.time("tool.create_topic", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/Topic", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    update_topic: async (args) => {
      const { topic_id, ...updates } = UpdateTopicSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.name !== undefined) payload["Name"] = updates.name;
      if (updates.description !== undefined) payload["Description"] = updates.description;

      await logger.time("tool.update_topic", () =>
        client.patch(`/sobjects/Topic/${topic_id}`, payload), {}
      );

      const response = { success: true, topic_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    delete_topic: async (args) => {
      const { topic_id } = DeleteTopicSchema.parse(args);
      await logger.time("tool.delete_topic", () =>
        client.delete(`/sobjects/Topic/${topic_id}`), {}
      );
      const response = { success: true, topic_id, deleted: true };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    assign_topic: async (args) => {
      const params = AssignTopicSchema.parse(args);
      const payload = {
        TopicId: params.topic_id,
        EntityId: params.entity_id,
        EntityType: params.entity_type,
      };

      const result = await logger.time("tool.assign_topic", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/TopicAssignment", payload), {}
      );

      const response = {
        success: result.success,
        assignmentId: result.id,
        topicId: params.topic_id,
        entityId: params.entity_id,
        entityType: params.entity_type,
        errors: result.errors,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
