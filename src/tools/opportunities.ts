// Opportunities tool group — Salesforce Opportunity CRUD + list operations
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler, SalesforceOpportunity } from "../types.js";
import { logger } from "../logger.js";

const OPP_FIELDS = "Id,Name,AccountId,StageName,Amount,CloseDate,Probability,OwnerId,LeadSource,Description,Type,CreatedDate,LastModifiedDate";

const ListOpportunitiesSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  stage: z.string().optional().describe("Filter by StageName (e.g. 'Prospecting', 'Proposal/Price Quote', 'Closed Won', 'Closed Lost')"),
  account_id: z.string().optional().describe("Filter by AccountId"),
  owner_id: z.string().optional().describe("Filter by OwnerId"),
  close_date_after: z.string().optional().describe("Filter CloseDate >= this date (YYYY-MM-DD)"),
  close_date_before: z.string().optional().describe("Filter CloseDate <= this date (YYYY-MM-DD)"),
  order_by: z.enum(["CloseDate", "CreatedDate", "LastModifiedDate", "Amount", "Name"]).optional().default("CloseDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("ASC"),
});

const GetOpportunitySchema = z.object({
  opportunity_id: z.string().describe("Salesforce Opportunity ID"),
});

const CreateOpportunitySchema = z.object({
  name: z.string().describe("Opportunity name (required)"),
  stage_name: z.string().describe("Sales stage (required, e.g. 'Prospecting', 'Closed Won')"),
  close_date: z.string().describe("Expected close date in YYYY-MM-DD format (required)"),
  account_id: z.string().optional().describe("Associated Account ID"),
  amount: z.number().optional().describe("Opportunity amount / deal size"),
  lead_source: z.string().optional().describe("Lead source"),
  description: z.string().optional(),
  type: z.string().optional().describe("Opportunity type (e.g. 'New Business', 'Existing Business')"),
  owner_id: z.string().optional(),
});

const UpdateOpportunitySchema = z.object({
  opportunity_id: z.string(),
  name: z.string().optional(),
  stage_name: z.string().optional().describe("Updated sales stage"),
  close_date: z.string().optional().describe("Updated close date (YYYY-MM-DD)"),
  amount: z.number().optional(),
  account_id: z.string().optional(),
  lead_source: z.string().optional(),
  description: z.string().optional(),
  probability: z.number().min(0).max(100).optional().describe("Override probability percentage"),
  owner_id: z.string().optional(),
});

