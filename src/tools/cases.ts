// Cases tool group — Salesforce Case object list + create operations
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler, SalesforceCase } from "../types.js";
import { logger } from "../logger.js";

const CASE_FIELDS = "Id,Subject,AccountId,ContactId,Status,Priority,Origin,Description,OwnerId,CreatedDate,LastModifiedDate,CaseNumber";

const ListCasesSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  status: z.string().optional().describe("Filter by Status (e.g. 'New', 'Working', 'Escalated', 'Closed')"),
  priority: z.enum(["High", "Medium", "Low"]).optional().describe("Filter by Priority"),
  account_id: z.string().optional().describe("Filter by AccountId"),
  owner_id: z.string().optional().describe("Filter by OwnerId"),
  order_by: z.enum(["CreatedDate", "LastModifiedDate", "CaseNumber", "Priority"]).optional().default("CreatedDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

const GetCaseSchema = z.object({
  case_id: z.string().describe("Salesforce Case ID"),
});

const CreateCaseSchema = z.object({
  subject: z.string().describe("Case subject / title (required)"),
  account_id: z.string().optional().describe("Related Account ID"),
  contact_id: z.string().optional().describe("Related Contact ID"),
  status: z.string().optional().default("New").describe("Case status (default: 'New')"),
  priority: z.enum(["High", "Medium", "Low"]).optional().default("Medium").describe("Priority (default: 'Medium')"),
  origin: z.string().optional().describe("Case origin (e.g. 'Email', 'Phone', 'Web')"),
  description: z.string().optional().describe("Detailed description of the case"),
  owner_id: z.string().optional().describe("Salesforce user ID to assign the case to"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_cases",
      title: "List Cases",
      description: "List Salesforce support cases with optional filters by status, priority, account, or owner. Returns case number, subject, status, priority. Use when reviewing open cases or filtering by account.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
          offset: { type: "number" },
          status: { type: "string", description: "Status filter (e.g. 'New', 'Working', 'Closed')" },
          priority: { type: "string", enum: ["High", "Medium", "Low"] },
          account_id: { type: "string" },
          owner_id: { type: "string" },
          order_by: { type: "string", enum: ["CreatedDate", "LastModifiedDate", "CaseNumber", "Priority"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_case",
      title: "Get Case",
      description: "Get full details for a Salesforce support case by ID. Returns all case fields including subject, status, priority, origin, and description.",
      inputSchema: {
        type: "object",
        properties: { case_id: { type: "string", description: "Salesforce Case ID" } },
        required: ["case_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_case",
      title: "Create Case",
      description: "Create a new Salesforce support case. Requires Subject. Link to an account and/or contact.",
      inputSchema: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Case subject (required)" },
          account_id: { type: "string" },
          contact_id: { type: "string" },
          status: { type: "string", description: "Status (default: 'New')" },
          priority: { type: "string", enum: ["High", "Medium", "Low"], description: "Priority (default: 'Medium')" },
          origin: { type: "string", description: "Origin channel (e.g. 'Email', 'Phone', 'Web')" },
          description: { type: "string" },
          owner_id: { type: "string" },
        },
        required: ["subject"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_cases: async (args) => {
      const params = ListCasesSchema.parse(args);
      const conditions: string[] = [];
      if (params.status) conditions.push(`Status = '${params.status.replace(/'/g, "\\'")}'`);
      if (params.priority) conditions.push(`Priority = '${params.priority}'`);
      if (params.account_id) conditions.push(`AccountId = '${params.account_id}'`);
      if (params.owner_id) conditions.push(`OwnerId = '${params.owner_id}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT ${CASE_FIELDS} FROM Case ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Case ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_cases", () => client.query<SalesforceCase>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r.Id,
          caseNumber: r.CaseNumber,
          subject: r.Subject,
          accountId: r.AccountId,
          contactId: r.ContactId,
          status: r.Status,
          priority: r.Priority,
          origin: r.Origin,
          ownerId: r.OwnerId,
          createdDate: r.CreatedDate,
        })),
        meta: {
          total: countResult.totalSize,
          returned: result.records.length,
          hasMore: !result.done || result.records.length === params.limit,
          offset: params.offset,
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_case: async (args) => {
      const { case_id } = GetCaseSchema.parse(args);
      const result = await logger.time("tool.get_case", () =>
        client.get<SalesforceCase>(`/sobjects/Case/${case_id}`), {}
      );

      const response = {
        id: result.Id,
        caseNumber: result.CaseNumber,
        subject: result.Subject,
        accountId: result.AccountId,
        contactId: result.ContactId,
        status: result.Status,
        priority: result.Priority,
        origin: result.Origin,
        description: result.Description,
        ownerId: result.OwnerId,
        createdDate: result.CreatedDate,
        lastModifiedDate: result.LastModifiedDate,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_case: async (args) => {
      const params = CreateCaseSchema.parse(args);
      const payload: Record<string, unknown> = {
        Subject: params.subject,
        Status: params.status || "New",
        Priority: params.priority || "Medium",
      };
      if (params.account_id) payload.AccountId = params.account_id;
      if (params.contact_id) payload.ContactId = params.contact_id;
      if (params.origin) payload.Origin = params.origin;
      if (params.description) payload.Description = params.description;
      if (params.owner_id) payload.OwnerId = params.owner_id;

      const result = await logger.time("tool.create_case", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/Case", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
