// Leads tool group — Salesforce Lead object CRUD + list operations
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler, SalesforceLead } from "../types.js";
import { logger } from "../logger.js";

const LEAD_FIELDS = "Id,FirstName,LastName,Company,Email,Phone,Status,OwnerId,LeadSource,Rating,Industry,Title,Website,Description,CreatedDate,LastModifiedDate";

// === Zod Schemas ===
const ListLeadsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25).describe("Max records to return (default 25, max 200)"),
  offset: z.number().min(0).optional().default(0).describe("Offset for pagination (default 0)"),
  status: z.string().optional().describe("Filter by Status field (e.g. 'Open - Not Contacted', 'Working', 'Closed - Converted')"),
  owner_id: z.string().optional().describe("Filter by OwnerId (Salesforce user ID)"),
  lead_source: z.string().optional().describe("Filter by LeadSource field"),
  order_by: z.enum(["CreatedDate", "LastModifiedDate", "LastName", "Company"]).optional().default("CreatedDate").describe("Field to sort by"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC").describe("Sort direction"),
});

const GetLeadSchema = z.object({
  lead_id: z.string().describe("Salesforce Lead ID (18-character)"),
});

const CreateLeadSchema = z.object({
  last_name: z.string().describe("Lead last name (required by Salesforce)"),
  company: z.string().describe("Company name (required by Salesforce)"),
  first_name: z.string().optional().describe("Lead first name"),
  email: z.string().email().optional().describe("Lead email address"),
  phone: z.string().optional().describe("Lead phone number"),
  title: z.string().optional().describe("Lead job title"),
  lead_source: z.string().optional().describe("Lead source (e.g. 'Web', 'Phone Inquiry', 'Partner')"),
  status: z.string().optional().default("Open - Not Contacted").describe("Lead status (default: 'Open - Not Contacted')"),
  industry: z.string().optional().describe("Industry"),
  rating: z.enum(["Hot", "Warm", "Cold"]).optional().describe("Lead rating"),
  website: z.string().optional().describe("Company website"),
  description: z.string().optional().describe("Lead description / notes"),
});

const UpdateLeadSchema = z.object({
  lead_id: z.string().describe("Salesforce Lead ID to update"),
  last_name: z.string().optional().describe("Updated last name"),
  company: z.string().optional().describe("Updated company name"),
  first_name: z.string().optional().describe("Updated first name"),
  email: z.string().email().optional().describe("Updated email"),
  phone: z.string().optional().describe("Updated phone"),
  title: z.string().optional().describe("Updated job title"),
  status: z.string().optional().describe("Updated lead status"),
  lead_source: z.string().optional().describe("Updated lead source"),
  rating: z.enum(["Hot", "Warm", "Cold"]).optional().describe("Updated rating"),
  description: z.string().optional().describe("Updated description"),
});

