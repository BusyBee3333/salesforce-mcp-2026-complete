// Note tool group — Salesforce Note and EnhancedNote (ContentNote) CRUD
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListNotesSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  parent_id: z.string().optional().describe("Filter by parent record ID"),
  title_filter: z.string().optional().describe("Filter by title substring"),
  owner_id: z.string().optional().describe("Filter by owner User ID"),
  order_by: z.enum(["Title", "CreatedDate", "LastModifiedDate"]).optional().default("LastModifiedDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

const GetNoteSchema = z.object({
  note_id: z.string().describe("Note ID"),
});

const CreateNoteSchema = z.object({
  title: z.string().describe("Note title (required)"),
  body: z.string().optional().describe("Note body text"),
  parent_id: z.string().describe("Parent record ID to attach the note to (required)"),
  is_private: z.boolean().optional().default(false).describe("Set true to make note private"),
  owner_id: z.string().optional().describe("Owner User ID (defaults to current user)"),
});

const UpdateNoteSchema = z.object({
  note_id: z.string().describe("Note ID to update"),
  title: z.string().optional(),
  body: z.string().optional(),
  is_private: z.boolean().optional(),
});

const DeleteNoteSchema = z.object({
  note_id: z.string().describe("Note ID to delete"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_notes",
      title: "List Notes",
      description: "List Salesforce Notes. Filter by parent record, title, or owner. Returns note titles, bodies (truncated), and metadata.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          parent_id: { type: "string", description: "Filter by parent record ID" },
          title_filter: { type: "string", description: "Filter by title substring" },
          owner_id: { type: "string", description: "Filter by owner User ID" },
          order_by: { type: "string", enum: ["Title", "CreatedDate", "LastModifiedDate"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_note",
      title: "Get Note",
      description: "Get full details and body of a Salesforce Note by ID.",
      inputSchema: {
        type: "object",
        properties: {
          note_id: { type: "string", description: "Note ID (required)" },
        },
        required: ["note_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_note",
      title: "Create Note",
      description: "Create a new Salesforce Note attached to a record. Notes can be private or public.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Note title (required)" },
          body: { type: "string", description: "Note body text" },
          parent_id: { type: "string", description: "Parent record ID (required)" },
          is_private: { type: "boolean", description: "Make note private (default false)" },
          owner_id: { type: "string", description: "Owner User ID" },
        },
        required: ["title", "parent_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_note",
      title: "Update Note",
      description: "Update an existing Salesforce Note.",
      inputSchema: {
        type: "object",
        properties: {
          note_id: { type: "string", description: "Note ID (required)" },
          title: { type: "string" },
          body: { type: "string" },
          is_private: { type: "boolean" },
        },
        required: ["note_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "delete_note",
      title: "Delete Note",
      description: "Delete a Salesforce Note permanently.",
      inputSchema: {
        type: "object",
        properties: {
          note_id: { type: "string", description: "Note ID to delete" },
        },
        required: ["note_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_notes: async (args) => {
      const params = ListNotesSchema.parse(args);
      const conditions: string[] = [];
      if (params.parent_id) conditions.push(`ParentId = '${params.parent_id}'`);
      if (params.title_filter) conditions.push(`Title LIKE '%${params.title_filter.replace(/'/g, "\\'")}%'`);
      if (params.owner_id) conditions.push(`OwnerId = '${params.owner_id}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,Title,Body,ParentId,OwnerId,IsPrivate,CreatedDate,LastModifiedDate FROM Note ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Note ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_notes", () => client.query<Record<string, unknown>>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r["Id"],
          title: r["Title"],
          bodySnippet: String(r["Body"] || "").slice(0, 200),
          parentId: r["ParentId"],
          ownerId: r["OwnerId"],
          isPrivate: r["IsPrivate"],
          createdDate: r["CreatedDate"],
          lastModifiedDate: r["LastModifiedDate"],
        })),
        meta: { total: countResult.totalSize, returned: result.records.length, hasMore: result.records.length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_note: async (args) => {
      const { note_id } = GetNoteSchema.parse(args);
      const result = await logger.time("tool.get_note", () =>
        client.get<Record<string, unknown>>(`/sobjects/Note/${note_id}`), {}
      );

      const response = {
        id: result["Id"],
        title: result["Title"],
        body: result["Body"],
        parentId: result["ParentId"],
        ownerId: result["OwnerId"],
        isPrivate: result["IsPrivate"],
        createdDate: result["CreatedDate"],
        lastModifiedDate: result["LastModifiedDate"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_note: async (args) => {
      const params = CreateNoteSchema.parse(args);
      const payload: Record<string, unknown> = {
        Title: params.title,
        ParentId: params.parent_id,
        IsPrivate: params.is_private,
      };
      if (params.body !== undefined) payload["Body"] = params.body;
      if (params.owner_id) payload["OwnerId"] = params.owner_id;

      const result = await logger.time("tool.create_note", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/Note", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    update_note: async (args) => {
      const { note_id, ...updates } = UpdateNoteSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.title !== undefined) payload["Title"] = updates.title;
      if (updates.body !== undefined) payload["Body"] = updates.body;
      if (updates.is_private !== undefined) payload["IsPrivate"] = updates.is_private;

      await logger.time("tool.update_note", () =>
        client.patch(`/sobjects/Note/${note_id}`, payload), {}
      );

      const response = { success: true, note_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    delete_note: async (args) => {
      const { note_id } = DeleteNoteSchema.parse(args);
      await logger.time("tool.delete_note", () =>
        client.delete(`/sobjects/Note/${note_id}`), {}
      );
      const response = { success: true, note_id, deleted: true };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
