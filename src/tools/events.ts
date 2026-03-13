// Events tool group — Salesforce Event object CRUD + list operations
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const EVENT_FIELDS = "Id,Subject,Location,Description,StartDateTime,EndDateTime,DurationInMinutes,IsAllDayEvent,OwnerId,WhoId,WhatId,ActivityDate,ShowAs,Type,CreatedDate,LastModifiedDate";

const ListEventsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  owner_id: z.string().optional().describe("Filter by OwnerId"),
  who_id: z.string().optional().describe("Filter by WhoId (related Contact or Lead)"),
  what_id: z.string().optional().describe("Filter by WhatId (related Account, Opportunity, etc.)"),
  start_after: z.string().optional().describe("Filter StartDateTime >= this datetime (ISO 8601)"),
  start_before: z.string().optional().describe("Filter StartDateTime <= this datetime (ISO 8601)"),
  order_by: z.enum(["StartDateTime", "CreatedDate", "LastModifiedDate", "Subject"]).optional().default("StartDateTime"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("ASC"),
});

const GetEventSchema = z.object({
  event_id: z.string().describe("Salesforce Event ID"),
});

const CreateEventSchema = z.object({
  subject: z.string().describe("Event subject / title (required)"),
  start_datetime: z.string().describe("Start date/time in ISO 8601 format (required, e.g. '2024-06-15T10:00:00')"),
  end_datetime: z.string().describe("End date/time in ISO 8601 format (required)"),
  location: z.string().optional().describe("Event location"),
  description: z.string().optional().describe("Event description / agenda"),
  owner_id: z.string().optional().describe("Owner User ID"),
  who_id: z.string().optional().describe("Related Contact or Lead ID"),
  what_id: z.string().optional().describe("Related Account, Opportunity, or Case ID"),
  is_all_day_event: z.boolean().optional().default(false).describe("Whether this is an all-day event"),
  show_as: z.enum(["Busy", "OutOfOffice", "Free"]).optional().default("Busy").describe("Free/Busy status"),
  type: z.string().optional().describe("Event type (e.g. 'Meeting', 'Call', 'Demo')"),
});

const UpdateEventSchema = z.object({
  event_id: z.string().describe("Salesforce Event ID to update"),
  subject: z.string().optional(),
  start_datetime: z.string().optional().describe("Updated start datetime ISO 8601"),
  end_datetime: z.string().optional().describe("Updated end datetime ISO 8601"),
  location: z.string().optional(),
  description: z.string().optional(),
  owner_id: z.string().optional(),
  who_id: z.string().optional(),
  what_id: z.string().optional(),
  show_as: z.enum(["Busy", "OutOfOffice", "Free"]).optional(),
  type: z.string().optional(),
});

