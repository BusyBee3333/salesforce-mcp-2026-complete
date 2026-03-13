// Knowledge tool group — Salesforce Knowledge Article operations
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

// Note: Knowledge object names vary by org; KnowledgeArticle for metadata,
// Knowledge__kav or Knowledge__ka pattern for actual article objects.
// We use KnowledgeArticleVersion (kavType) and Knowledge__kav as defaults
// but the core SOQL hits KnowledgeArticle for metadata + Knowledge__kav for content.

const LIST_FIELDS =
  "Id,KnowledgeArticleId,Title,UrlName,Summary,Language,IsVisibleInApp,IsVisibleInCsp,IsVisibleInPkb,IsVisibleInPrm,PublishStatus,VersionNumber,LastPublishedDate,CreatedDate,LastModifiedDate";

const ListArticlesSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  publish_status: z.enum(["Draft", "Online", "Archived"]).optional().describe("Filter by PublishStatus"),
  language: z.string().optional().default("en_US").describe("Language filter (default: en_US)"),
  title_search: z.string().optional().describe("Filter articles by title (LIKE match)"),
  order_by: z.enum(["CreatedDate", "LastModifiedDate", "Title", "LastPublishedDate"]).optional().default("LastModifiedDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

const GetArticleSchema = z.object({
  article_id: z.string().describe("KnowledgeArticleVersion ID"),
});

const SearchArticlesSchema = z.object({
  query: z.string().describe("Full-text search query for knowledge articles (required)"),
  language: z.string().optional().default("en_US").describe("Language (default: en_US)"),
  publish_status: z.enum(["Draft", "Online", "Archived"]).optional().default("Online"),
  limit: z.number().min(1).max(50).optional().default(10),
});

const CreateArticleSchema = z.object({
  title: z.string().describe("Article title (required)"),
  url_name: z.string().describe("URL name / slug (required, no spaces)"),
  summary: z.string().optional().describe("Article summary"),
  body: z.string().optional().describe("Article body (HTML or plain text)"),
  language: z.string().optional().default("en_US"),
  is_visible_in_app: z.boolean().optional().default(false).describe("Visible in Salesforce app"),
  is_visible_in_pkb: z.boolean().optional().default(true).describe("Visible in Public Knowledge Base"),
});

const PublishArticleSchema = z.object({
  article_id: z.string().describe("KnowledgeArticleVersion ID to publish"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_articles",
      title: "List Knowledge Articles",
      description: "List Salesforce Knowledge articles with optional filters by publish status, language, or title. Returns article titles, URLs, summaries, and publish status.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          publish_status: { type: "string", enum: ["Draft", "Online", "Archived"], description: "Filter by publish status" },
          language: { type: "string", description: "Language filter (default: en_US)" },
          title_search: { type: "string", description: "Filter by title (LIKE match)" },
          order_by: { type: "string", enum: ["CreatedDate", "LastModifiedDate", "Title", "LastPublishedDate"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_article",
      title: "Get Knowledge Article",
      description: "Get full details for a Salesforce Knowledge article version by ID including body content, URL name, visibility settings, and publish status.",
      inputSchema: {
        type: "object",
        properties: { article_id: { type: "string", description: "KnowledgeArticleVersion ID" } },
        required: ["article_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "search_articles",
      title: "Search Knowledge Articles",
      description: "Full-text search Salesforce Knowledge articles using SOSL. Returns ranked matches by relevance. Use when looking for articles on a specific topic.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (required)" },
          language: { type: "string", description: "Language filter (default: en_US)" },
          publish_status: { type: "string", enum: ["Draft", "Online", "Archived"], description: "Publish status (default: Online)" },
          limit: { type: "number", description: "Max results (default 10, max 50)" },
        },
        required: ["query"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_article",
      title: "Create Knowledge Article",
      description: "Create a new Salesforce Knowledge article in Draft status. Requires title and url_name. The article must be published separately via publish_article.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Article title (required)" },
          url_name: { type: "string", description: "URL slug — no spaces (required)" },
          summary: { type: "string", description: "Article summary" },
          body: { type: "string", description: "Article body content" },
          language: { type: "string", description: "Language (default: en_US)" },
          is_visible_in_app: { type: "boolean", description: "Visible in Salesforce app (default: false)" },
          is_visible_in_pkb: { type: "boolean", description: "Visible in Public Knowledge Base (default: true)" },
        },
        required: ["title", "url_name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "publish_article",
      title: "Publish Knowledge Article",
      description: "Publish a Salesforce Knowledge article (set PublishStatus to 'Online'). The article must be in Draft status.",
      inputSchema: {
        type: "object",
        properties: { article_id: { type: "string", description: "KnowledgeArticleVersion ID to publish" } },
        required: ["article_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_articles: async (args) => {
      const params = ListArticlesSchema.parse(args);
      const conditions: string[] = [];
      if (params.language) conditions.push(`Language = '${params.language}'`);
      if (params.publish_status) conditions.push(`PublishStatus = '${params.publish_status}'`);
      if (params.title_search) conditions.push(`Title LIKE '%${params.title_search.replace(/'/g, "\\'")}%'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT ${LIST_FIELDS} FROM KnowledgeArticleVersion ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM KnowledgeArticleVersion ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_articles", () => client.query(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: (result.records as Record<string, unknown>[]).map((r) => ({
          id: r["Id"],
          knowledgeArticleId: r["KnowledgeArticleId"],
          title: r["Title"],
          urlName: r["UrlName"],
          summary: r["Summary"],
          language: r["Language"],
          publishStatus: r["PublishStatus"],
          versionNumber: r["VersionNumber"],
          lastPublishedDate: r["LastPublishedDate"],
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

    get_article: async (args) => {
      const { article_id } = GetArticleSchema.parse(args);
      const result = await logger.time("tool.get_article", () =>
        client.get<Record<string, unknown>>(`/sobjects/KnowledgeArticleVersion/${article_id}`), {}
      );

      const response = {
        id: result["Id"],
        knowledgeArticleId: result["KnowledgeArticleId"],
        title: result["Title"],
        urlName: result["UrlName"],
        summary: result["Summary"],
        language: result["Language"],
        publishStatus: result["PublishStatus"],
        versionNumber: result["VersionNumber"],
        isVisibleInApp: result["IsVisibleInApp"],
        isVisibleInCsp: result["IsVisibleInCsp"],
        isVisibleInPkb: result["IsVisibleInPkb"],
        isVisibleInPrm: result["IsVisibleInPrm"],
        lastPublishedDate: result["LastPublishedDate"],
        createdDate: result["CreatedDate"],
        lastModifiedDate: result["LastModifiedDate"],
        // Note: Body field name is org-specific (e.g. Body__c), include all remaining fields
        extraFields: Object.fromEntries(
          Object.entries(result).filter(([k]) => !["Id", "KnowledgeArticleId", "Title", "UrlName", "Summary", "Language", "PublishStatus", "VersionNumber", "IsVisibleInApp", "IsVisibleInCsp", "IsVisibleInPkb", "IsVisibleInPrm", "LastPublishedDate", "CreatedDate", "LastModifiedDate", "attributes"].includes(k))
        ),
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    search_articles: async (args) => {
      const params = SearchArticlesSchema.parse(args);
      const sosl = `FIND {${params.query.replace(/['"\\]/g, "\\$&")}} IN ALL FIELDS RETURNING KnowledgeArticleVersion(Id, Title, UrlName, Summary, PublishStatus, Language WHERE Language = '${params.language}' AND PublishStatus = '${params.publish_status}') LIMIT ${params.limit}`;

      const result = await logger.time("tool.search_articles", () =>
        client.request<{ searchRecords: Record<string, unknown>[] }>(`/search/?q=${encodeURIComponent(sosl)}`), {}
      );

      const response = {
        query: params.query,
        records: (result.searchRecords || []).map((r) => ({
          id: r["Id"],
          title: r["Title"],
          urlName: r["UrlName"],
          summary: r["Summary"],
          publishStatus: r["PublishStatus"],
          language: r["Language"],
        })),
        total: result.searchRecords?.length ?? 0,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_article: async (args) => {
      const params = CreateArticleSchema.parse(args);
      const payload: Record<string, unknown> = {
        Title: params.title,
        UrlName: params.url_name,
        Language: params.language || "en_US",
        IsVisibleInApp: params.is_visible_in_app !== undefined ? params.is_visible_in_app : false,
        IsVisibleInPkb: params.is_visible_in_pkb !== undefined ? params.is_visible_in_pkb : true,
      };
      if (params.summary) payload["Summary"] = params.summary;
      // Body field varies by org — store in a well-known field name if present
      if (params.body) payload["Body__c"] = params.body;

      const result = await logger.time("tool.create_article", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/sobjects/KnowledgeArticleVersion", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    publish_article: async (args) => {
      const { article_id } = PublishArticleSchema.parse(args);

      // Use the Knowledge REST API action to publish
      const result = await logger.time("tool.publish_article", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>(
          `/knowledgeManagement/articleVersions/masterVersions/${article_id}`,
          {}
        ), {}
      );

      const response = {
        success: true,
        article_id,
        publishStatus: "Online",
        details: result,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
