// Tasks tool group — Salesforce Task object CRUD + list operations
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const TASK_FIELDS = "Id,Subject,Status,Priority,ActivityDate,OwnerId,WhoId,WhatId,Description,Type,IsHighPriority,IsClosed,CreatedDate,LastModifiedDate";

const ListTasksSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  status: z.string().optional().describe("Filter by Status (e.g. 'Not Started', 'In Progress', 'Completed')"),
  priority: z.string().optional().describe("Filter by Priority (e.g. 'High', 'Normal', 'Low')"),
  owner_id: z.string().optional().describe("Filter by OwnerId"),
  who_id: z.string().optional().describe("Filter by WhoId (related Contact or Lead ID)"),
  what_id: z.string().optional().describe("Filter by WhatId (related Account, Opportunity, etc.)"),
  is_closed: z.boolean().optional().describe("Filter by IsClosed flag"),
  order_by: z.enum(["ActivityDate", "CreatedDate", "LastModifiedDate", "Subject"]).optional().default("ActivityDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

const GetTaskSchema = z.object({
  task_id: z.string().describe("Salesforce Task ID"),
});

const CreateTaskSchema = z.object({
  subject: z.string().describe("Task subject / title (required)"),
  status: z.string().optional().default("Not Started").describe("Task status (default: 'Not Started')"),
  priority: z.enum(["High", "Normal", "Low"]).optional().default("Normal").describe("Task priority"),
  activity_date: z.string().optional().describe("Due date in YYYY-MM-DD format"),
  owner_id: z.string().optional().describe("Salesforce User ID of task owner"),
  who_id: z.string().optional().describe("WhoId: related Contact or Lead ID"),
  what_id: z.string().optional().describe("WhatId: related Account, Opportunity, Case, etc."),
  description: z.string().optional().describe("Task description / notes"),
  type: z.string().optional().describe("Task type (e.g. 'Call', 'Email', 'Meeting')"),
});

const UpdateTaskSchema = z.object({
  task_id: z.string().describe("Salesforce Task ID to update"),
  subject: z.string().optional(),
  status: z.string().optional(),
  priority: z.enum(["High", "Normal", "Low"]).optional(),
  activity_date: z.string().optional().describe("Due date YYYY-MM-DD"),
  owner_id: z.string().optional(),
  who_id: z.string().optional(),
  what_id: z.string().optional(),
  description: z.string().optional(),
  type: z.string().optional(),
});

const CompleteTaskSchema = z.object({
  task_id: z.string().describe("Salesforce Task ID to mark as completed"),
  description: z.string().optional().describe("Optional completion notes to append"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_tasks",
      title: "List Tasks",
      description: "List Salesforce tasks with optional filters by status, priority, owner, or related record. Supports pagination and sorting.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          status: { type: "string", description: "Filter by Status" },
          priority: { type: "string", description: "Filter by Priority (High/Normal/Low)" },
          owner_id: { type: "string", description: "Filter by OwnerId" },
          who_id: { type: "string", description: "Filter by WhoId (Contact or Lead)" },
          what_id: { type: "string", description: "Filter by WhatId (Account, Opportunity, etc.)" },
          is_closed: { type: "boolean", description: "Filter by closed/open status" },
          order_by: { type: "string", enum: ["ActivityDate", "CreatedDate", "LastModifiedDate", "Subject"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_task",
      title: "Get Task",
      description: "Get full details for a Salesforce task by ID. Returns all task fields including related records.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string", description: "Salesforce Task ID" } },
        required: ["task_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_task",
      title: "Create Task",
      description: "Create a new Salesforce task. Subject is required. Optionally link to a contact/lead (who_id) and an account/opportunity (what_id).",
      inputSchema: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Task subject (required)" },
          status: { type: "string", description: "Status (default: Not Started)" },
          priority: { type: "string", enum: ["High", "Normal", "Low"], description: "Priority" },
          activity_date: { type: "string", description: "Due date YYYY-MM-DD" },
          owner_id: { type: "string", description: "Owner User ID" },
          who_id: { type: "string", description: "Related Contact or Lead ID" },
          what_id: { type: "string", description: "Related Account, Opportunity, or Case ID" },
          description: { type: "string", description: "Task notes" },
          type: { type: "string", description: "Task type (Call/Email/Meeting)" },
        },
        required: ["subject"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_task",
      title: "Update Task",
      description: "Update an existing Salesforce task. Only include fields to change.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to update" },
          subject: { type: "string" },
          status: { type: "string" },
          priority: { type: "string", enum: ["High", "Normal", "Low"] },
          activity_date: { type: "string", description: "Due date YYYY-MM-DD" },
          owner_id: { type: "string" },
          who_id: { type: "string" },
          what_id: { type: "string" },
          description: { type: "string" },
          type: { type: "string" },
        },
        required: ["task_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "complete_task",
      title: "Complete Task",
      description: "Mark a Salesforce task as Completed. Optionally add completion notes to the description.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID to complete" },
          description: { type: "string", description: "Optional completion notes" },
        },
        required: ["task_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_tasks: async (args) => {
      const params = ListTasksSchema.parse(args);
      const conditions: string[] = [];
      if (params.status) conditions.push(`Status = '${params.status.replace(/'/g, "\\'")}'`);
      if (params.priority) conditions.push(`Priority = '${params.priority.replace(/'/g, "\\'")}'`);
      if (params.owner_id) conditions.push(`OwnerId = '${params.owner_id}'`);
      if (params.who_id) conditions.push(`WhoId = '${params.who_id}'`);
      if (params.what_id) conditions.push(`WhatId = '${params.what_id}'`);
      if (params.is_closed !== undefined) conditions.push(`IsClosed = ${params.is_closed}`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT ${TASK_FIELDS} FROM Task ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Task ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_tasks", () => client.query(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: (result.records as Record<string, unknown>[]).map((r) => ({
          id: r["Id"],
          subject: r["Subject"],
          status: r["Status"],
          priority: r["Priority"],
          activityDate: r["ActivityDate"],
          ownerId: r["OwnerId"],
          whoId: r["WhoId"],
          whatId: r["WhatId"],
          type: r["Type"],
          isClosed: r["IsClosed"],
          isHighPriority: r["IsHighPriority"],
          createdDate: r["CreatedDate"],
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

    get_task: async (args) => {
      const { task_id } = GetTaskSchema.parse(args);
      const result = await logger.time("tool.get_task", () =>
        client.get<Record<string, unknown>>(`/sobjects/Task/${task_id}`), {}
      );

      const response = {
        id: result["Id"],
        subject: result["Subject"],
        status: result["Status"],
        priority: result["Priority"],
        activityDate: result["ActivityDate"],
        ownerId: result["OwnerId"],
        whoId: result["WhoId"],
        whatId: result["WhatId"],
        description: result["Description"],
        type: result["Type"],
        isClosed: result["IsClosed"],
        isHighPriority: result["IsHighPriority"],
        createdDate: result["CreatedDate"],
        lastModifiedDate: result["LastModifiedDate"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_task: async (args) => {
      const params = CreateTaskSchema.parse(args);
      const payload: Record<string, unknown> = {
        Subject: params.subject,
        Status: params.status || "Not Started",
        Priority: params.priority || "Normal",
      };
      if (params.activity_date) payload.ActivityDate = params.activity_date;
      if (params.owner_id) payload.OwnerId = params.owner_id;
      if (params.who_id) payload.WhoId = params.who_id;
      if (params.what_id) payload.WhatId = params.what_id;
      if (params.description) payload.Description = params.description;
      if (params.type) payload.Type = params.type;

      const result = await logger.time("tool.create_task", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/Task", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    update_task: async (args) => {
      const { task_id, ...updates } = UpdateTaskSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.subject !== undefined) payload.Subject = updates.subject;
      if (updates.status !== undefined) payload.Status = updates.status;
      if (updates.priority !== undefined) payload.Priority = updates.priority;
      if (updates.activity_date !== undefined) payload.ActivityDate = updates.activity_date;
      if (updates.owner_id !== undefined) payload.OwnerId = updates.owner_id;
      if (updates.who_id !== undefined) payload.WhoId = updates.who_id;
      if (updates.what_id !== undefined) payload.WhatId = updates.what_id;
      if (updates.description !== undefined) payload.Description = updates.description;
      if (updates.type !== undefined) payload.Type = updates.type;

      await logger.time("tool.update_task", () => client.patch(`/sobjects/Task/${task_id}`, payload), {});

      const response = { success: true, task_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    complete_task: async (args) => {
      const params = CompleteTaskSchema.parse(args);
      const payload: Record<string, unknown> = { Status: "Completed" };
      if (params.description) payload.Description = params.description;

      await logger.time("tool.complete_task", () => client.patch(`/sobjects/Task/${params.task_id}`, payload), {});

      const response = { success: true, task_id: params.task_id, status: "Completed" };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