const ConvertLeadSchema = z.object({
  lead_id: z.string().describe("Salesforce Lead ID to convert"),
  account_id: z.string().optional().describe("Existing Account ID to link. If omitted, a new Account is created."),
  contact_id: z.string().optional().describe("Existing Contact ID to link. If omitted, a new Contact is created."),
  opportunity_name: z.string().optional().describe("Name for the new Opportunity. If omitted, no Opportunity is created."),
  converted_status: z.string().optional().default("Closed - Converted").describe("Lead status to set on conversion (must be a 'converted' status value)"),
  do_not_create_opportunity: z.boolean().optional().default(false).describe("Set to true to skip Opportunity creation"),
  send_notification_email: z.boolean().optional().default(false).describe("Send notification email to lead owner on conversion"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_leads",
      title: "List Leads",
      description:
        "List Salesforce leads with optional filters. Supports filtering by status, owner, lead source, and sorting. Returns key lead fields. Use when browsing or filtering leads. Do NOT use to get a single lead's full details (use get_lead).",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records to return (default 25, max 200)" },
          offset: { type: "number", description: "Offset for pagination (default 0)" },
          status: { type: "string", description: "Filter by Status (e.g. 'Open - Not Contacted', 'Working', 'Closed - Converted')" },
          owner_id: { type: "string", description: "Filter by OwnerId" },
          lead_source: { type: "string", description: "Filter by LeadSource" },
          order_by: { type: "string", enum: ["CreatedDate", "LastModifiedDate", "LastName", "Company"], description: "Sort field" },
          order_dir: { type: "string", enum: ["ASC", "DESC"], description: "Sort direction" },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          records: { type: "array", items: { type: "object" } },
          meta: { type: "object", properties: { total: { type: "number" }, returned: { type: "number" }, hasMore: { type: "boolean" } } },
        },
        required: ["records", "meta"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_lead",
      title: "Get Lead",
      description:
        "Get full details for a specific Salesforce lead by ID. Returns all standard lead fields. Use when you have a lead ID and need detailed info.",
      inputSchema: {
        type: "object",
        properties: {
          lead_id: { type: "string", description: "Salesforce Lead ID (18-character)" },
        },
        required: ["lead_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_lead",
      title: "Create Lead",
      description:
        "Create a new Salesforce lead. Requires LastName and Company. Returns the new lead's ID.",
      inputSchema: {
        type: "object",
        properties: {
          last_name: { type: "string", description: "Lead last name (required)" },
          company: { type: "string", description: "Company name (required)" },
          first_name: { type: "string", description: "Lead first name" },
          email: { type: "string", description: "Email address" },
          phone: { type: "string", description: "Phone number" },
          title: { type: "string", description: "Job title" },
          lead_source: { type: "string", description: "Lead source" },
          status: { type: "string", description: "Lead status (default: 'Open - Not Contacted')" },
          industry: { type: "string", description: "Industry" },
          rating: { type: "string", enum: ["Hot", "Warm", "Cold"], description: "Rating" },
          website: { type: "string", description: "Company website" },
          description: { type: "string", description: "Notes / description" },
        },
        required: ["last_name", "company"],
      },
      outputSchema: { type: "object", properties: { id: { type: "string" }, success: { type: "boolean" } } },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_lead",
      title: "Update Lead",
      description:
        "Update an existing Salesforce lead. Only include fields you want to change. Use when modifying lead details or updating status.",
      inputSchema: {
        type: "object",
        properties: {
          lead_id: { type: "string", description: "Salesforce Lead ID to update" },
          last_name: { type: "string", description: "Updated last name" },
          company: { type: "string", description: "Updated company" },
          first_name: { type: "string", description: "Updated first name" },
          email: { type: "string", description: "Updated email" },
          phone: { type: "string", description: "Updated phone" },
          title: { type: "string", description: "Updated job title" },
          status: { type: "string", description: "Updated status" },
          lead_source: { type: "string", description: "Updated lead source" },
          rating: { type: "string", enum: ["Hot", "Warm", "Cold"], description: "Updated rating" },
          description: { type: "string", description: "Updated description" },
        },
        required: ["lead_id"],
      },
      outputSchema: { type: "object", properties: { success: { type: "boolean" }, lead_id: { type: "string" } } },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "convert_lead",
      title: "Convert Lead",
      description: "Convert a Salesforce lead into an Account, Contact, and optionally an Opportunity. This uses the Salesforce Lead Convert API. You can link to existing account/contact or create new ones.",
      inputSchema: {
        type: "object",
        properties: {
          lead_id: { type: "string", description: "Lead ID to convert" },
          account_id: { type: "string", description: "Existing Account ID (creates new Account if omitted)" },
          contact_id: { type: "string", description: "Existing Contact ID (creates new Contact if omitted)" },
          opportunity_name: { type: "string", description: "Name for new Opportunity (omit to skip Opportunity)" },
          converted_status: { type: "string", description: "Lead status to set (default: Closed - Converted)" },
          do_not_create_opportunity: { type: "boolean", description: "Skip Opportunity creation" },
          send_notification_email: { type: "boolean", description: "Send notification email to owner" },
        },
        required: ["lead_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_leads: async (args) => {
      const params = ListLeadsSchema.parse(args);

      let whereClause = "";
      const conditions: string[] = [];
      if (params.status) conditions.push(`Status = '${params.status.replace(/'/g, "\\'")}'`);
      if (params.owner_id) conditions.push(`OwnerId = '${params.owner_id}'`);
      if (params.lead_source) conditions.push(`LeadSource = '${params.lead_source.replace(/'/g, "\\'")}'`);
      if (conditions.length > 0) whereClause = `WHERE ${conditions.join(" AND ")}`;

      const soql = `SELECT ${LEAD_FIELDS} FROM Lead ${whereClause} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Lead ${whereClause}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_leads", () => client.query<SalesforceLead>(soql), { tool: "list_leads" }),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r.Id,
          name: `${r.FirstName || ""} ${r.LastName}`.trim(),
          company: r.Company,
          email: r.Email,
          phone: r.Phone,
          status: r.Status,
          leadSource: r.LeadSource,
          rating: r.Rating,
          createdDate: r.CreatedDate,
          lastModifiedDate: r.LastModifiedDate,
        })),
        meta: {
          total: countResult.totalSize,
          returned: result.records.length,
          hasMore: !result.done || result.records.length === params.limit,
          offset: params.offset,
          limit: params.limit,
        },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
      };
    },

    get_lead: async (args) => {
      const { lead_id } = GetLeadSchema.parse(args);
      const result = await logger.time("tool.get_lead", () =>
        client.get<SalesforceLead>(`/sobjects/Lead/${lead_id}`),
        { tool: "get_lead", lead_id }
      );

      const response = {
        id: result.Id,
        firstName: result.FirstName,
        lastName: result.LastName,
        company: result.Company,
        email: result.Email,
        phone: result.Phone,
        title: result.Title,
        status: result.Status,
        leadSource: result.LeadSource,
        rating: result.Rating,
        industry: result.Industry,
        website: result.Website,
        description: result.Description,
        ownerId: result.OwnerId,
        createdDate: result.CreatedDate,
        lastModifiedDate: result.LastModifiedDate,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
      };
    },

    create_lead: async (args) => {
      const params = CreateLeadSchema.parse(args);
      const payload: Record<string, unknown> = {
        LastName: params.last_name,
        Company: params.company,
        Status: params.status || "Open - Not Contacted",
      };

      if (params.first_name) payload.FirstName = params.first_name;
      if (params.email) payload.Email = params.email;
      if (params.phone) payload.Phone = params.phone;
      if (params.title) payload.Title = params.title;
      if (params.lead_source) payload.LeadSource = params.lead_source;
      if (params.industry) payload.Industry = params.industry;
      if (params.rating) payload.Rating = params.rating;
      if (params.website) payload.Website = params.website;
      if (params.description) payload.Description = params.description;

      const result = await logger.time("tool.create_lead", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/Lead", payload),
        { tool: "create_lead" }
      );

      const response = {
        id: result.id,
        success: result.success,
        errors: result.errors,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
      };
    },

    update_lead: async (args) => {
      const { lead_id, ...updates } = UpdateLeadSchema.parse(args);
      const payload: Record<string, unknown> = {};

      if (updates.last_name !== undefined) payload.LastName = updates.last_name;
      if (updates.first_name !== undefined) payload.FirstName = updates.first_name;
      if (updates.company !== undefined) payload.Company = updates.company;
      if (updates.email !== undefined) payload.Email = updates.email;
      if (updates.phone !== undefined) payload.Phone = updates.phone;
      if (updates.title !== undefined) payload.Title = updates.title;
      if (updates.status !== undefined) payload.Status = updates.status;
      if (updates.lead_source !== undefined) payload.LeadSource = updates.lead_source;
      if (updates.rating !== undefined) payload.Rating = updates.rating;
      if (updates.description !== undefined) payload.Description = updates.description;

      await logger.time("tool.update_lead", () =>
        client.patch(`/sobjects/Lead/${lead_id}`, payload),
        { tool: "update_lead", lead_id }
      );

      const response = { success: true, lead_id };
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
      };
    },

    convert_lead: async (args) => {
      const params = ConvertLeadSchema.parse(args);

      // Use the Salesforce Lead Convert REST action
      const payload: Record<string, unknown> = {
        leadId: params.lead_id,
        convertedStatus: params.converted_status || "Closed - Converted",
        doNotCreateOpportunity: params.do_not_create_opportunity ?? false,
        sendNotificationEmail: params.send_notification_email ?? false,
      };

      if (params.account_id) payload.accountId = params.account_id;
      if (params.contact_id) payload.contactId = params.contact_id;
      if (params.opportunity_name) payload.opportunityName = params.opportunity_name;

      const result = await logger.time("tool.convert_lead", () =>
        client.post<Record<string, unknown>>("/actions/standard/convertLead", { inputs: [payload] }),
        { tool: "convert_lead", lead_id: params.lead_id }
      );

      // The response is an array of output values
      const outputs = Array.isArray(result) ? result[0] : result;
      const outputValues = (outputs as Record<string, unknown>)?.["outputValues"] as Record<string, unknown> | undefined ?? outputs;

      const response = {
        success: true,
        leadId: params.lead_id,
        accountId: outputValues?.["accountId"],
        contactId: outputValues?.["contactId"],
        opportunityId: outputValues?.["opportunityId"],
        convertedStatus: params.converted_status || "Closed - Converted",
      };

      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
      };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return {
    tools: getToolDefinitions(),
    handlers: getToolHandlers(client),
  };
}
