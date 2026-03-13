// Email Template tool group — Salesforce EmailTemplate CRUD
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListEmailTemplatesSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  name_filter: z.string().optional().describe("Filter by template name"),
  template_type: z.enum(["text", "html", "custom", "visualforce"]).optional().describe("Filter by template type"),
  folder_name: z.string().optional().describe("Filter by folder name"),
  is_active: z.boolean().optional().describe("Filter by active status"),
  order_by: z.enum(["Name", "CreatedDate", "LastModifiedDate"]).optional().default("Name"),
});

const GetEmailTemplateSchema = z.object({
  template_id: z.string().describe("EmailTemplate ID"),
});

const CreateEmailTemplateSchema = z.object({
  name: z.string().describe("Template name (required)"),
  developer_name: z.string().describe("API/developer name (required, no spaces)"),
  folder_id: z.string().describe("Folder ID to store the template in (required)"),
  template_type: z.enum(["text", "html", "custom"]).optional().default("text"),
  subject: z.string().describe("Email subject line (required, supports merge fields like {!Contact.Name})"),
  body: z.string().describe("Template body (required, use {!Object.Field} for merge fields)"),
  html_value: z.string().optional().describe("HTML version of the body (for html/custom types)"),
  description: z.string().optional(),
  encoding: z.string().optional().default("UTF-8"),
  is_active: z.boolean().optional().default(true),
});

const UpdateEmailTemplateSchema = z.object({
  template_id: z.string().describe("EmailTemplate ID to update"),
  name: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  html_value: z.string().optional(),
  description: z.string().optional(),
  is_active: z.boolean().optional(),
});

const DeleteEmailTemplateSchema = z.object({
  template_id: z.string().describe("EmailTemplate ID to delete"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_email_templates",
      title: "List Email Templates",
      description: "List Salesforce Email Templates. Filter by name, type, folder, or active status. Returns template names, subjects, types, and folder names.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          name_filter: { type: "string", description: "Filter by name" },
          template_type: { type: "string", enum: ["text", "html", "custom", "visualforce"] },
          folder_name: { type: "string", description: "Filter by folder name" },
          is_active: { type: "boolean" },
          order_by: { type: "string", enum: ["Name", "CreatedDate", "LastModifiedDate"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_email_template",
      title: "Get Email Template",
      description: "Get full details and body content of a Salesforce Email Template by ID.",
      inputSchema: {
        type: "object",
        properties: {
          template_id: { type: "string", description: "EmailTemplate ID (required)" },
        },
        required: ["template_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_email_template",
      title: "Create Email Template",
      description: "Create a new Salesforce Email Template with merge field support. Templates can be text, HTML, or custom. Body supports {!Object.Field} merge syntax.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Template name (required)" },
          developer_name: { type: "string", description: "API name (required, no spaces)" },
          folder_id: { type: "string", description: "Folder ID (required)" },
          template_type: { type: "string", enum: ["text", "html", "custom"] },
          subject: { type: "string", description: "Subject line (supports merge fields)" },
          body: { type: "string", description: "Template body" },
          html_value: { type: "string", description: "HTML body (for html/custom types)" },
          description: { type: "string" },
          encoding: { type: "string" },
          is_active: { type: "boolean" },
        },
        required: ["name", "developer_name", "folder_id", "subject", "body"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_email_template",
      title: "Update Email Template",
      description: "Update an existing Salesforce Email Template.",
      inputSchema: {
        type: "object",
        properties: {
          template_id: { type: "string", description: "EmailTemplate ID (required)" },
          name: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          html_value: { type: "string" },
          description: { type: "string" },
          is_active: { type: "boolean" },
        },
        required: ["template_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "delete_email_template",
      title: "Delete Email Template",
      description: "Delete a Salesforce Email Template permanently.",
      inputSchema: {
        type: "object",
        properties: {
          template_id: { type: "string", description: "EmailTemplate ID to delete" },
        },
        required: ["template_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_email_templates: async (args) => {
      const params = ListEmailTemplatesSchema.parse(args);
      const conditions: string[] = [];
      if (params.name_filter) conditions.push(`Name LIKE '%${params.name_filter.replace(/'/g, "\\'")}%'`);
      if (params.template_type) conditions.push(`TemplateType = '${params.template_type}'`);
      if (params.is_active !== undefined) conditions.push(`IsActive = ${params.is_active}`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,Name,DeveloperName,Subject,TemplateType,IsActive,FolderId,Folder.Name,Description,CreatedDate,LastModifiedDate FROM EmailTemplate ${where} ORDER BY ${params.order_by} ASC LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM EmailTemplate ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_email_templates", () => client.query<Record<string, unknown>>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => {
          const folder = r["Folder"] as Record<string, unknown> | undefined;
          return {
            id: r["Id"],
            name: r["Name"],
            developerName: r["DeveloperName"],
            subject: r["Subject"],
            templateType: r["TemplateType"],
            isActive: r["IsActive"],
            folderId: r["FolderId"],
            folderName: folder?.["Name"],
            description: r["Description"],
            createdDate: r["CreatedDate"],
            lastModifiedDate: r["LastModifiedDate"],
          };
        }),
        meta: { total: countResult.totalSize, returned: result.records.length, hasMore: result.records.length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_email_template: async (args) => {
      const { template_id } = GetEmailTemplateSchema.parse(args);
      const result = await logger.time("tool.get_email_template", () =>
        client.get<Record<string, unknown>>(`/sobjects/EmailTemplate/${template_id}`), {}
      );

      const response = {
        id: result["Id"],
        name: result["Name"],
        developerName: result["DeveloperName"],
        subject: result["Subject"],
        body: result["Body"],
        htmlValue: result["HtmlValue"],
        templateType: result["TemplateType"],
        isActive: result["IsActive"],
        folderId: result["FolderId"],
        description: result["Description"],
        encoding: result["Encoding"],
        createdDate: result["CreatedDate"],
        lastModifiedDate: result["LastModifiedDate"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_email_template: async (args) => {
      const params = CreateEmailTemplateSchema.parse(args);
      const payload: Record<string, unknown> = {
        Name: params.name,
        DeveloperName: params.developer_name,
        FolderId: params.folder_id,
        TemplateType: params.template_type,
        Subject: params.subject,
        Body: params.body,
        IsActive: params.is_active,
        Encoding: params.encoding,
      };
      if (params.html_value) payload["HtmlValue"] = params.html_value;
      if (params.description) payload["Description"] = params.description;

      const result = await logger.time("tool.create_email_template", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/EmailTemplate", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    update_email_template: async (args) => {
      const { template_id, ...updates } = UpdateEmailTemplateSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.name !== undefined) payload["Name"] = updates.name;
      if (updates.subject !== undefined) payload["Subject"] = updates.subject;
      if (updates.body !== undefined) payload["Body"] = updates.body;
      if (updates.html_value !== undefined) payload["HtmlValue"] = updates.html_value;
      if (updates.description !== undefined) payload["Description"] = updates.description;
      if (updates.is_active !== undefined) payload["IsActive"] = updates.is_active;

      await logger.time("tool.update_email_template", () =>
        client.patch(`/sobjects/EmailTemplate/${template_id}`, payload), {}
      );

      const response = { success: true, template_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    delete_email_template: async (args) => {
      const { template_id } = DeleteEmailTemplateSchema.parse(args);
      await logger.time("tool.delete_email_template", () =>
        client.delete(`/sobjects/EmailTemplate/${template_id}`), {}
      );
      const response = { success: true, template_id, deleted: true };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
