// Products tool group — Product2, Pricebook2, PricebookEntry CRUD
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const PRODUCT_FIELDS = "Id,Name,ProductCode,Description,IsActive,Family,CreatedDate,LastModifiedDate";
const PRICEBOOK_FIELDS = "Id,Name,Description,IsActive,IsStandard,CreatedDate,LastModifiedDate";
const PBE_FIELDS = "Id,Pricebook2Id,Product2Id,CurrencyIsoCode,UnitPrice,IsActive,UseStandardPrice,CreatedDate";

const ListProductsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  is_active: z.boolean().optional().describe("Filter by IsActive flag"),
  family: z.string().optional().describe("Filter by product Family"),
  name_search: z.string().optional().describe("Filter by name (LIKE match)"),
  order_by: z.enum(["CreatedDate", "LastModifiedDate", "Name", "ProductCode"]).optional().default("Name"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("ASC"),
});

const GetProductSchema = z.object({
  product_id: z.string().describe("Salesforce Product2 ID"),
});

const CreateProductSchema = z.object({
  name: z.string().describe("Product name (required)"),
  product_code: z.string().optional().describe("Product SKU/code"),
  description: z.string().optional(),
  is_active: z.boolean().optional().default(true),
  family: z.string().optional().describe("Product family / category"),
});

const UpdateProductSchema = z.object({
  product_id: z.string().describe("Product2 ID to update"),
  name: z.string().optional(),
  product_code: z.string().optional(),
  description: z.string().optional(),
  is_active: z.boolean().optional(),
  family: z.string().optional(),
});

const ListPriceBooksSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  is_active: z.boolean().optional().describe("Filter by IsActive flag"),
  order_by: z.enum(["CreatedDate", "LastModifiedDate", "Name"]).optional().default("Name"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("ASC"),
});

const GetPriceBookSchema = z.object({
  price_book_id: z.string().describe("Salesforce Pricebook2 ID"),
});

const ListPriceBookEntriesSchema = z.object({
  price_book_id: z.string().describe("Pricebook2 ID to list entries for (required)"),
  product_id: z.string().optional().describe("Optionally filter by Product2 ID"),
  currency_iso_code: z.string().optional().describe("Filter by currency (e.g. 'USD', 'EUR')"),
  is_active: z.boolean().optional().describe("Filter by IsActive flag"),
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
});

