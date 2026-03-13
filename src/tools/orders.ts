// Orders tool group — Salesforce Order object CRUD + activate
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ORDER_FIELDS =
  "Id,OrderNumber,AccountId,ContractId,Status,EffectiveDate,EndDate,TotalAmount,OwnerId,Description,BillingCity,BillingState,BillingCountry,Type,CreatedDate,LastModifiedDate";

const ListOrdersSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  status: z.string().optional().describe("Filter by Status (e.g. 'Draft', 'Activated')"),
  account_id: z.string().optional().describe("Filter by AccountId"),
  contract_id: z.string().optional().describe("Filter by ContractId"),
  owner_id: z.string().optional().describe("Filter by OwnerId"),
  order_by: z.enum(["CreatedDate", "LastModifiedDate", "OrderNumber", "EffectiveDate", "TotalAmount"]).optional().default("CreatedDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

const GetOrderSchema = z.object({
  order_id: z.string().describe("Salesforce Order ID"),
});

const CreateOrderSchema = z.object({
  account_id: z.string().describe("Account ID (required)"),
  effective_date: z.string().describe("Order effective date (YYYY-MM-DD, required)"),
  status: z.string().optional().default("Draft").describe("Order status (default: 'Draft')"),
  contract_id: z.string().optional().describe("Related Contract ID"),
  price_book_2_id: z.string().optional().describe("Pricebook2 ID to use for the order"),
  description: z.string().optional(),
  type: z.string().optional().describe("Order type (e.g. 'New', 'Renewal', 'Replacement')"),
  owner_id: z.string().optional(),
  billing_city: z.string().optional(),
  billing_state: z.string().optional(),
  billing_country: z.string().optional(),
});

const UpdateOrderSchema = z.object({
  order_id: z.string().describe("Salesforce Order ID to update"),
  effective_date: z.string().optional(),
  status: z.string().optional(),
  description: z.string().optional(),
  type: z.string().optional(),
  owner_id: z.string().optional(),
  billing_city: z.string().optional(),
  billing_state: z.string().optional(),
  billing_country: z.string().optional(),
});

const ActivateOrderSchema = z.object({
  order_id: z.string().describe("Salesforce Order ID to activate"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_orders",
      title: "List Orders",
      description: "List Salesforce orders with optional filters by status, account, contract, or owner. Returns order number, status, effective date, and total amount.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          status: { type: "string", description: "Status filter (e.g. 'Draft', 'Activated')" },
          account_id: { type: "string", description: "Filter by Account ID" },
          contract_id: { type: "string", description: "Filter by Contract ID" },
          owner_id: { type: "string", description: "Filter by Owner ID" },
          order_by: { type: "string", enum: ["CreatedDate", "LastModifiedDate", "OrderNumber", "EffectiveDate", "TotalAmount"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_order",
      title: "Get Order",
      description: "Get full details for a Salesforce order by ID including status, dates, total amount, billing info.",
      inputSchema: {
        type: "object",
        properties: { order_id: { type: "string", description: "Salesforce Order ID" } },
        required: ["order_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_order",
      title: "Create Order",
      description: "Create a new Salesforce order. Requires account_id and effective_date.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string", description: "Account ID (required)" },
          effective_date: { type: "string", description: "Effective date YYYY-MM-DD (required)" },
          status: { type: "string", description: "Status (default: Draft)" },
          contract_id: { type: "string", description: "Related Contract ID" },
          price_book_2_id: { type: "string", description: "Pricebook2 ID" },
          description: { type: "string" },
          type: { type: "string" },
          owner_id: { type: "string" },
          billing_city: { type: "string" },
          billing_state: { type: "string" },
          billing_country: { type: "string" },
        },
        required: ["account_id", "effective_date"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_order",
      title: "Update Order",
      description: "Update an existing Salesforce order. Only include fields to change. Activated orders have limited updatable fields.",
      inputSchema: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "Order ID to update" },
          effective_date: { type: "string" },
          status: { type: "string" },
          description: { type: "string" },
          type: { type: "string" },
          owner_id: { type: "string" },
          billing_city: { type: "string" },
          billing_state: { type: "string" },
          billing_country: { type: "string" },
        },
        required: ["order_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "activate_order",
      title: "Activate Order",
      description: "Activate a Salesforce order by setting its status to 'Activated'. The order must be in Draft status with valid order products.",
      inputSchema: {
        type: "object",
        properties: { order_id: { type: "string", description: "Order ID to activate" } },
        required: ["order_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_orders: async (args) => {
      const params = ListOrdersSchema.parse(args);
      const conditions: string[] = [];
      if (params.status) conditions.push(`Status = '${params.status.replace(/'/g, "\\'")}'`);
      if (params.account_id) conditions.push(`AccountId = '${params.account_id}'`);
      if (params.contract_id) conditions.push(`ContractId = '${params.contract_id}'`);
      if (params.owner_id) conditions.push(`OwnerId = '${params.owner_id}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT ${ORDER_FIELDS} FROM Order ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Order ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_orders", () => client.query(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: (result.records as Record<string, unknown>[]).map((r) => ({
          id: r["Id"],
          orderNumber: r["OrderNumber"],
          accountId: r["AccountId"],
          contractId: r["ContractId"],
          status: r["Status"],
          effectiveDate: r["EffectiveDate"],
          endDate: r["EndDate"],
          totalAmount: r["TotalAmount"],
          type: r["Type"],
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

    get_order: async (args) => {
      const { order_id } = GetOrderSchema.parse(args);
      const result = await logger.time("tool.get_order", () =>
        client.get<Record<string, unknown>>(`/sobjects/Order/${order_id}`), {}
      );

      const response = {
        id: result["Id"],
        orderNumber: result["OrderNumber"],
        accountId: result["AccountId"],
        contractId: result["ContractId"],
        status: result["Status"],
        effectiveDate: result["EffectiveDate"],
        endDate: result["EndDate"],
        totalAmount: result["TotalAmount"],
        type: result["Type"],
        description: result["Description"],
        ownerId: result["OwnerId"],
        billingCity: result["BillingCity"],
        billingState: result["BillingState"],
        billingCountry: result["BillingCountry"],
        createdDate: result["CreatedDate"],
        lastModifiedDate: result["LastModifiedDate"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_order: async (args) => {
      const params = CreateOrderSchema.parse(args);
      const payload: Record<string, unknown> = {
        AccountId: params.account_id,
        EffectiveDate: params.effective_date,
        Status: params.status || "Draft",
      };
      if (params.contract_id) payload["ContractId"] = params.contract_id;
      if (params.price_book_2_id) payload["Pricebook2Id"] = params.price_book_2_id;
      if (params.description) payload["Description"] = params.description;
      if (params.type) payload["Type"] = params.type;
      if (params.owner_id) payload["OwnerId"] = params.owner_id;
      if (params.billing_city) payload["BillingCity"] = params.billing_city;
      if (params.billing_state) payload["BillingState"] = params.billing_state;
      if (params.billing_country) payload["BillingCountry"] = params.billing_country;

      const result = await logger.time("tool.create_order", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/Order", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    update_order: async (args) => {
      const { order_id, ...updates } = UpdateOrderSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.effective_date !== undefined) payload["EffectiveDate"] = updates.effective_date;
      if (updates.status !== undefined) payload["Status"] = updates.status;
      if (updates.description !== undefined) payload["Description"] = updates.description;
      if (updates.type !== undefined) payload["Type"] = updates.type;
      if (updates.owner_id !== undefined) payload["OwnerId"] = updates.owner_id;
      if (updates.billing_city !== undefined) payload["BillingCity"] = updates.billing_city;
      if (updates.billing_state !== undefined) payload["BillingState"] = updates.billing_state;
      if (updates.billing_country !== undefined) payload["BillingCountry"] = updates.billing_country;

      await logger.time("tool.update_order", () =>
        client.patch(`/sobjects/Order/${order_id}`, payload), {}
      );

      const response = { success: true, order_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    activate_order: async (args) => {
      const { order_id } = ActivateOrderSchema.parse(args);
      await logger.time("tool.activate_order", () =>
        client.patch(`/sobjects/Order/${order_id}`, { Status: "Activated" }), {}
      );

      const response = { success: true, order_id, status: "Activated" };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
