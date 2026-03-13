// Contracts tool group — Salesforce Contract object CRUD + activate
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const CONTRACT_FIELDS =
  "Id,ContractNumber,AccountId,Status,StartDate,ContractTerm,EndDate,OwnerId,Description,BillingCity,BillingState,BillingCountry,CreatedDate,LastModifiedDate";

const ListContractsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  status: z.string().optional().describe("Filter by Status (e.g. 'Draft', 'InApproval', 'Activated')"),
  account_id: z.string().optional().describe("Filter by AccountId"),
  owner_id: z.string().optional().describe("Filter by OwnerId"),
  order_by: z.enum(["CreatedDate", "LastModifiedDate", "ContractNumber", "StartDate"]).optional().default("CreatedDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

const GetContractSchema = z.object({
  contract_id: z.string().describe("Salesforce Contract ID"),
});

const CreateContractSchema = z.object({
  account_id: z.string().describe("Account ID that this contract belongs to (required)"),
  start_date: z.string().describe("Contract start date (YYYY-MM-DD, required)"),
  contract_term: z.number().describe("Contract term in months (required)"),
  status: z.string().optional().default("Draft").describe("Status (default: 'Draft')"),
  description: z.string().optional(),
  owner_id: z.string().optional(),
  billing_city: z.string().optional(),
  billing_state: z.string().optional(),
  billing_country: z.string().optional(),
});

const UpdateContractSchema = z.object({
  contract_id: z.string().describe("Salesforce Contract ID to update"),
  start_date: z.string().optional(),
  contract_term: z.number().optional(),
  status: z.string().optional(),
  description: z.string().optional(),
  owner_id: z.string().optional(),
  billing_city: z.string().optional(),
  billing_state: z.string().optional(),
  billing_country: z.string().optional(),
});

const ActivateContractSchema = z.object({
  contract_id: z.string().describe("Salesforce Contract ID to activate"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_contracts",
      title: "List Contracts",
      description: "List Salesforce contracts with optional filters by status, account, or owner. Returns contract number, status, start date, and term. Use for contract pipeline reviews.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          status: { type: "string", description: "Status filter (e.g. 'Draft', 'InApproval', 'Activated')" },
          account_id: { type: "string", description: "Filter by Account ID" },
          owner_id: { type: "string", description: "Filter by Owner ID" },
          order_by: { type: "string", enum: ["CreatedDate", "LastModifiedDate", "ContractNumber", "StartDate"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_contract",
      title: "Get Contract",
      description: "Get full details for a Salesforce contract by ID including status, term, billing info, and description.",
      inputSchema: {
        type: "object",
        properties: { contract_id: { type: "string", description: "Salesforce Contract ID" } },
        required: ["contract_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_contract",
      title: "Create Contract",
      description: "Create a new Salesforce contract. Requires account_id, start_date, and contract_term (in months).",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "Account ID (required)" },
          start_date: { type: "string", description: "Start date YYYY-MM-DD (required)" },
          contract_term: { type: "number", description: "Term in months (required)" },
          status: { type: "string", description: "Status (default: Draft)" },
          description: { type: "string" },
          owner_id: { type: "string" },
          billing_city: { type: "string" },
          billing_state: { type: "string" },
          billing_country: { type: "string" },
        },
        required: ["account_id", "start_date", "contract_term"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_contract",
      title: "Update Contract",
      description: "Update an existing Salesforce contract. Only include fields to change. Note: Activated contracts have limited updatable fields.",
      inputSchema: {
        type: "object",
        properties: {
          contract_id: { type: "string", description: "Contract ID to update" },
          start_date: { type: "string" },
          contract_term: { type: "number" },
          status: { type: "string" },
          description: { type: "string" },
          owner_id: { type: "string" },
          billing_city: { type: "string" },
          billing_state: { type: "string" },
          billing_country: { type: "string" },
        },
        required: ["contract_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "activate_contract",
      title: "Activate Contract",
      description: "Activate a Salesforce contract by setting its status to 'Activated'. The contract must be in a valid state for activation.",
      inputSchema: {
        type: "object",
        properties: { contract_id: { type: "string", description: "Contract ID to activate" } },
        required: ["contract_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_contracts: async (args) => {
      const params = ListContractsSchema.parse(args);
      const conditions: string[] = [];
      if (params.status) conditions.push(`Status = '${params.status.replace(/'/g, "\\'")}'`);
      if (params.account_id) conditions.push(`AccountId = '${params.account_id}'`);
      if (params.owner_id) conditions.push(`OwnerId = '${params.owner_id}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT ${CONTRACT_FIELDS} FROM Contract ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Contract ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_contracts", () => client.query(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: (result.records as Record<string, unknown>[]).map((r) => ({
          id: r["Id"],
          contractNumber: r["ContractNumber"],
          accountId: r["AccountId"],
          status: r["Status"],
          startDate: r["StartDate"],
          contractTerm: r["ContractTerm"],
          endDate: r["EndDate"],
          ownerId: r["OwnerId"],
          createdDate: r["CreatedDate"],
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

    get_contract: async (args) => {
      const { contract_id } = GetContractSchema.parse(args);
      const result = await logger.time("tool.get_contract", () =>
        client.get<Record<string, unknown>>(`/sobjects/Contract/${contract_id}`), {}
      );

      const response = {
        id: result["Id"],
        contractNumber: result["ContractNumber"],
        accountId: result["AccountId"],
        status: result["Status"],
        startDate: result["StartDate"],
        contractTerm: result["ContractTerm"],
        endDate: result["EndDate"],
        ownerId: result["OwnerId"],
        description: result["Description"],
        billingCity: result["BillingCity"],
        billingState: result["BillingState"],
        billingCountry: result["BillingCountry"],
        createdDate: result["CreatedDate"],
        lastModifiedDate: result["LastModifiedDate"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_contract: async (args) => {
      const params = CreateContractSchema.parse(args);
      const payload: Record<string, unknown> = {
        AccountId: params.account_id,
        StartDate: params.start_date,
        ContractTerm: params.contract_term,
        Status: params.status || "Draft",
      };
      if (params.description) payload["Description"] = params.description;
      if (params.owner_id) payload["OwnerId"] = params.owner_id;
      if (params.billing_city) payload["BillingCity"] = params.billing_city;
      if (params.billing_state) payload["BillingState"] = params.billing_state;
      if (params.billing_country) payload["BillingCountry"] = params.billing_country;

      const result = await logger.time("tool.create_contract", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/Contract", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    update_contract: async (args) => {
      const { contract_id, ...updates } = UpdateContractSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.start_date !== undefined) payload["StartDate"] = updates.start_date;
      if (updates.contract_term !== undefined) payload["ContractTerm"] = updates.contract_term;
      if (updates.status !== undefined) payload["Status"] = updates.status;
      if (updates.description !== undefined) payload["Description"] = updates.description;
      if (updates.owner_id !== undefined) payload["OwnerId"] = updates.owner_id;
      if (updates.billing_city !== undefined) payload["BillingCity"] = updates.billing_city;
      if (updates.billing_state !== undefined) payload["BillingState"] = updates.billing_state;
      if (updates.billing_country !== undefined) payload["BillingCountry"] = updates.billing_country;

      await logger.time("tool.update_contract", () =>
        client.patch(`/sobjects/Contract/${contract_id}`, payload), {}
      );

      const response = { success: true, contract_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    activate_contract: async (args) => {
      const { contract_id } = ActivateContractSchema.parse(args);
      await logger.time("tool.activate_contract", () =>
        client.patch(`/sobjects/Contract/${contract_id}`, { Status: "Activated" }), {}
      );

      const response = { success: true, contract_id, status: "Activated" };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