const CloseOpportunitySchema = z.object({
  opportunity_id: z.string().describe("Salesforce Opportunity ID to close"),
  outcome: z.enum(["won", "lost"]).describe("Close outcome: 'won' sets stage to Closed Won; 'lost' sets stage to Closed Lost"),
  close_date: z.string().optional().describe("Close date override in YYYY-MM-DD format (defaults to today)"),
  amount: z.number().optional().describe("Final deal amount (optional, only for won)"),
  description: z.string().optional().describe("Closing notes or reason for loss"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_opportunities",
      title: "List Opportunities",
      description: "List Salesforce opportunities with optional filters by stage, account, owner, and close date range. Use when browsing pipeline or filtering deals by stage.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
          offset: { type: "number" },
          stage: { type: "string", description: "StageName filter (e.g. 'Prospecting', 'Closed Won')" },
          account_id: { type: "string" },
          owner_id: { type: "string" },
          close_date_after: { type: "string", description: "YYYY-MM-DD" },
          close_date_before: { type: "string", description: "YYYY-MM-DD" },
          order_by: { type: "string", enum: ["CloseDate", "CreatedDate", "LastModifiedDate", "Amount", "Name"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_opportunity",
      title: "Get Opportunity",
      description: "Get full details for a Salesforce opportunity by ID. Returns all fields including stage, amount, close date, and related account.",
      inputSchema: {
        type: "object",
        properties: { opportunity_id: { type: "string", description: "Salesforce Opportunity ID" } },
        required: ["opportunity_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_opportunity",
      title: "Create Opportunity",
      description: "Create a new Salesforce opportunity. Requires name, stage, and close date. Link to an account via account_id.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Opportunity name (required)" },
          stage_name: { type: "string", description: "Sales stage (required)" },
          close_date: { type: "string", description: "Close date YYYY-MM-DD (required)" },
          account_id: { type: "string" },
          amount: { type: "number" },
          lead_source: { type: "string" },
          description: { type: "string" },
          type: { type: "string" },
          owner_id: { type: "string" },
        },
        required: ["name", "stage_name", "close_date"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_opportunity",
      title: "Update Opportunity",
      description: "Update an existing Salesforce opportunity. Common updates: stage_name, amount, close_date, probability. Only include fields to change.",
      inputSchema: {
        type: "object",
        properties: {
          opportunity_id: { type: "string", description: "Opportunity ID to update" },
          name: { type: "string" },
          stage_name: { type: "string", description: "Updated sales stage" },
          close_date: { type: "string", description: "Updated close date YYYY-MM-DD" },
          amount: { type: "number" },
          account_id: { type: "string" },
          lead_source: { type: "string" },
          description: { type: "string" },
          probability: { type: "number", description: "Override probability 0-100" },
          owner_id: { type: "string" },
        },
        required: ["opportunity_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "close_opportunity",
      title: "Close Opportunity",
      description: "Close a Salesforce opportunity as Won or Lost. Sets the stage to 'Closed Won' or 'Closed Lost' and updates the close date. Faster than update_opportunity for the common close action.",
      inputSchema: {
        type: "object",
        properties: {
          opportunity_id: { type: "string", description: "Opportunity ID to close" },
          outcome: { type: "string", enum: ["won", "lost"], description: "Close outcome: won or lost" },
          close_date: { type: "string", description: "Close date YYYY-MM-DD (defaults to today)" },
          amount: { type: "number", description: "Final deal amount (for won deals)" },
          description: { type: "string", description: "Closing notes or reason for loss" },
        },
        required: ["opportunity_id", "outcome"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_opportunities: async (args) => {
      const params = ListOpportunitiesSchema.parse(args);
      const conditions: string[] = [];
      if (params.stage) conditions.push(`StageName = '${params.stage.replace(/'/g, "\\'")}'`);
      if (params.account_id) conditions.push(`AccountId = '${params.account_id}'`);
      if (params.owner_id) conditions.push(`OwnerId = '${params.owner_id}'`);
      if (params.close_date_after) conditions.push(`CloseDate >= ${params.close_date_after}`);
      if (params.close_date_before) conditions.push(`CloseDate <= ${params.close_date_before}`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT ${OPP_FIELDS} FROM Opportunity ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Opportunity ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_opportunities", () => client.query<SalesforceOpportunity>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r.Id,
          name: r.Name,
          accountId: r.AccountId,
          stage: r.StageName,
          amount: r.Amount,
          closeDate: r.CloseDate,
          probability: r.Probability,
          ownerId: r.OwnerId,
          type: r.Type,
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

    get_opportunity: async (args) => {
      const { opportunity_id } = GetOpportunitySchema.parse(args);
      const result = await logger.time("tool.get_opportunity", () =>
        client.get<SalesforceOpportunity>(`/sobjects/Opportunity/${opportunity_id}`), {}
      );

      const response = {
        id: result.Id,
        name: result.Name,
        accountId: result.AccountId,
        stage: result.StageName,
        amount: result.Amount,
        closeDate: result.CloseDate,
        probability: result.Probability,
        ownerId: result.OwnerId,
        leadSource: result.LeadSource,
        description: result.Description,
        type: result.Type,
        createdDate: result.CreatedDate,
        lastModifiedDate: result.LastModifiedDate,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_opportunity: async (args) => {
      const params = CreateOpportunitySchema.parse(args);
      const payload: Record<string, unknown> = {
        Name: params.name,
        StageName: params.stage_name,
        CloseDate: params.close_date,
      };
      if (params.account_id) payload.AccountId = params.account_id;
      if (params.amount !== undefined) payload.Amount = params.amount;
      if (params.lead_source) payload.LeadSource = params.lead_source;
      if (params.description) payload.Description = params.description;
      if (params.type) payload.Type = params.type;
      if (params.owner_id) payload.OwnerId = params.owner_id;

      const result = await logger.time("tool.create_opportunity", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/Opportunity", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    update_opportunity: async (args) => {
      const { opportunity_id, ...updates } = UpdateOpportunitySchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.name !== undefined) payload.Name = updates.name;
      if (updates.stage_name !== undefined) payload.StageName = updates.stage_name;
      if (updates.close_date !== undefined) payload.CloseDate = updates.close_date;
      if (updates.amount !== undefined) payload.Amount = updates.amount;
      if (updates.account_id !== undefined) payload.AccountId = updates.account_id;
      if (updates.lead_source !== undefined) payload.LeadSource = updates.lead_source;
      if (updates.description !== undefined) payload.Description = updates.description;
      if (updates.probability !== undefined) payload.Probability = updates.probability;
      if (updates.owner_id !== undefined) payload.OwnerId = updates.owner_id;

      await logger.time("tool.update_opportunity", () =>
        client.patch(`/sobjects/Opportunity/${opportunity_id}`, payload), {}
      );

      const response = { success: true, opportunity_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    close_opportunity: async (args) => {
      const params = CloseOpportunitySchema.parse(args);
      const stageName = params.outcome === "won" ? "Closed Won" : "Closed Lost";
      const today = new Date().toISOString().split("T")[0];

      const payload: Record<string, unknown> = {
        StageName: stageName,
        CloseDate: params.close_date || today,
      };
      if (params.outcome === "won" && params.amount !== undefined) payload.Amount = params.amount;
      if (params.description !== undefined) payload.Description = params.description;

      await logger.time("tool.close_opportunity", () =>
        client.patch(`/sobjects/Opportunity/${params.opportunity_id}`, payload), {}
      );

      const response = {
        success: true,
        opportunity_id: params.opportunity_id,
        stage: stageName,
        closeDate: params.close_date || today,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
