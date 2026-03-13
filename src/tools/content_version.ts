// Content Version tool group — Salesforce ContentVersion (file version management)
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListContentVersionsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  content_document_id: z.string().optional().describe("Filter by ContentDocument ID"),
  title_filter: z.string().optional().describe("Filter by title"),
  file_type: z.string().optional().describe("Filter by file type (e.g. 'PDF', 'PNG')"),
  is_latest: z.boolean().optional().describe("Return only latest versions"),
  order_by: z.enum(["Title", "VersionNumber", "CreatedDate", "ContentSize"]).optional().default("CreatedDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

const GetContentVersionSchema = z.object({
  version_id: z.string().describe("ContentVersion ID"),
  include_text_preview: z.boolean().optional().default(false).describe("Include text preview of content"),
});

const UploadContentVersionSchema = z.object({
  title: z.string().describe("File title/name (required)"),
  path_on_client: z.string().describe("Original file path/name on client (e.g. 'report.pdf')"),
  version_data_base64: z.string().describe("Base64-encoded file content (required)"),
  content_document_id: z.string().optional().describe("Link to existing ContentDocument (to upload new version). Omit to create new document."),
  description: z.string().optional(),
  network_id: z.string().optional().describe("Community/Network ID (for community files)"),
  first_publish_location_id: z.string().optional().describe("Record ID to share this file with on upload"),
});

const UpdateContentVersionSchema = z.object({
  version_id: z.string().describe("ContentVersion ID to update"),
  title: z.string().optional(),
  description: z.string().optional(),
  reason_for_change: z.string().optional().describe("Version change description"),
});

const GetVersionDownloadUrlSchema = z.object({
  version_id: z.string().describe("ContentVersion ID"),
  link_expiry_hours: z.number().optional().default(24).describe("Hours until download link expires (default 24)"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_content_versions",
      title: "List Content Versions",
      description: "List Salesforce ContentVersions (file versions). Filter by ContentDocument ID to get all versions of a file, or filter globally by title, type, or latest-only.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          content_document_id: { type: "string", description: "Filter by ContentDocument ID" },
          title_filter: { type: "string", description: "Filter by title" },
          file_type: { type: "string", description: "Filter by file type" },
          is_latest: { type: "boolean", description: "Return only latest versions" },
          order_by: { type: "string", enum: ["Title", "VersionNumber", "CreatedDate", "ContentSize"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_content_version",
      title: "Get Content Version",
      description: "Get full metadata for a Salesforce ContentVersion by ID, including file size, type, checksum, and optionally a text preview.",
      inputSchema: {
        type: "object",
        properties: {
          version_id: { type: "string", description: "ContentVersion ID (required)" },
          include_text_preview: { type: "boolean", description: "Include text preview" },
        },
        required: ["version_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "upload_content_version",
      title: "Upload File (ContentVersion)",
      description: "Upload a new file or a new version of an existing file to Salesforce Files (ContentVersion). Provide base64-encoded content. To update an existing document, include its ContentDocumentId.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "File title (required)" },
          path_on_client: { type: "string", description: "Original filename with extension (e.g. 'report.pdf')" },
          version_data_base64: { type: "string", description: "Base64-encoded file content (required)" },
          content_document_id: { type: "string", description: "Existing ContentDocument ID (to add new version)" },
          description: { type: "string" },
          first_publish_location_id: { type: "string", description: "Record to share with on upload" },
        },
        required: ["title", "path_on_client", "version_data_base64"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_content_version",
      title: "Update Content Version",
      description: "Update metadata of a Salesforce ContentVersion (title, description, reason for change). Does not update file content — upload a new version for that.",
      inputSchema: {
        type: "object",
        properties: {
          version_id: { type: "string", description: "ContentVersion ID (required)" },
          title: { type: "string" },
          description: { type: "string" },
          reason_for_change: { type: "string" },
        },
        required: ["version_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_content_version_download_url",
      title: "Get Content Version Download URL",
      description: "Get the download URL for a Salesforce ContentVersion. Returns the full URL to download the file.",
      inputSchema: {
        type: "object",
        properties: {
          version_id: { type: "string", description: "ContentVersion ID (required)" },
          link_expiry_hours: { type: "number", description: "Hours until link expires (default 24)" },
        },
        required: ["version_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_content_versions: async (args) => {
      const params = ListContentVersionsSchema.parse(args);
      const conditions: string[] = [];
      if (params.content_document_id) conditions.push(`ContentDocumentId = '${params.content_document_id}'`);
      if (params.title_filter) conditions.push(`Title LIKE '%${params.title_filter.replace(/'/g, "\\'")}%'`);
      if (params.file_type) conditions.push(`FileType = '${params.file_type.toUpperCase()}'`);
      if (params.is_latest === true) conditions.push(`IsLatest = true`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,Title,ContentDocumentId,VersionNumber,FileType,ContentSize,IsLatest,IsMajorVersion,Description,CreatedDate,LastModifiedDate,Checksum FROM ContentVersion ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM ContentVersion ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_content_versions", () => client.query<Record<string, unknown>>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r["Id"],
          title: r["Title"],
          contentDocumentId: r["ContentDocumentId"],
          versionNumber: r["VersionNumber"],
          fileType: r["FileType"],
          contentSize: r["ContentSize"],
          isLatest: r["IsLatest"],
          isMajorVersion: r["IsMajorVersion"],
          description: r["Description"],
          checksum: r["Checksum"],
          createdDate: r["CreatedDate"],
          lastModifiedDate: r["LastModifiedDate"],
        })),
        meta: { total: countResult.totalSize, returned: result.records.length, hasMore: result.records.length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_content_version: async (args) => {
      const params = GetContentVersionSchema.parse(args);
      const result = await logger.time("tool.get_content_version", () =>
        client.get<Record<string, unknown>>(`/sobjects/ContentVersion/${params.version_id}`), {}
      );

      const response: Record<string, unknown> = {
        id: result["Id"],
        title: result["Title"],
        contentDocumentId: result["ContentDocumentId"],
        versionNumber: result["VersionNumber"],
        fileType: result["FileType"],
        fileExtension: result["FileExtension"],
        contentSize: result["ContentSize"],
        isLatest: result["IsLatest"],
        isMajorVersion: result["IsMajorVersion"],
        description: result["Description"],
        reasonForChange: result["ReasonForChange"],
        checksum: result["Checksum"],
        contentUrl: result["ContentUrl"],
        createdDate: result["CreatedDate"],
        lastModifiedDate: result["LastModifiedDate"],
      };

      if (params.include_text_preview) {
        response.textPreview = result["TextPreview"];
      }

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    upload_content_version: async (args) => {
      const params = UploadContentVersionSchema.parse(args);
      const payload: Record<string, unknown> = {
        Title: params.title,
        PathOnClient: params.path_on_client,
        VersionData: params.version_data_base64,
        IsMajorVersion: true,
      };
      if (params.content_document_id) payload["ContentDocumentId"] = params.content_document_id;
      if (params.description) payload["Description"] = params.description;
      if (params.first_publish_location_id) payload["FirstPublishLocationId"] = params.first_publish_location_id;

      const result = await logger.time("tool.upload_content_version", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/ContentVersion", payload), {}
      );

      const response = {
        success: result.success,
        versionId: result.id,
        title: params.title,
        errors: result.errors,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    update_content_version: async (args) => {
      const { version_id, ...updates } = UpdateContentVersionSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.title !== undefined) payload["Title"] = updates.title;
      if (updates.description !== undefined) payload["Description"] = updates.description;
      if (updates.reason_for_change !== undefined) payload["ReasonForChange"] = updates.reason_for_change;

      await logger.time("tool.update_content_version", () =>
        client.patch(`/sobjects/ContentVersion/${version_id}`, payload), {}
      );

      const response = { success: true, version_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_content_version_download_url: async (args) => {
      const { version_id } = GetVersionDownloadUrlSchema.parse(args);
      const result = await logger.time("tool.get_content_version_download_url", () =>
        client.get<Record<string, unknown>>(`/sobjects/ContentVersion/${version_id}?fields=Id,Title,FileType,ContentSize,ContentDocumentId`), {}
      );

      const response = {
        versionId: result["Id"],
        title: result["Title"],
        fileType: result["FileType"],
        contentSize: result["ContentSize"],
        contentDocumentId: result["ContentDocumentId"],
        downloadUrl: `/sobjects/ContentVersion/${version_id}/VersionData`,
        viewUrl: `/sobjects/ContentVersion/${version_id}`,
        instructions: "Use the Salesforce instance URL + downloadUrl with a valid Authorization header to download the file content.",
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
