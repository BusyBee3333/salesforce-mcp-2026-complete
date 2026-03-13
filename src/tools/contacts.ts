// Contacts tool group — Salesforce Contact object CRUD + list operations
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler, SalesforceContact } from "../types.js";
import { logger } from "../logger.js";

const CONTACT_FIELDS = "Id,FirstName,LastName,AccountId,Email,Phone,Title,Department,MailingCity,MailingState,MailingCountry,CreatedDate,LastModifiedDate";

const ListContactsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  account_id: z.string().optional().describe("Filter by AccountId"),
  email: z.string().optional().describe("Filter by exact email"),
  order_by: z.enum(["CreatedDate", "LastModifiedDate", "LastName", "FirstName"]).optional().default("CreatedDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

const GetContactSchema = z.object({
  contact_id: z.string().describe("Salesforce Contact ID"),
});

const CreateContactSchema = z.object({
  last_name: z.string().describe("Contact last name (required)"),
  first_name: z.string().optional(),
  account_id: z.string().optional().describe("Salesforce Account ID to link"),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  title: z.string().optional(),
  department: z.string().optional(),
  mailing_city: z.string().optional(),
  mailing_state: z.string().optional(),
  mailing_country: z.string().optional(),
});

const UpdateContactSchema = z.object({
  contact_id: z.string(),
  last_name: z.string().optional(),
  first_name: z.string().optional(),
  account_id: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  title: z.string().optional(),
  department: z.string().optional(),
  mailing_city: z.string().optional(),
  mailing_state: z.string().optional(),
  mailing_country: z.string().optional(),
});

const DeleteContactSchema = z.object({
  contact_id: z.string().describe("Salesforce Contact ID to delete"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_contacts",
      title: "List Contacts",
      description: "List Salesforce contacts with optional filters by account or email. Supports pagination and sorting. Use when browsing contacts or finding contacts for an account.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          account_id: { type: "string", description: "Filter by Account ID" },
          email: { type: "string", description: "Filter by exact email address" },
          order_by: { type: "string", enum: ["CreatedDate", "LastModifiedDate", "LastName", "FirstName"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object", properties: { records: { type: "array" }, meta: { type: "object" } } },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_contact",
      title: "Get Contact",
      description: "Get full details for a Salesforce contact by ID. Returns all standard fields including account link and address.",
      inputSchema: {
        type: "object",
        properties: { contact_id: { type: "string", description: "Salesforce Contact ID" } },
        required: ["contact_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_contact",
      title: "Create Contact",
      description: "Create a new Salesforce contact. Requires LastName. Optionally link to an Account via account_id.",
      inputSchema: {
        type: "object",
        properties: {
          last_name: { type: "string", description: "Last name (required)" },
          first_name: { type: "string" },
          account_id: { type: "string", description: "Account ID to link" },
          email: { type: "string" },
          phone: { type: "string" },
          title: { type: "string" },
          department: { type: "string" },
          mailing_city: { type: "string" },
          mailing_state: { type: "string" },
          mailing_country: { type: "string" },
        },
        required: ["last_name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_contact",
      title: "Update Contact",
      description: "Update an existing Salesforce contact. Only include fields to change.",
      inputSchema: {
        type: "object",
        properties: {
          contact_id: { type: "string", description: "Contact ID to update" },
          last_name: { type: "string" },
          first_name: { type: "string" },
          account_id: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          title: { type: "string" },
          department: { type: "string" },
          mailing_city: { type: "string" },
          mailing_state: { type: "string" },
          mailing_country: { type: "string" },
        },
        required: ["contact_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "delete_contact",
      title: "Delete Contact",
      description: "Permanently delete a Salesforce contact by ID. This action cannot be undone.",
      inputSchema: {
        type: "object",
        properties: { contact_id: { type: "string", description: "Contact ID to delete" } },
        required: ["contact_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_contacts: async (args) => {
      const params = ListContactsSchema.parse(args);
      const conditions: string[] = [];
      if (params.account_id) conditions.push(`AccountId = '${params.account_id}'`);
      if (params.email) conditions.push(`Email = '${params.email.replace(/'/g, "\\'")}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT ${CONTACT_FIELDS} FROM Contact ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Contact ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_contacts", () => client.query<SalesforceContact>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r.Id,
          name: `${r.FirstName || ""} ${r.LastName}`.trim(),
          accountId: r.AccountId,
          email: r.Email,
          phone: r.Phone,
          title: r.Title,
          department: r.Department,
          city: r.MailingCity,
          state: r.MailingState,
          country: r.MailingCountry,
          createdDate: r.CreatedDate,
        })),
        meta: {
          total: countResult.totalSize,
          returned: result.records.length,
          hasMore: !result.done || result.records.length === params.limit,
          offset: params.offset,
        },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
      };
    },

    get_contact: async (args) => {
      const { contact_id } = GetContactSchema.parse(args);
      const result = await logger.time("tool.get_contact", () =>
        client.get<SalesforceContact>(`/sobjects/Contact/${contact_id}`), {}
      );

      const response = {
        id: result.Id,
        firstName: result.FirstName,
        lastName: result.LastName,
        accountId: result.AccountId,
        email: result.Email,
        phone: result.Phone,
        title: result.Title,
        department: result.Department,
        mailingCity: result.MailingCity,
        mailingState: result.MailingState,
        mailingCountry: result.MailingCountry,
        createdDate: result.CreatedDate,
        lastModifiedDate: result.LastModifiedDate,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
      };
    },

    create_contact: async (args) => {
      const params = CreateContactSchema.parse(args);
      const payload: Record<string, unknown> = { LastName: params.last_name };
      if (params.first_name) payload.FirstName = params.first_name;
      if (params.account_id) payload.AccountId = params.account_id;
      if (params.email) payload.Email = params.email;
      if (params.phone) payload.Phone = params.phone;
      if (params.title) payload.Title = params.title;
      if (params.department) payload.Department = params.department;
      if (params.mailing_city) payload.MailingCity = params.mailing_city;
      if (params.mailing_state) payload.MailingState = params.mailing_state;
      if (params.mailing_country) payload.MailingCountry = params.mailing_country;

      const result = await logger.time("tool.create_contact", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/Contact", payload), {}
      );

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },

    update_contact: async (args) => {
      const { contact_id, ...updates } = UpdateContactSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.last_name !== undefined) payload.LastName = updates.last_name;
      if (updates.first_name !== undefined) payload.FirstName = updates.first_name;
      if (updates.account_id !== undefined) payload.AccountId = updates.account_id;
      if (updates.email !== undefined) payload.Email = updates.email;
      if (updates.phone !== undefined) payload.Phone = updates.phone;
      if (updates.title !== undefined) payload.Title = updates.title;
      if (updates.department !== undefined) payload.Department = updates.department;
      if (updates.mailing_city !== undefined) payload.MailingCity = updates.mailing_city;
      if (updates.mailing_state !== undefined) payload.MailingState = updates.mailing_state;
      if (updates.mailing_country !== undefined) payload.MailingCountry = updates.mailing_country;

      await logger.time("tool.update_contact", () =>
        client.patch(`/sobjects/Contact/${contact_id}`, payload), {}
      );

      const response = { success: true, contact_id };
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
      };
    },

    delete_contact: async (args) => {
      const { contact_id } = DeleteContactSchema.parse(args);
      await logger.time("tool.delete_contact", () =>
        client.delete(`/sobjects/Contact/${contact_id}`), {}
      );

      const response = { success: true, contact_id, deleted: true };
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
      };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
