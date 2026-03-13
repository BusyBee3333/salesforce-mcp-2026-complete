// Attachments tool group — Salesforce ContentDocument/ContentNote + classic Attachment metadata
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListAttachmentsSchema = z.object({
  linked_entity_id: z.string().optional().describe("Filter by linked record ID (any sObject — Account, Case, etc.)"),
  content_type: z.string().optional().describe("Filter by FileType (e.g. 'PDF', 'PNG', 'DOCX')"),
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  order_by: z.enum(["CreatedDate", "LastModifiedDate", "Title"]).optional().default("CreatedDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

const GetAttachmentMetadataSchema = z.object({
  content_document_id: z.string().describe("Salesforce ContentDocument ID"),
});

const CreateContentNoteSchema = z.object({
  title: z.string().describe("Note title (required)"),
  content: z.string().describe("Note body as plain text or HTML (required)"),
  linked_entity_id: z.string().optional().describe("sObject ID to link this note to (e.g. Account ID, Case ID)"),
  share_type: z.enum(["V", "C", "I"]).optional().default("V").describe("Share type: V=Viewer, C=Collaborator, I=Inferred (default V)"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_attachments",
      title: "List Attachments",
      description: "List Salesforce ContentDocument files (Files & Attachments). Can filter by linked record to find all documents attached to an Account, Case, Opportunity, etc.",
      inputSchema: {
        type: "object",
        properties: {
          linked_entity_id: { type: "string", description: "Filter by linked record ID" },
          content_type: { type: "string", description: "Filter by file type (PDF/PNG/DOCX/etc.)" },
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          order_by: { type: "string", enum: ["CreatedDate", "LastModifiedDate", "Title"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_attachment_metadata",
      title: "Get Attachment Metadata",
      description: "Get metadata for a specific Salesforce ContentDocument by ID. Returns title, size, type, owner, and linked entities. Does NOT download file content.",
      inputSchema: {
        type: "object",
        properties: { content_document_id: { type: "string", description: "ContentDocument ID" } },
        required: ["content_document_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_content_note",
      title: "Create Content Note",
      description: "Create a Salesforce Enhanced Note (ContentNote) and optionally link it to any sObject record. Returns the ContentDocument ID of the created note.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Note title (required)" },
          content: { type: "string", description: "Note body text or HTML (required)" },
          linked_entity_id: { type: "string", description: "Record ID to link the note to" },
          share_type: { type: "string", enum: ["V", "C", "I"], description: "Share type: V=Viewer, C=Collaborator, I=Inferred" },
        },
        required: ["title", "content"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_attachments: async (args) => {
      const params = ListAttachmentsSchema.parse(args);

      let soql: string;
      let countSoql: string;

      if (params.linked_entity_id) {
        // Use ContentDocumentLink to find documents linked to a specific record
        const conditions: string[] = [`LinkedEntityId = '${params.linked_entity_id}'`];
        const where = `WHERE ${conditions.join(" AND ")}`;
        soql = `SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.FileType, ContentDocument.FileExtension, ContentDocument.ContentSize, ContentDocument.OwnerId, ContentDocument.CreatedDate, ContentDocument.LastModifiedDate FROM ContentDocumentLink ${where} ORDER BY ContentDocument.${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
        countSoql = `SELECT COUNT() FROM ContentDocumentLink ${where}`;
      } else {
        // List all ContentDocuments
        const conditions: string[] = [];
        if (params.content_type) conditions.push(`FileType = '${params.content_type.toUpperCase().replace(/'/g, "\\'")}'`);
        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
        soql = `SELECT Id, Title, FileType, FileExtension, ContentSize, OwnerId, CreatedDate, LastModifiedDate FROM ContentDocument ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
        countSoql = `SELECT COUNT() FROM ContentDocument ${where}`;
      }

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_attachments", () => client.query(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: (result.records as Record<string, unknown>[]).map((r) => {
          if (params.linked_entity_id) {
            const doc = r["ContentDocument"] as Record<string, unknown> | undefined;
            return {
              contentDocumentId: r["ContentDocumentId"],
              title: doc?.["Title"],
              fileType: doc?.["FileType"],
              fileExtension: doc?.["FileExtension"],
              contentSize: doc?.["ContentSize"],
              ownerId: doc?.["OwnerId"],
              createdDate: doc?.["CreatedDate"],
              lastModifiedDate: doc?.["LastModifiedDate"],
            };
          }
          return {
            contentDocumentId: r["Id"],
            title: r["Title"],
            fileType: r["FileType"],
            fileExtension: r["FileExtension"],
            contentSize: r["ContentSize"],
            ownerId: r["OwnerId"],
            createdDate: r["CreatedDate"],
            lastModifiedDate: r["LastModifiedDate"],
          };
        }),
        meta: {
          total: countResult.totalSize,
          returned: result.records.length,
          hasMore: !result.done || result.records.length === params.limit,
          offset: params.offset,
          limit: params.limit,
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_attachment_metadata: async (args) => {
      const { content_document_id } = GetAttachmentMetadataSchema.parse(args);

      const [doc, links] = await Promise.all([
        logger.time("tool.get_attachment_metadata", () =>
          client.get<Record<string, unknown>>(`/sobjects/ContentDocument/${content_document_id}`), {}
        ),
        client.query(`SELECT LinkedEntityId, ShareType, Visibility FROM ContentDocumentLink WHERE ContentDocumentId = '${content_document_id}'`),
      ]);

      const response = {
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
        linkedEntities: (links.records as Record<string, unknown>[]).map((l) => ({
          linkedEntityId: l["LinkedEntityId"],
          shareType: l["ShareType"],
          visibility: l["Visibility"],
        })),
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_content_note: async (args) => {
      const params = CreateContentNoteSchema.parse(args);

      // ContentNote is a special variant of ContentDocument
      // We need to base64 encode the content for the API
      const encodedContent = Buffer.from(params.content, "utf-8").toString("base64");

      const notePayload: Record<string, unknown> = {
        Title: params.title,
        Content: encodedContent,
      };

      const noteResult = await logger.time("tool.create_content_note", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/ContentNote", notePayload), {}
      );

      const response: Record<string, unknown> = {
        contentDocumentId: noteResult.id,
        success: noteResult.success,
        errors: noteResult.errors,
      };

      // If a linked entity is provided, create the ContentDocumentLink
      if (params.linked_entity_id && noteResult.success) {
        const linkPayload: Record<string, unknown> = {
          ContentDocumentId: noteResult.id,
          LinkedEntityId: params.linked_entity_id,
          ShareType: params.share_type || "V",
        };

        const linkResult = await client.post<{ id: string; success: boolean; errors: unknown[] }>(
          "/sobjects/ContentDocumentLink",
          linkPayload
        );

        response.contentDocumentLinkId = linkResult.id;
        response.linkedEntityId = params.linked_entity_id;
        response.linkSuccess = linkResult.success;
      }

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
