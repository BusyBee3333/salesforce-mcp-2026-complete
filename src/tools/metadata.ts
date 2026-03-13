// Metadata tool group — Salesforce Metadata API (describe, list, custom fields)
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const DescribeMetadataSchema = z.object({
  api_version: z.string().optional().default("59.0").describe("Salesforce API version"),
});

const ListMetadataSchema = z.object({
  metadata_type: z.string().describe("Metadata type to list (e.g. 'CustomObject', 'ApexClass', 'Flow', 'CustomField')"),
  folder: z.string().optional().describe("Folder name (required for folder-based types like EmailTemplate, Report)"),
});

const DescribeCustomFieldSchema = z.object({
  sobject_type: z.string().describe("SObject API name (e.g. 'Account')"),
  field_name: z.string().describe("Custom field API name (e.g. 'My_Field__c')"),
});

const ListCustomFieldsSchema = z.object({
  sobject_type: z.string().describe("SObject API name to list custom fields for"),
  limit: z.number().min(1).max(500).optional().default(50),
  offset: z.number().min(0).optional().default(0),
  name_filter: z.string().optional().describe("Filter by field name"),
  field_type: z.string().optional().describe("Filter by field type (e.g. 'Text', 'Lookup', 'Number')"),
});

const GetOrgNamespaceSchema = z.object({});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "describe_metadata_types",
      title: "Describe Metadata Types",
      description: "List all available Salesforce Metadata types for the current API version. Returns metadata type names, XML names, and whether they support folder deployment. Use to discover what metadata types are deployable.",
      inputSchema: {
        type: "object",
        properties: {
          api_version: { type: "string", description: "API version (default: 59.0)" },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "list_metadata",
      title: "List Metadata Components",
      description: "List metadata components of a specific type (e.g., list all ApexClasses, all CustomObjects, all Flows). Returns component names, full names, and modification dates.",
      inputSchema: {
        type: "object",
        properties: {
          metadata_type: { type: "string", description: "Metadata type (e.g. 'ApexClass', 'CustomObject', 'Flow')" },
          folder: { type: "string", description: "Folder name (for folder-based types)" },
        },
        required: ["metadata_type"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "list_custom_fields",
      title: "List Custom Fields",
      description: "List custom fields on a Salesforce SObject using FieldDefinition. Returns field names, labels, types, and other metadata. More detailed than standard describe.",
      inputSchema: {
        type: "object",
        properties: {
          sobject_type: { type: "string", description: "SObject API name (required)" },
          limit: { type: "number", description: "Max records (default 50)" },
          offset: { type: "number", description: "Pagination offset" },
          name_filter: { type: "string", description: "Filter by field name" },
          field_type: { type: "string", description: "Filter by data type" },
        },
        required: ["sobject_type"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_custom_field_metadata",
      title: "Get Custom Field Metadata",
      description: "Get detailed metadata for a specific custom field using the Tooling API CustomField object. Returns length, formula, picklist values, default values, and more.",
      inputSchema: {
        type: "object",
        properties: {
          sobject_type: { type: "string", description: "SObject API name (required)" },
          field_name: { type: "string", description: "Custom field API name (required)" },
        },
        required: ["sobject_type", "field_name"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_org_namespace",
      title: "Get Org Namespace & Info",
      description: "Get the Salesforce org namespace prefix, org ID, org type, and other organization details from the Organization object.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    describe_metadata_types: async (args) => {
      const _params = DescribeMetadataSchema.parse(args);
      // Use Tooling API to list metadata types
      const result = await logger.time("tool.describe_metadata_types", () =>
        client.get<{ metadataObjects: Record<string, unknown>[] }>("/tooling/describe/"), {}
      );

      const metadataObjects = result.metadataObjects || [];
      metadataObjects.sort((a, b) => String(a["xmlName"] || "").localeCompare(String(b["xmlName"] || "")));

      const response = {
        metadataTypes: metadataObjects.map((m) => ({
          xmlName: m["xmlName"],
          directoryName: m["directoryName"],
          suffix: m["suffix"],
          inFolder: m["inFolder"],
          metaFile: m["metaFile"],
          childXmlNames: m["childXmlNames"],
        })),
        meta: { total: metadataObjects.length },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    list_metadata: async (args) => {
      const params = ListMetadataSchema.parse(args);

      // Use the Tooling query to list metadata components
      let soql = `SELECT Id,DeveloperName,NamespacePrefix,LastModifiedDate FROM ${params.metadata_type} ORDER BY DeveloperName ASC LIMIT 200`;

      // For types that don't have DeveloperName, fall back to Name
      const nameFields: Record<string, string> = {
        ApexClass: "Name",
        ApexTrigger: "Name",
        ApexPage: "Name",
        ApexComponent: "Name",
      };

      const nameField = nameFields[params.metadata_type] || "DeveloperName";
      soql = `SELECT Id,${nameField},ApiVersion,LastModifiedDate FROM ${params.metadata_type} ORDER BY ${nameField} ASC LIMIT 200`;

      let result: { records: Record<string, unknown>[]; totalSize: number };
      try {
        result = await logger.time("tool.list_metadata", () =>
          client.get<{ records: Record<string, unknown>[]; totalSize: number }>(
            `/tooling/query/?q=${encodeURIComponent(soql)}`
          ), {}
        );
      } catch {
        // Fallback for non-tooling types
        const fallbackSoql = `SELECT QualifiedApiName,Label,LastModifiedDate FROM EntityDefinition WHERE QualifiedApiName LIKE '%' ORDER BY QualifiedApiName ASC LIMIT 50`;
        result = await client.get<{ records: Record<string, unknown>[]; totalSize: number }>(
          `/query/?q=${encodeURIComponent(fallbackSoql)}`
        );
      }

      const response = {
        metadataType: params.metadata_type,
        records: (result.records || []).map((r) => ({
          id: r["Id"],
          name: r[nameField] || r["Name"] || r["DeveloperName"],
          apiVersion: r["ApiVersion"],
          lastModifiedDate: r["LastModifiedDate"],
        })),
        meta: { total: result.totalSize, returned: (result.records || []).length },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    list_custom_fields: async (args) => {
      const params = ListCustomFieldsSchema.parse(args);
      const conditions = [`EntityDefinition.QualifiedApiName = '${params.sobject_type}'`];
      if (params.name_filter) conditions.push(`QualifiedApiName LIKE '%${params.name_filter.replace(/'/g, "\\'")}%'`);
      if (params.field_type) conditions.push(`DataType = '${params.field_type}'`);
      const where = `WHERE ${conditions.join(" AND ")}`;
      const soql = `SELECT Id,QualifiedApiName,Label,DataType,Length,IsCustom,IsRequired,IsNillable,InlineHelpText,LastModifiedDate FROM FieldDefinition ${where} ORDER BY QualifiedApiName ASC LIMIT ${params.limit} OFFSET ${params.offset}`;

      const result = await logger.time("tool.list_custom_fields", () =>
        client.get<{ records: Record<string, unknown>[]; totalSize: number }>(
          `/tooling/query/?q=${encodeURIComponent(soql)}`
        ), {}
      );

      const response = {
        sobjectType: params.sobject_type,
        fields: (result.records || []).map((r) => ({
          id: r["Id"],
          apiName: r["QualifiedApiName"],
          label: r["Label"],
          dataType: r["DataType"],
          length: r["Length"],
          isCustom: r["IsCustom"],
          isRequired: r["IsRequired"],
          inlineHelpText: r["InlineHelpText"],
          lastModifiedDate: r["LastModifiedDate"],
        })),
        meta: { total: result.totalSize, returned: (result.records || []).length, hasMore: (result.records || []).length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_custom_field_metadata: async (args) => {
      const params = DescribeCustomFieldSchema.parse(args);
      const soql = `SELECT Id,DeveloperName,EntityDefinitionId,DataType,Label,Length,Precision,Scale,IsRequired,IsUnique,IsExternalId,InlineHelpText,Description,DefaultValue,ReferenceTo,RelationshipName,LastModifiedDate FROM CustomField WHERE EntityDefinitionId = '${params.sobject_type}' AND DeveloperName = '${params.field_name.replace(/__c$/i, "")}'`;

      const result = await logger.time("tool.get_custom_field_metadata", () =>
        client.get<{ records: Record<string, unknown>[] }>(
          `/tooling/query/?q=${encodeURIComponent(soql)}`
        ), {}
      );

      const field = (result.records || [])[0] as Record<string, unknown> | undefined;
      if (!field) {
        const response = { error: `Custom field '${params.field_name}' not found on '${params.sobject_type}'` };
        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
      }

      return { content: [{ type: "text", text: JSON.stringify(field, null, 2) }], structuredContent: field };
    },

    get_org_namespace: async (_args) => {
      GetOrgNamespaceSchema.parse(_args);
      const soql = `SELECT Id,Name,NamespacePrefix,OrganizationType,Edition,IsSandbox,TrialExpirationDate,TimeZoneSidKey,LanguageLocaleKey,FiscalYearStartMonth FROM Organization LIMIT 1`;

      const result = await logger.time("tool.get_org_namespace", () =>
        client.query<Record<string, unknown>>(soql), {}
      );

      const org = (result.records || [])[0] as Record<string, unknown> | undefined;
      const response = org || { error: "Could not retrieve organization information" };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
