// Chatter tool group — Salesforce Chatter REST API
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListFeedItemsSchema = z.object({
  limit: z.number().min(1).max(100).optional().default(25),
  page: z.string().optional().describe("Pagination token (nextPageUrl from previous response)"),
  filter_type: z.enum(["All", "BookmarkedByMe", "CommentedOnByMe", "LikedByMe", "MentionsMe", "PostedByMe"]).optional().default("All").describe("Feed filter type"),
  sort: z.enum(["CreatedDateDesc", "LastModifiedDateDesc"]).optional().default("CreatedDateDesc"),
});

const CreatePostSchema = z.object({
  body_text: z.string().describe("Text content of the Chatter post (required)"),
  subject_id: z.string().optional().describe("Record ID to post to (if omitted, posts to current user's feed)"),
  mention_ids: z.array(z.string()).optional().describe("Array of User IDs to mention in the post"),
  link_url: z.string().optional().describe("URL to attach as a link"),
  link_name: z.string().optional().describe("Display name for the attached link"),
});

const LikePostSchema = z.object({
  feed_item_id: z.string().describe("Chatter feed item ID to like"),
});

const GetUserFeedSchema = z.object({
  user_id: z.string().optional().describe("Salesforce User ID (defaults to 'me' for current user)"),
  limit: z.number().min(1).max(100).optional().default(25),
  sort: z.enum(["CreatedDateDesc", "LastModifiedDateDesc"]).optional().default("CreatedDateDesc"),
  page: z.string().optional().describe("Pagination token from previous response"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_feed_items",
      title: "List Chatter Feed Items",
      description: "List Salesforce Chatter feed items using the Chatter REST API. Returns posts from the company feed with body text, author, likes, comments, and creation dates. Supports filtering and pagination.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max items to return (default 25, max 100)" },
          page: { type: "string", description: "Pagination token from previous response nextPageUrl" },
          filter_type: { type: "string", enum: ["All", "BookmarkedByMe", "CommentedOnByMe", "LikedByMe", "MentionsMe", "PostedByMe"], description: "Feed filter (default: All)" },
          sort: { type: "string", enum: ["CreatedDateDesc", "LastModifiedDateDesc"], description: "Sort order (default: CreatedDateDesc)" },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_post",
      title: "Create Chatter Post",
      description: "Create a new Salesforce Chatter post. Can post to the company feed, a specific record feed (by subject_id), or mention users. Optionally attach a link.",
      inputSchema: {
        type: "object",
        properties: {
          body_text: { type: "string", description: "Post text content (required)" },
          subject_id: { type: "string", description: "Record ID to post on (omit for current user's feed)" },
          mention_ids: { type: "array", items: { type: "string" }, description: "User IDs to @mention" },
          link_url: { type: "string", description: "URL to attach as a link" },
          link_name: { type: "string", description: "Display name for the attached link" },
        },
        required: ["body_text"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "like_post",
      title: "Like Chatter Post",
      description: "Like a Salesforce Chatter feed item. The current authenticated user will be recorded as having liked the post.",
      inputSchema: {
        type: "object",
        properties: { feed_item_id: { type: "string", description: "Chatter feed item ID to like" } },
        required: ["feed_item_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_user_feed",
      title: "Get User Chatter Feed",
      description: "Get the Chatter feed for a specific user (or the current user if no user_id given). Returns the user's recent posts with body, likes, and comment counts.",
      inputSchema: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "User ID (default: current user 'me')" },
          limit: { type: "number", description: "Max items to return (default 25, max 100)" },
          sort: { type: "string", enum: ["CreatedDateDesc", "LastModifiedDateDesc"] },
          page: { type: "string", description: "Pagination token from previous response" },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function mapFeedItem(item: Record<string, unknown>): Record<string, unknown> {
  const body = item["body"] as Record<string, unknown> | undefined;
  const actor = item["actor"] as Record<string, unknown> | undefined;
  const likes = item["likes"] as Record<string, unknown> | undefined;
  const comments = item["comments"] as Record<string, unknown> | undefined;

  return {
    id: item["id"],
    type: item["type"],
    bodyText: body ? body["text"] : undefined,
    createdDate: item["createdDate"],
    modifiedDate: item["modifiedDate"],
    actorId: actor ? actor["id"] : undefined,
    actorName: actor ? actor["name"] : undefined,
    likeCount: likes ? (likes["total"] ?? 0) : 0,
    commentCount: comments ? (comments["total"] ?? 0) : 0,
    url: item["url"],
  };
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_feed_items: async (args) => {
      const params = ListFeedItemsSchema.parse(args);

      let endpoint = `/chatter/feeds/company/feed-items?pageSize=${params.limit}&sort=${params.sort}`;
      if (params.page) endpoint += `&page=${encodeURIComponent(params.page)}`;
      if (params.filter_type && params.filter_type !== "All") endpoint += `&filterGroup=${params.filter_type}`;

      const result = await logger.time("tool.list_feed_items", () =>
        client.get<Record<string, unknown>>(endpoint), {}
      );

      const items = result["items"] as Record<string, unknown>[] | undefined;
      const response = {
        records: (items || []).map(mapFeedItem),
        nextPageUrl: result["nextPageUrl"],
        currentPageUrl: result["currentPageUrl"],
        total: result["total"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_post: async (args) => {
      const params = CreatePostSchema.parse(args);

      // Build Chatter post body with optional mentions and link
      const messageSegments: unknown[] = [{ type: "Text", text: params.body_text }];

      if (params.mention_ids && params.mention_ids.length > 0) {
        for (const uid of params.mention_ids) {
          messageSegments.push({ type: "Mention", id: uid });
        }
      }

      const body: Record<string, unknown> = {
        body: { messageSegments },
      };

      if (params.link_url) {
        body["attachment"] = {
          attachmentType: "Link",
          url: params.link_url,
          urlName: params.link_name || params.link_url,
        };
      }

      const subjectId = params.subject_id || "me";
      const endpoint = `/chatter/feed-items`;

      // Add subjectId to the body
      body["subjectId"] = subjectId;

      const result = await logger.time("tool.create_post", () =>
        client.post<Record<string, unknown>>(endpoint, body), {}
      );

      const response = {
        success: true,
        feedItemId: result["id"],
        createdDate: result["createdDate"],
        url: result["url"],
        bodyText: params.body_text,
        subjectId,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    like_post: async (args) => {
      const { feed_item_id } = LikePostSchema.parse(args);

      const result = await logger.time("tool.like_post", () =>
        client.post<Record<string, unknown>>(`/chatter/feed-items/${feed_item_id}/likes`, {}), {}
      );

      const response = {
        success: true,
        feed_item_id,
        likeId: result["id"],
        actor: result["actor"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_user_feed: async (args) => {
      const params = GetUserFeedSchema.parse(args);
      const userId = params.user_id || "me";

      let endpoint = `/chatter/feeds/user-profile/${userId}/feed-items?pageSize=${params.limit}&sort=${params.sort}`;
      if (params.page) endpoint += `&page=${encodeURIComponent(params.page)}`;

      const result = await logger.time("tool.get_user_feed", () =>
        client.get<Record<string, unknown>>(endpoint), {}
      );

      const items = result["items"] as Record<string, unknown>[] | undefined;
      const response = {
        userId,
        records: (items || []).map(mapFeedItem),
        nextPageUrl: result["nextPageUrl"],
        currentPageUrl: result["currentPageUrl"],
        total: result["total"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
