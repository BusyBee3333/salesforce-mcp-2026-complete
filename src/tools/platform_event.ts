// Platform Event tool group — Salesforce Platform Events publish/describe
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListPlatformEventsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  name_filter: z.string().optional().describe("Filter by event name"),
});

const DescribePlatformEventSchema = z.object({
  event_name: z.string().describe("Platform event API name (e.g. 'My_Event__e')"),
});

const PublishEventSchema = z.object({
  event_name: z.string().describe("Platform event API name including __e suffix (e.g. 'Order_Update__e')"),
  payload: z.record(z.unknown()).describe("Event payload fields (must match the event's custom fields)"),
});

const PublishBatchEventsSchema = z.object({
  event_name: z.string().describe("Platform event API name"),
  events: z.array(z.record(z.unknown())).min(1).max(200).describe("Array of event payloads (max 200)"),
});

const GetEventDeliverySchema = z.object({
  event_name: z.string().describe("Platform event API name"),
  limit: z.number().min(1).max(100).optional().default(10),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_platform_events",
      title: "List Platform Events",
      description: "List Salesforce Platform Event types defined in the org via SOQL against EntityDefinition. Returns event names, labels, and publish behavior.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          name_filter: { type: "string", description: "Filter by event name" },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "describe_platform_event",
      title: "Describe Platform Event",
      description: "Get full schema metadata for a Salesforce Platform Event type — fields, types, required status, and delivery settings.",
      inputSchema: {
        type: "object",
        properties: {
          event_name: { type: "string", description: "Platform event API name (e.g. 'My_Event__e')" },
        },
        required: ["event_name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "publish_platform_event",
      title: "Publish Platform Event",
      description: "Publish a single Salesforce Platform Event. The event is immediately delivered to all subscribers (Apex triggers, Process Builder, Flows, CometD subscribers). Use for real-time integrations.",
      inputSchema: {
        type: "object",
        properties: {
          event_name: { type: "string", description: "Platform event API name with __e suffix" },
          payload: { type: "object", description: "Event field values to publish" },
        },
        required: ["event_name", "payload"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "publish_platform_events_batch",
      title: "Publish Platform Events Batch",
      description: "Publish up to 200 Salesforce Platform Events in a single API call. More efficient than publishing one at a time. All events are of the same type.",
      inputSchema: {
        type: "object",
        properties: {
          event_name: { type: "string", description: "Platform event API name" },
          events: {
            type: "array",
            items: { type: "object" },
            description: "Array of event payloads (max 200)",
          },
        },
        required: ["event_name", "events"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_platform_events: async (args) => {
      const params = ListPlatformEventsSchema.parse(args);
      const conditions = ["QualifiedApiName LIKE '%__e'"];
      if (params.name_filter) conditions.push(`QualifiedApiName LIKE '%${params.name_filter.replace(/'/g, "\\'")}%'`);
      const where = `WHERE ${conditions.join(" AND ")}`;
      const soql = `SELECT QualifiedApiName,Label,IsCustomizable FROM EntityDefinition ${where} ORDER BY QualifiedApiName ASC LIMIT ${params.limit} OFFSET ${params.offset}`;

      const result = await logger.time("tool.list_platform_events", () =>
        client.query<Record<string, unknown>>(soql), {}
      );

      const response = {
        records: result.records.map((r) => ({
          apiName: r["QualifiedApiName"],
          label: r["Label"],
          isCustomizable: r["IsCustomizable"],
        })),
        meta: { total: result.totalSize, returned: result.records.length, hasMore: result.records.length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    describe_platform_event: async (args) => {
      const { event_name } = DescribePlatformEventSchema.parse(args);
      const result = await logger.time("tool.describe_platform_event", () =>
        client.get<Record<string, unknown>>(`/sobjects/${event_name}/describe/`), {}
      );

      const fields = result["fields"] as Record<string, unknown>[] | undefined;
      const response = {
        name: result["name"],
        label: result["label"],
        createable: result["createable"],
        fields: (fields || []).map((f) => ({
          name: f["name"],
          label: f["label"],
          type: f["type"],
          length: f["length"],
          required: !f["nillable"],
        })),
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    publish_platform_event: async (args) => {
      const params = PublishEventSchema.parse(args);
      const result = await logger.time("tool.publish_platform_event", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>(
          `/sobjects/${params.event_name}/`,
          params.payload
        ), {}
      );

      const response = {
        success: result.success,
        eventId: result.id,
        eventName: params.event_name,
        errors: result.errors,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    publish_platform_events_batch: async (args) => {
      const params = PublishBatchEventsSchema.parse(args);

      const subrequests = params.events.map((payload, i) => ({
        method: "POST",
        url: `/services/data/v59.0/sobjects/${params.event_name}/`,
        referenceId: `event_${i}`,
        body: payload,
      }));

      const result = await logger.time("tool.publish_platform_events_batch", () =>
        client.post<{ compositeResponse: Record<string, unknown>[] }>("/composite/", {
          allOrNone: false,
          compositeRequest: subrequests,
        }), {}
      );

      const responses = result.compositeResponse || [];
      const successful = responses.filter((r) => Number(r["httpStatusCode"] || 0) < 400);
      const failed = responses.filter((r) => Number(r["httpStatusCode"] || 0) >= 400);

      const response = {
        eventName: params.event_name,
        totalPublished: params.events.length,
        successCount: successful.length,
        failureCount: failed.length,
        results: responses.map((r) => ({
          referenceId: r["referenceId"],
          statusCode: r["httpStatusCode"],
          success: Number(r["httpStatusCode"] || 0) < 400,
          body: r["body"],
        })),
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
