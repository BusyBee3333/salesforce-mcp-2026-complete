// Accounts tool group — Salesforce Account object CRUD + list operations
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler, SalesforceAccount } from "../types.js";
import { logger } from "../logger.js";

const ACCOUNT_FIELDS = "Id,Name,Type,Industry,AnnualRevenue,NumberOfEmployees,Phone,Website,BillingCity,BillingState,BillingCountry,OwnerId,CreatedDate,LastModifiedDate";

const ListAccountsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  type: z.string().optional().describe("Filter by account Type (e.g. 'Customer', 'Partner', 'Prospect')"),
  industry: z.string().optional().describe("Filter by Industry"),
  owner_id: z.string().optional().describe("Filter by OwnerId"),
  order_by: z.enum(["CreatedDate", "LastModifiedDate", "Name", "AnnualRevenue"]).optional().default("CreatedDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

const GetAccountSchema = z.object({
  account_id: z.string().describe("Salesforce Account ID"),
  include_contacts: z.boolean().optional().default(false).describe("Include related contacts"),
  include_opportunities: z.boolean().optional().default(false).describe("Include related opportunities"),
});

const CreateAccountSchema = z.object({
  name: z.string().describe("Account name (required)"),
  type: z.string().optional().describe("Account type (e.g. 'Customer', 'Partner')"),
  industry: z.string().optional(),
  annual_revenue: z.number().optional(),
  number_of_employees: z.number().optional(),
  phone: z.string().optional(),
  website: z.string().optional(),
  billing_city: z.string().optional(),
  billing_state: z.string().optional(),
  billing_country: z.string().optional(),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_accounts",
      title: "List Accounts",
      description: "List Salesforce accounts with optional filters by type, industry, or owner. Returns key account fields with pagination.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          type: { type: "string", description: "Filter by account type" },
          industry: { type: "string", description: "Filter by industry" },
          owner_id: { type: "string", description: "Filter by owner ID" },
          order_by: { type: "string", enum: ["CreatedDate", "LastModifiedDate", "Name", "AnnualRevenue"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_account",
      title: "Get Account",
      description: "Get full details for a Salesforce account by ID. Optionally includes related contacts and opportunities. Use when you need account details or want to see related records.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "Salesforce Account ID" },
          include_contacts: { type: "boolean", description: "Include related contacts (default false)" },
          include_opportunities: { type: "boolean", description: "Include related opportunities (default false)" },
        },
        required: ["account_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_account",
      title: "Create Account",
      description: "Create a new Salesforce account. Only Name is required.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Account name (required)" },
          type: { type: "string", description: "Account type" },
          industry: { type: "string" },
          annual_revenue: { type: "number" },
          number_of_employees: { type: "number" },
          phone: { type: "string" },
          website: { type: "string" },
          billing_city: { type: "string" },
          billing_state: { type: "string" },
          billing_country: { type: "string" },
        },
        required: ["name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_accounts: async (args) => {
      const params = ListAccountsSchema.parse(args);
      const conditions: string[] = [];
      if (params.type) conditions.push(`Type = '${params.type.replace(/'/g, "\\'")}'`);
      if (params.industry) conditions.push(`Industry = '${params.industry.replace(/'/g, "\\'")}'`);
      if (params.owner_id) conditions.push(`OwnerId = '${params.owner_id}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT ${ACCOUNT_FIELDS} FROM Account ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Account ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_accounts", () => client.query<SalesforceAccount>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r.Id,
          name: r.Name,
          type: r.Type,
          industry: r.Industry,
          annualRevenue: r.AnnualRevenue,
          employees: r.NumberOfEmployees,
          phone: r.Phone,
          website: r.Website,
          city: r.BillingCity,
          state: r.BillingState,
          country: r.BillingCountry,
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

    get_account: async (args) => {
      const params = GetAccountSchema.parse(args);

      // Fetch account + optionally related contacts and opps in parallel
      const promises: Promise<unknown>[] = [
        client.get<SalesforceAccount>(`/sobjects/Account/${params.account_id}`),
      ];

      if (params.include_contacts) {
        promises.push(client.query(`SELECT Id,FirstName,LastName,Email,Phone,Title FROM Contact WHERE AccountId = '${params.account_id}' LIMIT 50`));
      }
      if (params.include_opportunities) {
        promises.push(client.query(`SELECT Id,Name,StageName,Amount,CloseDate FROM Opportunity WHERE AccountId = '${params.account_id}' LIMIT 50`));
      }

      const results = await Promise.all(promises);
      const account = results[0] as SalesforceAccount;

      const response: Record<string, unknown> = {
        id: account.Id,
        name: account.Name,
        type: account.Type,
        industry: account.Industry,
        annualRevenue: account.AnnualRevenue,
        numberOfEmployees: account.NumberOfEmployees,
        phone: account.Phone,
        website: account.Website,
        billingCity: account.BillingCity,
        billingState: account.BillingState,
        billingCountry: account.BillingCountry,
        ownerId: account.OwnerId,
        createdDate: account.CreatedDate,
        lastModifiedDate: account.LastModifiedDate,
      };

      let idx = 1;
      if (params.include_contacts) {
        const contactResult = results[idx++] as { records: unknown[] };
        response.contacts = contactResult.records;
      }
      if (params.include_opportunities) {
        const oppResult = results[idx++] as { records: unknown[] };
        response.opportunities = oppResult.records;
      }

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_account: async (args) => {
      const params = CreateAccountSchema.parse(args);
      const payload: Record<string, unknown> = { Name: params.name };
      if (params.type) payload.Type = params.type;
      if (params.industry) payload.Industry = params.industry;
      if (params.annual_revenue !== undefined) payload.AnnualRevenue = params.annual_revenue;
      if (params.number_of_employees !== undefined) payload.NumberOfEmployees = params.number_of_employees;
      if (params.phone) payload.Phone = params.phone;
      if (params.website) payload.Website = params.website;
      if (params.billing_city) payload.BillingCity = params.billing_city;
      if (params.billing_state) payload.BillingState = params.billing_state;
      if (params.billing_country) payload.BillingCountry = params.billing_country;

      const result = await logger.time("tool.create_account", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/Account", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
