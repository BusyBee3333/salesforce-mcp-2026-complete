// Assets tool group — Salesforce Asset object CRUD
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ASSET_FIELDS =
  "Id,Name,AccountId,ContactId,Product2Id,SerialNumber,Status,Quantity,Price,PurchaseDate,UsageEndDate,Description,OwnerId,CreatedDate,LastModifiedDate";

const ListAssetsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  account_id: z.string().optional().describe("Filter by AccountId"),
  contact_id: z.string().optional().describe("Filter by ContactId"),
  product_id: z.string().optional().describe("Filter by Product2Id"),
  status: z.string().optional().describe("Filter by Status (e.g. 'Purchased', 'Shipped', 'Installed')"),
  order_by: z.enum(["CreatedDate", "LastModifiedDate", "Name", "PurchaseDate"]).optional().default("CreatedDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

const GetAssetSchema = z.object({
  asset_id: z.string().describe("Salesforce Asset ID"),
});

const CreateAssetSchema = z.object({
  name: z.string().describe("Asset name (required)"),
  account_id: z.string().optional().describe("Related Account ID"),
  contact_id: z.string().optional().describe("Related Contact ID"),
  product_id: z.string().optional().describe("Related Product2 ID"),
  serial_number: z.string().optional().describe("Asset serial number"),
  status: z.string().optional().default("Purchased").describe("Status (default: 'Purchased')"),
  quantity: z.number().optional().default(1).describe("Quantity (default: 1)"),
  price: z.number().optional().describe("Asset price"),
  purchase_date: z.string().optional().describe("Purchase date (YYYY-MM-DD)"),
  usage_end_date: z.string().optional().describe("End of service/warranty date (YYYY-MM-DD)"),
  description: z.string().optional(),
  owner_id: z.string().optional(),
});

const UpdateAssetSchema = z.object({
  asset_id: z.string().describe("Salesforce Asset ID to update"),
  name: z.string().optional(),
  account_id: z.string().optional(),
  contact_id: z.string().optional(),
  product_id: z.string().optional(),
  serial_number: z.string().optional(),
  status: z.string().optional(),
  quantity: z.number().optional(),
  price: z.number().optional(),
  purchase_date: z.string().optional(),
  usage_end_date: z.string().optional(),
  description: z.string().optional(),
  owner_id: z.string().optional(),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_assets",
      title: "List Assets",
      description: "List Salesforce assets with optional filters by account, contact, product, or status. Useful for tracking installed products, warranties, and renewals.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          account_id: { type: "string", description: "Filter by Account ID" },
          contact_id: { type: "string", description: "Filter by Contact ID" },
          product_id: { type: "string", description: "Filter by Product2 ID" },
          status: { type: "string", description: "Status filter (e.g. 'Purchased', 'Installed', 'Obsolete')" },
          order_by: { type: "string", enum: ["CreatedDate", "LastModifiedDate", "Name", "PurchaseDate"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_asset",
      title: "Get Asset",
      description: "Get full details for a Salesforce asset by ID including serial number, status, quantity, price, and dates.",
      inputSchema: {
        type: "object",
        properties: { asset_id: { type: "string", description: "Salesforce Asset ID" } },
        required: ["asset_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_asset",
      title: "Create Asset",
      description: "Create a new Salesforce asset to track a product owned by an account or contact.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Asset name (required)" },
          account_id: { type: "string" },
          contact_id: { type: "string" },
          product_id: { type: "string", description: "Product2 ID" },
          serial_number: { type: "string" },
          status: { type: "string", description: "Status (default: Purchased)" },
          quantity: { type: "number", description: "Quantity (default: 1)" },
          price: { type: "number" },
          purchase_date: { type: "string", description: "YYYY-MM-DD" },
          usage_end_date: { type: "string", description: "YYYY-MM-DD" },
          description: { type: "string" },
          owner_id: { type: "string" },
        },
        required: ["name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_asset",
      title: "Update Asset",
      description: "Update an existing Salesforce asset. Only include fields to change.",
      inputSchema: {
        type: "object",
        properties: {
          asset_id: { type: "string", description: "Asset ID to update" },
          name: { type: "string" },
          account_id: { type: "string" },
          contact_id: { type: "string" },
          product_id: { type: "string" },
          serial_number: { type: "string" },
          status: { type: "string" },
          quantity: { type: "number" },
          price: { type: "number" },
          purchase_date: { type: "string" },
          usage_end_date: { type: "string" },
          description: { type: "string" },
          owner_id: { type: "string" },
        },
        required: ["asset_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_assets: async (args) => {
      const params = ListAssetsSchema.parse(args);
      const conditions: string[] = [];
      if (params.account_id) conditions.push(`AccountId = '${params.account_id}'`);
      if (params.contact_id) conditions.push(`ContactId = '${params.contact_id}'`);
      if (params.product_id) conditions.push(`Product2Id = '${params.product_id}'`);
      if (params.status) conditions.push(`Status = '${params.status.replace(/'/g, "\\'")}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT ${ASSET_FIELDS} FROM Asset ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Asset ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_assets", () => client.query(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: (result.records as Record<string, unknown>[]).map((r) => ({
          id: r["Id"],
          name: r["Name"],
          accountId: r["AccountId"],
          contactId: r["ContactId"],
          product2Id: r["Product2Id"],
          serialNumber: r["SerialNumber"],
          status: r["Status"],
          quantity: r["Quantity"],
          price: r["Price"],
          purchaseDate: r["PurchaseDate"],
          usageEndDate: r["UsageEndDate"],
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

    get_asset: async (args) => {
      const { asset_id } = GetAssetSchema.parse(args);
      const result = await logger.time("tool.get_asset", () =>
        client.get<Record<string, unknown>>(`/sobjects/Asset/${asset_id}`), {}
      );

      const response = {
        id: result["Id"],
        name: result["Name"],
        accountId: result["AccountId"],
        contactId: result["ContactId"],
        product2Id: result["Product2Id"],
        serialNumber: result["SerialNumber"],
        status: result["Status"],
        quantity: result["Quantity"],
        price: result["Price"],
        purchaseDate: result["PurchaseDate"],
        usageEndDate: result["UsageEndDate"],
        description: result["Description"],
        ownerId: result["OwnerId"],
        createdDate: result["CreatedDate"],
        lastModifiedDate: result["LastModifiedDate"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_asset: async (args) => {
      const params = CreateAssetSchema.parse(args);
      const payload: Record<string, unknown> = {
        Name: params.name,
        Status: params.status || "Purchased",
        Quantity: params.quantity !== undefined ? params.quantity : 1,
      };
      if (params.account_id) payload["AccountId"] = params.account_id;
      if (params.contact_id) payload["ContactId"] = params.contact_id;
      if (params.product_id) payload["Product2Id"] = params.product_id;
      if (params.serial_number) payload["SerialNumber"] = params.serial_number;
      if (params.price !== undefined) payload["Price"] = params.price;
      if (params.purchase_date) payload["PurchaseDate"] = params.purchase_date;
      if (params.usage_end_date) payload["UsageEndDate"] = params.usage_end_date;
      if (params.description) payload["Description"] = params.description;
      if (params.owner_id) payload["OwnerId"] = params.owner_id;

      const result = await logger.time("tool.create_asset", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/Asset", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    update_asset: async (args) => {
      const { asset_id, ...updates } = UpdateAssetSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.name !== undefined) payload["Name"] = updates.name;
      if (updates.account_id !== undefined) payload["AccountId"] = updates.account_id;
      if (updates.contact_id !== undefined) payload["ContactId"] = updates.contact_id;
      if (updates.product_id !== undefined) payload["Product2Id"] = updates.product_id;
      if (updates.serial_number !== undefined) payload["SerialNumber"] = updates.serial_number;
      if (updates.status !== undefined) payload["Status"] = updates.status;
      if (updates.quantity !== undefined) payload["Quantity"] = updates.quantity;
      if (updates.price !== undefined) payload["Price"] = updates.price;
      if (updates.purchase_date !== undefined) payload["PurchaseDate"] = updates.purchase_date;
      if (updates.usage_end_date !== undefined) payload["UsageEndDate"] = updates.usage_end_date;
      if (updates.description !== undefined) payload["Description"] = updates.description;
      if (updates.owner_id !== undefined) payload["OwnerId"] = updates.owner_id;

      await logger.time("tool.update_asset", () =>
        client.patch(`/sobjects/Asset/${asset_id}`, payload), {}
      );

      const response = { success: true, asset_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