const DeleteEventSchema = z.object({
  event_id: z.string().describe("Salesforce Event ID to delete"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_events",
      title: "List Events",
      description: "List Salesforce calendar events with optional filters by owner, related record, or date range. Supports pagination and sorting.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          owner_id: { type: "string", description: "Filter by OwnerId" },
          who_id: { type: "string", description: "Filter by WhoId (Contact or Lead)" },
          what_id: { type: "string", description: "Filter by WhatId (Account, Opportunity, etc.)" },
          start_after: { type: "string", description: "Filter StartDateTime >= (ISO 8601)" },
          start_before: { type: "string", description: "Filter StartDateTime <= (ISO 8601)" },
          order_by: { type: "string", enum: ["StartDateTime", "CreatedDate", "LastModifiedDate", "Subject"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_event",
      title: "Get Event",
      description: "Get full details for a Salesforce event by ID. Returns all fields including start/end time, location, and related records.",
      inputSchema: {
        type: "object",
        properties: { event_id: { type: "string", description: "Salesforce Event ID" } },
        required: ["event_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_event",
      title: "Create Event",
      description: "Create a new Salesforce calendar event. Subject, start and end datetime are required. Optionally link to contacts and related records.",
      inputSchema: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Event subject (required)" },
          start_datetime: { type: "string", description: "Start datetime ISO 8601 (required)" },
          end_datetime: { type: "string", description: "End datetime ISO 8601 (required)" },
          location: { type: "string" },
          description: { type: "string" },
          owner_id: { type: "string" },
          who_id: { type: "string", description: "Related Contact or Lead ID" },
          what_id: { type: "string", description: "Related Account, Opportunity ID" },
          is_all_day_event: { type: "boolean" },
          show_as: { type: "string", enum: ["Busy", "OutOfOffice", "Free"] },
          type: { type: "string", description: "Event type (Meeting/Call/Demo)" },
        },
        required: ["subject", "start_datetime", "end_datetime"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_event",
      title: "Update Event",
      description: "Update an existing Salesforce event. Only include fields to change.",
      inputSchema: {
        type: "object",
        properties: {
          event_id: { type: "string", description: "Event ID to update" },
          subject: { type: "string" },
          start_datetime: { type: "string" },
          end_datetime: { type: "string" },
          location: { type: "string" },
          description: { type: "string" },
          owner_id: { type: "string" },
          who_id: { type: "string" },
          what_id: { type: "string" },
          show_as: { type: "string", enum: ["Busy", "OutOfOffice", "Free"] },
          type: { type: "string" },
        },
        required: ["event_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "delete_event",
      title: "Delete Event",
      description: "Permanently delete a Salesforce event. This action cannot be undone.",
      inputSchema: {
        type: "object",
        properties: { event_id: { type: "string", description: "Event ID to delete" } },
        required: ["event_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_events: async (args) => {
      const params = ListEventsSchema.parse(args);
      const conditions: string[] = [];
      if (params.owner_id) conditions.push(`OwnerId = '${params.owner_id}'`);
      if (params.who_id) conditions.push(`WhoId = '${params.who_id}'`);
      if (params.what_id) conditions.push(`WhatId = '${params.what_id}'`);
      if (params.start_after) conditions.push(`StartDateTime >= ${params.start_after}`);
      if (params.start_before) conditions.push(`StartDateTime <= ${params.start_before}`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT ${EVENT_FIELDS} FROM Event ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Event ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_events", () => client.query(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: (result.records as Record<string, unknown>[]).map((r) => ({
          id: r["Id"],
          subject: r["Subject"],
          location: r["Location"],
          startDateTime: r["StartDateTime"],
          endDateTime: r["EndDateTime"],
          durationInMinutes: r["DurationInMinutes"],
          isAllDayEvent: r["IsAllDayEvent"],
          ownerId: r["OwnerId"],
          whoId: r["WhoId"],
          whatId: r["WhatId"],
          type: r["Type"],
          showAs: r["ShowAs"],
          activityDate: r["ActivityDate"],
        })),
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

    get_event: async (args) => {
      const { event_id } = GetEventSchema.parse(args);
      const result = await logger.time("tool.get_event", () =>
        client.get<Record<string, unknown>>(`/sobjects/Event/${event_id}`), {}
      );

      const response = {
        id: result["Id"],
        subject: result["Subject"],
        location: result["Location"],
        description: result["Description"],
        startDateTime: result["StartDateTime"],
        endDateTime: result["EndDateTime"],
        durationInMinutes: result["DurationInMinutes"],
        isAllDayEvent: result["IsAllDayEvent"],
        ownerId: result["OwnerId"],
        whoId: result["WhoId"],
        whatId: result["WhatId"],
        type: result["Type"],
        showAs: result["ShowAs"],
        activityDate: result["ActivityDate"],
        createdDate: result["CreatedDate"],
        lastModifiedDate: result["LastModifiedDate"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_event: async (args) => {
      const params = CreateEventSchema.parse(args);
      const payload: Record<string, unknown> = {
        Subject: params.subject,
        StartDateTime: params.start_datetime,
        EndDateTime: params.end_datetime,
        IsAllDayEvent: params.is_all_day_event ?? false,
        ShowAs: params.show_as || "Busy",
      };
      if (params.location) payload.Location = params.location;
      if (params.description) payload.Description = params.description;
      if (params.owner_id) payload.OwnerId = params.owner_id;
      if (params.who_id) payload.WhoId = params.who_id;
      if (params.what_id) payload.WhatId = params.what_id;
      if (params.type) payload.Type = params.type;

      const result = await logger.time("tool.create_event", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/Event", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    update_event: async (args) => {
      const { event_id, ...updates } = UpdateEventSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.subject !== undefined) payload.Subject = updates.subject;
      if (updates.start_datetime !== undefined) payload.StartDateTime = updates.start_datetime;
      if (updates.end_datetime !== undefined) payload.EndDateTime = updates.end_datetime;
      if (updates.location !== undefined) payload.Location = updates.location;
      if (updates.description !== undefined) payload.Description = updates.description;
      if (updates.owner_id !== undefined) payload.OwnerId = updates.owner_id;
      if (updates.who_id !== undefined) payload.WhoId = updates.who_id;
      if (updates.what_id !== undefined) payload.WhatId = updates.what_id;
      if (updates.show_as !== undefined) payload.ShowAs = updates.show_as;
      if (updates.type !== undefined) payload.Type = updates.type;

      await logger.time("tool.update_event", () => client.patch(`/sobjects/Event/${event_id}`, payload), {});

      const response = { success: true, event_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    delete_event: async (args) => {
      const { event_id } = DeleteEventSchema.parse(args);
      await logger.time("tool.delete_event", () => client.delete(`/sobjects/Event/${event_id}`), {});

      const response = { success: true, event_id, deleted: true };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
