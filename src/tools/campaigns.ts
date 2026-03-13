// Campaigns tool group — Salesforce Campaign object CRUD + member management
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const CAMPAIGN_FIELDS = "Id,Name,Type,Status,StartDate,EndDate,BudgetedCost,ActualCost,ExpectedRevenue,NumberSent,NumberOfLeads,NumberOfContacts,NumberOfOpportunities,OwnerId,IsActive,Description,CreatedDate,LastModifiedDate";

const ListCampaignsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  type: z.string().optional().describe("Filter by Type (e.g. 'Email', 'Webinar', 'Advertisement')"),
  status: z.string().optional().describe("Filter by Status (e.g. 'Planning', 'Active', 'Completed')"),
  is_active: z.boolean().optional().describe("Filter by IsActive flag"),
  owner_id: z.string().optional().describe("Filter by OwnerId"),
  order_by: z.enum(["CreatedDate", "LastModifiedDate", "Name", "StartDate", "EndDate"]).optional().default("CreatedDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

const GetCampaignSchema = z.object({
  campaign_id: z.string().describe("Salesforce Campaign ID"),
});

const CreateCampaignSchema = z.object({
  name: z.string().describe("Campaign name (required)"),
  type: z.string().optional().describe("Campaign type (e.g. 'Email', 'Webinar', 'Advertisement', 'Conference')"),
  status: z.string().optional().default("Planning").describe("Campaign status (default: Planning)"),
  start_date: z.string().optional().describe("Start date YYYY-MM-DD"),
  end_date: z.string().optional().describe("End date YYYY-MM-DD"),
  budgeted_cost: z.number().optional().describe("Budgeted cost"),
  expected_revenue: z.number().optional().describe("Expected revenue from campaign"),
  description: z.string().optional(),
  is_active: z.boolean().optional().default(true),
  owner_id: z.string().optional(),
});

const AddCampaignMemberSchema = z.object({
  campaign_id: z.string().describe("Salesforce Campaign ID"),
  lead_or_contact_id: z.string().describe("Salesforce Lead or Contact ID to add as campaign member"),
  status: z.string().optional().default("Sent").describe("Member status (e.g. 'Sent', 'Responded', 'Converted')"),
});

const ListCampaignMembersSchema = z.object({
  campaign_id: z.string().describe("Salesforce Campaign ID"),
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  status: z.string().optional().describe("Filter by member Status"),
  order_by: z.enum(["CreatedDate", "LastModifiedDate"]).optional().default("CreatedDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_campaigns",
      title: "List Campaigns",
      description: "List Salesforce campaigns with optional filters by type, status, or active flag. Supports pagination and sorting.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          type: { type: "string", description: "Filter by campaign type" },
          status: { type: "string", description: "Filter by status (Planning/Active/Completed)" },
          is_active: { type: "boolean", description: "Filter by active status" },
          owner_id: { type: "string", description: "Filter by OwnerId" },
          order_by: { type: "string", enum: ["CreatedDate", "LastModifiedDate", "Name", "StartDate", "EndDate"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_campaign",
      title: "Get Campaign",
      description: "Get full details for a Salesforce campaign by ID. Returns all fields including metrics (leads, contacts, revenue).",
      inputSchema: {
        type: "object",
        properties: { campaign_id: { type: "string", description: "Salesforce Campaign ID" } },
        required: ["campaign_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_campaign",
      title: "Create Campaign",
      description: "Create a new Salesforce campaign. Name is required. Optionally set type, status, dates, budget, and expected revenue.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Campaign name (required)" },
          type: { type: "string", description: "Campaign type (Email/Webinar/Conference/Advertisement)" },
          status: { type: "string", description: "Status (default: Planning)" },
          start_date: { type: "string", description: "Start date YYYY-MM-DD" },
          end_date: { type: "string", description: "End date YYYY-MM-DD" },
          budgeted_cost: { type: "number" },
          expected_revenue: { type: "number" },
          description: { type: "string" },
          is_active: { type: "boolean" },
          owner_id: { type: "string" },
        },
        required: ["name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "add_campaign_member",
      title: "Add Campaign Member",
      description: "Add a Lead or Contact to a Salesforce campaign as a campaign member. Returns the new CampaignMember ID.",
      inputSchema: {
        type: "object",
        properties: {
          campaign_id: { type: "string", description: "Campaign ID" },
          lead_or_contact_id: { type: "string", description: "Lead or Contact ID to add" },
          status: { type: "string", description: "Member status (default: Sent)" },
        },
        required: ["campaign_id", "lead_or_contact_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "list_campaign_members",
      title: "List Campaign Members",
      description: "List all members of a Salesforce campaign. Returns lead/contact details and member status with pagination.",
      inputSchema: {
        type: "object",
        properties: {
          campaign_id: { type: "string", description: "Campaign ID" },
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          status: { type: "string", description: "Filter by member status" },
          order_by: { type: "string", enum: ["CreatedDate", "LastModifiedDate"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
        required: ["campaign_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_campaigns: async (args) => {
      const params = ListCampaignsSchema.parse(args);
      const conditions: string[] = [];
      if (params.type) conditions.push(`Type = '${params.type.replace(/'/g, "\\'")}'`);
      if (params.status) conditions.push(`Status = '${params.status.replace(/'/g, "\\'")}'`);
      if (params.is_active !== undefined) conditions.push(`IsActive = ${params.is_active}`);
      if (params.owner_id) conditions.push(`OwnerId = '${params.owner_id}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT ${CAMPAIGN_FIELDS} FROM Campaign ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Campaign ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_campaigns", () => client.query(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: (result.records as Record<string, unknown>[]).map((r) => ({
          id: r["Id"],
          name: r["Name"],
          type: r["Type"],
          status: r["Status"],
          isActive: r["IsActive"],
          startDate: r["StartDate"],
          endDate: r["EndDate"],
          budgetedCost: r["BudgetedCost"],
          actualCost: r["ActualCost"],
          expectedRevenue: r["ExpectedRevenue"],
          numberOfLeads: r["NumberOfLeads"],
          numberOfContacts: r["NumberOfContacts"],
          numberOfOpportunities: r["NumberOfOpportunities"],
          ownerId: r["OwnerId"],
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

    get_campaign: async (args) => {
      const { campaign_id } = GetCampaignSchema.parse(args);
      const result = await logger.time("tool.get_campaign", () =>
        client.get<Record<string, unknown>>(`/sobjects/Campaign/${campaign_id}`), {}
      );

      const response = {
        id: result["Id"],
        name: result["Name"],
        type: result["Type"],
        status: result["Status"],
        isActive: result["IsActive"],
        startDate: result["StartDate"],
        endDate: result["EndDate"],
        budgetedCost: result["BudgetedCost"],
        actualCost: result["ActualCost"],
        expectedRevenue: result["ExpectedRevenue"],
        numberSent: result["NumberSent"],
        numberOfLeads: result["NumberOfLeads"],
        numberOfContacts: result["NumberOfContacts"],
        numberOfOpportunities: result["NumberOfOpportunities"],
        ownerId: result["OwnerId"],
        description: result["Description"],
        createdDate: result["CreatedDate"],
        lastModifiedDate: result["LastModifiedDate"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_campaign: async (args) => {
      const params = CreateCampaignSchema.parse(args);
      const payload: Record<string, unknown> = {
        Name: params.name,
        Status: params.status || "Planning",
        IsActive: params.is_active ?? true,
      };
      if (params.type) payload.Type = params.type;
      if (params.start_date) payload.StartDate = params.start_date;
      if (params.end_date) payload.EndDate = params.end_date;
      if (params.budgeted_cost !== undefined) payload.BudgetedCost = params.budgeted_cost;
      if (params.expected_revenue !== undefined) payload.ExpectedRevenue = params.expected_revenue;
      if (params.description) payload.Description = params.description;
      if (params.owner_id) payload.OwnerId = params.owner_id;

      const result = await logger.time("tool.create_campaign", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/Campaign", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    add_campaign_member: async (args) => {
      const params = AddCampaignMemberSchema.parse(args);
      const payload: Record<string, unknown> = {
        CampaignId: params.campaign_id,
        Status: params.status || "Sent",
      };

      // CampaignMember uses LeadId or ContactId depending on the type of related record
      // The API accepts a generic "LeadOrContactId" alias for upsert but direct create needs the right field
      // We'll use LeadId first and fall back gracefully — the caller knows what they're passing
      const idLen = params.lead_or_contact_id.length;
      // Salesforce IDs starting with '003' are Contacts, '00Q' are Leads
      const prefix = params.lead_or_contact_id.substring(0, 3).toLowerCase();
      if (prefix === "003") {
        payload.ContactId = params.lead_or_contact_id;
      } else {
        payload.LeadId = params.lead_or_contact_id;
      }
      // Suppress unused variable warning
      void idLen;

      const result = await logger.time("tool.add_campaign_member", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/CampaignMember", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    list_campaign_members: async (args) => {
      const params = ListCampaignMembersSchema.parse(args);
      const conditions: string[] = [`CampaignId = '${params.campaign_id}'`];
      if (params.status) conditions.push(`Status = '${params.status.replace(/'/g, "\\'")}'`);
      const where = `WHERE ${conditions.join(" AND ")}`;
      const soql = `SELECT Id,CampaignId,LeadId,ContactId,Status,HasResponded,FirstRespondedDate,CreatedDate,LastModifiedDate FROM CampaignMember ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM CampaignMember ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_campaign_members", () => client.query(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        campaign_id: params.campaign_id,
        records: (result.records as Record<string, unknown>[]).map((r) => ({
          id: r["Id"],
          leadId: r["LeadId"],
          contactId: r["ContactId"],
          status: r["Status"],
          hasResponded: r["HasResponded"],
          firstRespondedDate: r["FirstRespondedDate"],
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
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
