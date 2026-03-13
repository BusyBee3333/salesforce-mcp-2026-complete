// Object Describe tool group — Salesforce SObject metadata and schema discovery
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListObjectsSchema = z.object({
  filter: z.string().optional().describe("Optional substring filter on object name (case-insensitive)"),
  custom_only: z.boolean().optional().default(false).describe("Return only custom objects (__c suffix)"),
  queryable_only: z.boolean().optional().default(true).describe("Return only queryable objects (default true)"),
});

const DescribeObjectSchema = z.object({
  object_name: z.string().describe("SObject API name, e.g. 'Account', 'Contact', 'My_Object__c'"),
  include_fields: z.boolean().optional().default(true).describe("Include field metadata"),
  include_child_relationships: z.boolean().optional().default(false).describe("Include child relationship metadata"),
  include_record_types: z.boolean().optional().default(false).describe("Include record types"),
});

const GetFieldSchema = z.object({
  object_name: z.string().describe("SObject API name"),
  field_name: z.string().describe("Field API name, e.g. 'Name', 'AccountId', 'My_Field__c'"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_sobjects",
      title: "List SObjects",
      description: "List all available Salesforce SObject types in the org. Returns object names, labels, and whether they are custom, queryable, or searchable. Use to discover what objects exist.",
      inputSchema: {
        type: "object",
        properties: {
          filter: { type: "string", description: "Substring filter on object API name" },
          custom_only: { type: "boolean", description: "Return only custom objects (default false)" },
          queryable_only: { type: "boolean", description: "Return only queryable objects (default true)" },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "describe_object",
      title: "Describe SObject",
      description: "Get full schema metadata for a Salesforce SObject: fields, types, labels, picklist values, relationships, record types, and CRUD permissions. Essential for understanding object structure.",
      inputSchema: {
        type: "object",
        properties: {
          object_name: { type: "string", description: "SObject API name (e.g. 'Account', 'My_Object__c')" },
          include_fields: { type: "boolean", description: "Include field metadata (default true)" },
          include_child_relationships: { type: "boolean", description: "Include child relationships (default false)" },
          include_record_types: { type: "boolean", description: "Include record types (default false)" },
        },
        required: ["object_name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_field_metadata",
      title: "Get Field Metadata",
      description: "Get detailed metadata for a specific field on a Salesforce object: type, length, required, picklist values, default value, reference targets, etc.",
      inputSchema: {
        type: "object",
        properties: {
          object_name: { type: "string", description: "SObject API name" },
          field_name: { type: "string", description: "Field API name" },
        },
        required: ["object_name", "field_name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_sobjects: async (args) => {
      const params = ListObjectsSchema.parse(args);
      const result = await logger.time("tool.list_sobjects", () =>
        client.get<{ sobjects: Record<string, unknown>[] }>("/sobjects/"), {}
      );

      let objects = result.sobjects || [];

      if (params.queryable_only) {
        objects = objects.filter((o) => o["queryable"] === true);
      }
      if (params.custom_only) {
        objects = objects.filter((o) => String(o["name"] || "").endsWith("__c"));
      }
      if (params.filter) {
        const f = params.filter.toLowerCase();
        objects = objects.filter(
          (o) =>
            String(o["name"] || "").toLowerCase().includes(f) ||
            String(o["label"] || "").toLowerCase().includes(f)
        );
      }

      const records = objects.map((o) => ({
        name: o["name"],
        label: o["label"],
        labelPlural: o["labelPlural"],
        custom: o["custom"],
        queryable: o["queryable"],
        searchable: o["searchable"],
        createable: o["createable"],
        updateable: o["updateable"],
        deletable: o["deletable"],
        keyPrefix: o["keyPrefix"],
      }));

      records.sort((a, b) => String(a.name).localeCompare(String(b.name)));

      const response = {
        objects: records,
        meta: { total: records.length },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    describe_object: async (args) => {
      const params = DescribeObjectSchema.parse(args);
      const result = await logger.time("tool.describe_object", () =>
        client.get<Record<string, unknown>>(`/sobjects/${params.object_name}/describe/`), {}
      );

      const response: Record<string, unknown> = {
        name: result["name"],
        label: result["label"],
        labelPlural: result["labelPlural"],
        keyPrefix: result["keyPrefix"],
        custom: result["custom"],
        queryable: result["queryable"],
        searchable: result["searchable"],
        createable: result["createable"],
        updateable: result["updateable"],
        deletable: result["deletable"],
        undeletable: result["undeletable"],
      };

      if (params.include_fields) {
        const fields = result["fields"] as Record<string, unknown>[] | undefined;
        response.fields = (fields || []).map((f) => ({
          name: f["name"],
          label: f["label"],
          type: f["type"],
          length: f["length"],
          required: !f["nillable"],
          unique: f["unique"],
          createable: f["createable"],
          updateable: f["updateable"],
          referenceTo: f["referenceTo"],
          picklistValues: f["type"] === "picklist" || f["type"] === "multipicklist"
            ? (f["picklistValues"] as Record<string, unknown>[] | undefined)?.filter((v) => v["active"]).map((v) => ({ value: v["value"], label: v["label"] }))
            : undefined,
          defaultValue: f["defaultValue"],
        }));
      }

      if (params.include_child_relationships) {
        response.childRelationships = result["childRelationships"];
      }

      if (params.include_record_types) {
        response.recordTypeInfos = result["recordTypeInfos"];
      }

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_field_metadata: async (args) => {
      const params = GetFieldSchema.parse(args);
      const result = await logger.time("tool.get_field_metadata", () =>
        client.get<Record<string, unknown>>(`/sobjects/${params.object_name}/describe/`), {}
      );

      const fields = result["fields"] as Record<string, unknown>[] | undefined;
      const field = (fields || []).find(
        (f) => String(f["name"] || "").toLowerCase() === params.field_name.toLowerCase()
      );

      if (!field) {
        const similar = (fields || [])
          .filter((f) => String(f["name"] || "").toLowerCase().includes(params.field_name.toLowerCase()))
          .map((f) => f["name"])
          .slice(0, 10);
        const response = {
          error: `Field '${params.field_name}' not found on '${params.object_name}'`,
          suggestions: similar,
        };
        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
      }

      return { content: [{ type: "text", text: JSON.stringify(field, null, 2) }], structuredContent: field };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
