// ContentDocument tool group — Salesforce Files (ContentDocument, ContentDocumentLink)
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListContentDocumentsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  title_filter: z.string().optional().describe("Filter by title (case-insensitive substring)"),
  file_type: z.string().optional().describe("Filter by file extension/type (e.g. 'PDF', 'EXCEL')"),
  owner_id: z.string().optional().describe("Filter by OwnerId"),
  order_by: z.enum(["Title", "CreatedDate", "LastModifiedDate", "ContentSize"]).optional().default("LastModifiedDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

const GetContentDocumentSchema = z.object({
  document_id: z.string().describe("ContentDocument ID (15 or 18 char Salesforce ID)"),
  include_versions: z.boolean().optional().default(false).describe("Include ContentVersions linked to this document"),
  include_links: z.boolean().optional().default(false).describe("Include ContentDocumentLinks (records this file is shared with)"),
});

const DeleteContentDocumentSchema = z.object({
  document_id: z.string().describe("ContentDocument ID to permanently delete"),
});

const ListLinkedFilesSchema = z.object({
  record_id: z.string().describe("Salesforce record ID to retrieve linked files for"),
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
});

const LinkFileSchema = z.object({
  content_document_id: z.string().describe("ContentDocument ID to link"),
  linked_entity_id: z.string().describe("Salesforce record ID to link the file to"),
  share_type: z.enum(["V", "C", "I"]).optional().default("V").describe("V=Viewer, C=Collaborator, I=Inferred from parent"),
  visibility: z.enum(["AllUsers", "InternalUsers"]).optional().default("AllUsers"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_content_documents",
      title: "List Content Documents",
      description: "List Salesforce Files (ContentDocument records) in the org. Supports filtering by title, file type, and owner. Returns file metadata including title, size, type, and owner.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          title_filter: { type: "string", description: "Filter by title substring" },
          file_type: { type: "string", description: "Filter by file type (e.g. 'PDF')" },
          owner_id: { type: "string", description: "Filter by owner User ID" },
          order_by: { type: "string", enum: ["Title", "CreatedDate", "LastModifiedDate", "ContentSize"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_content_document",
      title: "Get Content Document",
      description: "Get full metadata for a Salesforce ContentDocument (file) by ID. Optionally include linked versions and the records this file is shared with.",
      inputSchema: {
        type: "object",
        properties: {
          document_id: { type: "string", description: "ContentDocument ID (required)" },
          include_versions: { type: "boolean", description: "Include ContentVersions" },
          include_links: { type: "boolean", description: "Include ContentDocumentLinks" },
        },
        required: ["document_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "delete_content_document",
      title: "Delete Content Document",
      description: "Permanently delete a Salesforce ContentDocument (file) and all its versions. This cannot be undone.",
      inputSchema: {
        type: "object",
        properties: {
          document_id: { type: "string", description: "ContentDocument ID to delete" },
        },
        required: ["document_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "list_linked_files",
      title: "List Files Linked to Record",
      description: "List all Salesforce Files (ContentDocuments) linked to a specific record via ContentDocumentLink. Use to find all attachments/files on an Account, Case, Opportunity, etc.",
      inputSchema: {
        type: "object",
        properties: {
          record_id: { type: "string", description: "Salesforce record ID (required)" },
          limit: { type: "number", description: "Max files (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
        },
        required: ["record_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "link_file_to_record",
      title: "Link File to Record",
      description: "Link an existing Salesforce ContentDocument (file) to a record by creating a ContentDocumentLink. Controls who can access the file (Viewer, Collaborator) and visibility.",
      inputSchema: {
        type: "object",
        properties: {
          content_document_id: { type: "string", description: "ContentDocument ID to link" },
          linked_entity_id: { type: "string", description: "Salesforce record ID to link to" },
          share_type: { type: "string", enum: ["V", "C", "I"], description: "V=Viewer, C=Collaborator, I=Inferred" },
          visibility: { type: "string", enum: ["AllUsers", "InternalUsers"] },
        },
        required: ["content_document_id", "linked_entity_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_content_documents: async (args) => {
      const params = ListContentDocumentsSchema.parse(args);
      const conditions: string[] = [];
      if (params.title_filter) conditions.push(`Title LIKE '%${params.title_filter.replace(/'/g, "\\'")}%'`);
      if (params.file_type) conditions.push(`FileType = '${params.file_type.replace(/'/g, "\\'")}'`);
      if (params.owner_id) conditions.push(`OwnerId = '${params.owner_id}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,Title,FileType,ContentSize,OwnerId,CreatedDate,LastModifiedDate,FileExtension,Description FROM ContentDocument ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM ContentDocument ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_content_documents", () => client.query<Record<string, unknown>>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r["Id"],
          title: r["Title"],
          fileType: r["FileType"],
          fileExtension: r["FileExtension"],
          contentSize: r["ContentSize"],
          ownerId: r["OwnerId"],
          description: r["Description"],
          createdDate: r["CreatedDate"],
          lastModifiedDate: r["LastModifiedDate"],
        })),
        meta: {
          total: countResult.totalSize,
          returned: result.records.length,
          hasMore: result.records.length === params.limit,
          offset: params.offset,
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_content_document: async (args) => {
      const params = GetContentDocumentSchema.parse(args);
      const promises: Promise<unknown>[] = [
        client.get<Record<string, unknown>>(`/sobjects/ContentDocument/${params.document_id}`),
      ];
      if (params.include_versions) {
        promises.push(client.query<Record<string, unknown>>(`SELECT Id,VersionNumber,Title,FileType,ContentSize,CreatedDate,IsMajorVersion FROM ContentVersion WHERE ContentDocumentId = '${params.document_id}' ORDER BY VersionNumber DESC LIMIT 10`));
      }
      if (params.include_links) {
        promises.push(client.query<Record<string, unknown>>(`SELECT Id,LinkedEntityId,ShareType,Visibility FROM ContentDocumentLink WHERE ContentDocumentId = '${params.document_id}' LIMIT 50`));
      }

      const results = await Promise.all(promises);
      const doc = results[0] as Record<string, unknown>;

      const response: Record<string, unknown> = {
        id: doc["Id"],
        title: doc["Title"],
        fileType: doc["FileType"],
        fileExtension: doc["FileExtension"],
        contentSize: doc["ContentSize"],
        ownerId: doc["OwnerId"],
        description: doc["Description"],
        latestPublishedVersionId: doc["LatestPublishedVersionId"],
        createdDate: doc["CreatedDate"],
        lastModifiedDate: doc["LastModifiedDate"],
      };

      let idx = 1;
      if (params.include_versions) {
        const vr = results[idx++] as { records: unknown[] };
        response.versions = vr.records;
      }
      if (params.include_links) {
        const lr = results[idx++] as { records: unknown[] };
        response.links = lr.records;
      }

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    delete_content_document: async (args) => {
      const { document_id } = DeleteContentDocumentSchema.parse(args);
      await logger.time("tool.delete_content_document", () =>
        client.delete(`/sobjects/ContentDocument/${document_id}`), {}
      );
      const response = { success: true, document_id, deleted: true };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    list_linked_files: async (args) => {
      const params = ListLinkedFilesSchema.parse(args);
      const soql = `SELECT Id,ContentDocumentId,LinkedEntityId,ShareType,Visibility,ContentDocument.Title,ContentDocument.FileType,ContentDocument.ContentSize,ContentDocument.CreatedDate FROM ContentDocumentLink WHERE LinkedEntityId = '${params.record_id}' LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM ContentDocumentLink WHERE LinkedEntityId = '${params.record_id}'`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_linked_files", () => client.query<Record<string, unknown>>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        recordId: params.record_id,
        files: result.records.map((r) => {
          const doc = r["ContentDocument"] as Record<string, unknown> | undefined;
          return {
            linkId: r["Id"],
            contentDocumentId: r["ContentDocumentId"],
            shareType: r["ShareType"],
            visibility: r["Visibility"],
            title: doc?.["Title"],
            fileType: doc?.["FileType"],
            contentSize: doc?.["ContentSize"],
            createdDate: doc?.["CreatedDate"],
          };
        }),
        meta: {
          total: countResult.totalSize,
          returned: result.records.length,
          hasMore: result.records.length === params.limit,
          offset: params.offset,
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    link_file_to_record: async (args) => {
      const params = LinkFileSchema.parse(args);
      const payload = {
        ContentDocumentId: params.content_document_id,
        LinkedEntityId: params.linked_entity_id,
        ShareType: params.share_type,
        Visibility: params.visibility,
      };

      const result = await logger.time("tool.link_file_to_record", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/ContentDocumentLink", payload), {}
      );

      const response = {
        success: result.success,
        linkId: result.id,
        contentDocumentId: params.content_document_id,
        linkedEntityId: params.linked_entity_id,
        shareType: params.share_type,
        errors: result.errors,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