const CreatePriceBookEntrySchema = z.object({
  price_book_id: z.string().describe("Pricebook2 ID (required)"),
  product_id: z.string().describe("Product2 ID (required)"),
  unit_price: z.number().describe("Unit price (required)"),
  currency_iso_code: z.string().optional().default("USD").describe("Currency ISO code (default: USD)"),
  is_active: z.boolean().optional().default(true),
  use_standard_price: z.boolean().optional().default(false).describe("If true, use the standard price book price"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_products",
      title: "List Products",
      description: "List Salesforce products (Product2 objects) with optional filters by active status, family, or name. Returns product name, code, family, and active status.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          is_active: { type: "boolean", description: "Filter by active status" },
          family: { type: "string", description: "Filter by product family" },
          name_search: { type: "string", description: "Name LIKE filter" },
          order_by: { type: "string", enum: ["CreatedDate", "LastModifiedDate", "Name", "ProductCode"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_product",
      title: "Get Product",
      description: "Get full details for a Salesforce product (Product2) by ID including name, code, description, family, and active status.",
      inputSchema: {
        type: "object",
        properties: { product_id: { type: "string", description: "Product2 ID" } },
        required: ["product_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_product",
      title: "Create Product",
      description: "Create a new Salesforce product (Product2). Only Name is required.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Product name (required)" },
          product_code: { type: "string", description: "SKU or product code" },
          description: { type: "string" },
          is_active: { type: "boolean", description: "Active (default: true)" },
          family: { type: "string", description: "Product family/category" },
        },
        required: ["name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_product",
      title: "Update Product",
      description: "Update an existing Salesforce product (Product2). Only include fields to change.",
      inputSchema: {
        type: "object",
        properties: {
          product_id: { type: "string", description: "Product2 ID to update" },
          name: { type: "string" },
          product_code: { type: "string" },
          description: { type: "string" },
          is_active: { type: "boolean" },
          family: { type: "string" },
        },
        required: ["product_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "list_price_books",
      title: "List Price Books",
      description: "List Salesforce price books (Pricebook2 objects). Returns name, active status, and whether it is the standard price book.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          is_active: { type: "boolean", description: "Filter by active status" },
          order_by: { type: "string", enum: ["CreatedDate", "LastModifiedDate", "Name"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_price_book",
      title: "Get Price Book",
      description: "Get full details for a Salesforce price book (Pricebook2) by ID.",
      inputSchema: {
        type: "object",
        properties: { price_book_id: { type: "string", description: "Pricebook2 ID" } },
        required: ["price_book_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "list_price_book_entries",
      title: "List Price Book Entries",
      description: "List entries (products + prices) in a specific Salesforce price book. Optionally filter by product or currency.",
      inputSchema: {
        type: "object",
        properties: {
          price_book_id: { type: "string", description: "Pricebook2 ID (required)" },
          product_id: { type: "string", description: "Filter by Product2 ID" },
          currency_iso_code: { type: "string", description: "Filter by currency (e.g. 'USD')" },
          is_active: { type: "boolean", description: "Filter by active status" },
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
        },
        required: ["price_book_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_price_book_entry",
      title: "Create Price Book Entry",
      description: "Add a product to a price book with a specific price. Requires price_book_id, product_id, and unit_price.",
      inputSchema: {
        type: "object",
        properties: {
          price_book_id: { type: "string", description: "Pricebook2 ID (required)" },
          product_id: { type: "string", description: "Product2 ID (required)" },
          unit_price: { type: "number", description: "Unit price (required)" },
          currency_iso_code: { type: "string", description: "Currency ISO code (default: USD)" },
          is_active: { type: "boolean", description: "Active (default: true)" },
          use_standard_price: { type: "boolean", description: "Use standard price book price" },
        },
        required: ["price_book_id", "product_id", "unit_price"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_products: async (args) => {
      const params = ListProductsSchema.parse(args);
      const conditions: string[] = [];
      if (params.is_active !== undefined) conditions.push(`IsActive = ${params.is_active}`);
      if (params.family) conditions.push(`Family = '${params.family.replace(/'/g, "\\'")}'`);
      if (params.name_search) conditions.push(`Name LIKE '%${params.name_search.replace(/'/g, "\\'")}%'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT ${PRODUCT_FIELDS} FROM Product2 ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Product2 ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_products", () => client.query(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: (result.records as Record<string, unknown>[]).map((r) => ({
          id: r["Id"],
          name: r["Name"],
          productCode: r["ProductCode"],
          description: r["Description"],
          isActive: r["IsActive"],
          family: r["Family"],
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

    get_product: async (args) => {
      const { product_id } = GetProductSchema.parse(args);
      const result = await logger.time("tool.get_product", () =>
        client.get<Record<string, unknown>>(`/sobjects/Product2/${product_id}`), {}
      );

      const response = {
        id: result["Id"],
        name: result["Name"],
        productCode: result["ProductCode"],
        description: result["Description"],
        isActive: result["IsActive"],
        family: result["Family"],
        createdDate: result["CreatedDate"],
        lastModifiedDate: result["LastModifiedDate"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_product: async (args) => {
      const params = CreateProductSchema.parse(args);
      const payload: Record<string, unknown> = {
        Name: params.name,
        IsActive: params.is_active !== undefined ? params.is_active : true,
      };
      if (params.product_code) payload["ProductCode"] = params.product_code;
      if (params.description) payload["Description"] = params.description;
      if (params.family) payload["Family"] = params.family;

      const result = await logger.time("tool.create_product", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/Product2", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    update_product: async (args) => {
      const { product_id, ...updates } = UpdateProductSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.name !== undefined) payload["Name"] = updates.name;
      if (updates.product_code !== undefined) payload["ProductCode"] = updates.product_code;
      if (updates.description !== undefined) payload["Description"] = updates.description;
      if (updates.is_active !== undefined) payload["IsActive"] = updates.is_active;
      if (updates.family !== undefined) payload["Family"] = updates.family;

      await logger.time("tool.update_product", () =>
        client.patch(`/sobjects/Product2/${product_id}`, payload), {}
      );

      const response = { success: true, product_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    list_price_books: async (args) => {
      const params = ListPriceBooksSchema.parse(args);
      const conditions: string[] = [];
      if (params.is_active !== undefined) conditions.push(`IsActive = ${params.is_active}`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT ${PRICEBOOK_FIELDS} FROM Pricebook2 ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Pricebook2 ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_price_books", () => client.query(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: (result.records as Record<string, unknown>[]).map((r) => ({
          id: r["Id"],
          name: r["Name"],
          description: r["Description"],
          isActive: r["IsActive"],
          isStandard: r["IsStandard"],
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

    get_price_book: async (args) => {
      const { price_book_id } = GetPriceBookSchema.parse(args);
      const result = await logger.time("tool.get_price_book", () =>
        client.get<Record<string, unknown>>(`/sobjects/Pricebook2/${price_book_id}`), {}
      );

      const response = {
        id: result["Id"],
        name: result["Name"],
        description: result["Description"],
        isActive: result["IsActive"],
        isStandard: result["IsStandard"],
        createdDate: result["CreatedDate"],
        lastModifiedDate: result["LastModifiedDate"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    list_price_book_entries: async (args) => {
      const params = ListPriceBookEntriesSchema.parse(args);
      const conditions: string[] = [`Pricebook2Id = '${params.price_book_id}'`];
      if (params.product_id) conditions.push(`Product2Id = '${params.product_id}'`);
      if (params.currency_iso_code) conditions.push(`CurrencyIsoCode = '${params.currency_iso_code}'`);
      if (params.is_active !== undefined) conditions.push(`IsActive = ${params.is_active}`);
      const where = `WHERE ${conditions.join(" AND ")}`;
      const soql = `SELECT ${PBE_FIELDS} FROM PricebookEntry ${where} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM PricebookEntry ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_price_book_entries", () => client.query(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: (result.records as Record<string, unknown>[]).map((r) => ({
          id: r["Id"],
          pricebook2Id: r["Pricebook2Id"],
          product2Id: r["Product2Id"],
          currencyIsoCode: r["CurrencyIsoCode"],
          unitPrice: r["UnitPrice"],
          isActive: r["IsActive"],
          useStandardPrice: r["UseStandardPrice"],
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

    create_price_book_entry: async (args) => {
      const params = CreatePriceBookEntrySchema.parse(args);
      const payload: Record<string, unknown> = {
        Pricebook2Id: params.price_book_id,
        Product2Id: params.product_id,
        UnitPrice: params.unit_price,
        CurrencyIsoCode: params.currency_iso_code || "USD",
        IsActive: params.is_active !== undefined ? params.is_active : true,
        UseStandardPrice: params.use_standard_price !== undefined ? params.use_standard_price : false,
      };

      const result = await logger.time("tool.create_price_book_entry", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/PricebookEntry", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
