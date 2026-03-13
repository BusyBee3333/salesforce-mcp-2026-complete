// Validation Rule tool group — Salesforce Validation Rules via Tooling API
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListValidationRulesSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  sobject_type: z.string().optional().describe("Filter by SObject entity type (e.g. 'Account', 'Opportunity')"),
  name_filter: z.string().optional().describe("Filter by validation rule name"),
  active_only: z.boolean().optional().default(false),
  order_by: z.enum(["ValidationName", "EntityDefinitionId", "CreatedDate"]).optional().default("ValidationName"),
});

const GetValidationRuleSchema = z.object({
  rule_id: z.string().describe("ValidationRule ID"),
});

const CreateValidationRuleSchema = z.object({
  entity_definition_id: z.string().describe("SObject API name for this validation rule (e.g. 'Account')"),
  validation_name: z.string().describe("Validation rule API name (no spaces)"),
  error_message: z.string().describe("Error message shown to user when validation fails"),
  error_formula: z.string().describe("Salesforce formula that evaluates to true to trigger error"),
  error_display_field: z.string().optional().describe("Field API name to display error on (null = top of page)"),
  active: z.boolean().optional().default(true),
  description: z.string().optional(),
});

const UpdateValidationRuleSchema = z.object({
  rule_id: z.string().describe("ValidationRule ID to update"),
  validation_name: z.string().optional(),
  error_message: z.string().optional(),
  error_formula: z.string().optional(),
  error_display_field: z.string().optional(),
  active: z.boolean().optional(),
  description: z.string().optional(),
});

const DeleteValidationRuleSchema = z.object({
  rule_id: z.string().describe("ValidationRule ID to delete"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_validation_rules",
      title: "List Validation Rules",
      description: "List Salesforce Validation Rules via the Tooling API. Filter by SObject type, name, or active status. Returns rule names, error messages, formulas, and status.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          sobject_type: { type: "string", description: "Filter by SObject type (e.g. 'Account')" },
          name_filter: { type: "string", description: "Filter by validation rule name" },
          active_only: { type: "boolean", description: "Return only active rules" },
          order_by: { type: "string", enum: ["ValidationName", "EntityDefinitionId", "CreatedDate"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_validation_rule",
      title: "Get Validation Rule",
      description: "Get full details for a Salesforce Validation Rule by ID via the Tooling API, including the error formula and error message.",
      inputSchema: {
        type: "object",
        properties: {
          rule_id: { type: "string", description: "ValidationRule ID (required)" },
        },
        required: ["rule_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_validation_rule",
      title: "Create Validation Rule",
      description: "Create a new Salesforce Validation Rule via the Tooling API. Define the error formula (when true = error) and the error message shown to users.",
      inputSchema: {
        type: "object",
        properties: {
          entity_definition_id: { type: "string", description: "SObject API name (e.g. 'Account')" },
          validation_name: { type: "string", description: "API name (no spaces)" },
          error_message: { type: "string", description: "Error message when validation fails" },
          error_formula: { type: "string", description: "Formula that evaluates to true to trigger error" },
          error_display_field: { type: "string", description: "Field to display error on" },
          active: { type: "boolean", description: "Active status (default true)" },
          description: { type: "string" },
        },
        required: ["entity_definition_id", "validation_name", "error_message", "error_formula"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "update_validation_rule",
      title: "Update Validation Rule",
      description: "Update an existing Salesforce Validation Rule — change the formula, error message, active status, or description.",
      inputSchema: {
        type: "object",
        properties: {
          rule_id: { type: "string", description: "ValidationRule ID (required)" },
          validation_name: { type: "string" },
          error_message: { type: "string" },
          error_formula: { type: "string" },
          error_display_field: { type: "string" },
          active: { type: "boolean" },
          description: { type: "string" },
        },
        required: ["rule_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "delete_validation_rule",
      title: "Delete Validation Rule",
      description: "Delete a Salesforce Validation Rule via the Tooling API.",
      inputSchema: {
        type: "object",
        properties: {
          rule_id: { type: "string", description: "ValidationRule ID to delete" },
        },
        required: ["rule_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_validation_rules: async (args) => {
      const params = ListValidationRulesSchema.parse(args);
      const conditions: string[] = [];
      if (params.sobject_type) conditions.push(`EntityDefinitionId = '${params.sobject_type}'`);
      if (params.name_filter) conditions.push(`ValidationName LIKE '%${params.name_filter.replace(/'/g, "\\'")}%'`);
      if (params.active_only) conditions.push(`Active = true`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,ValidationName,Active,ErrorMessage,ErrorFormula,EntityDefinitionId,Description,CreatedDate,LastModifiedDate FROM ValidationRule ${where} ORDER BY ${params.order_by} ASC LIMIT ${params.limit} OFFSET ${params.offset}`;

      const result = await logger.time("tool.list_validation_rules", () =>
        client.get<{ records: Record<string, unknown>[]; totalSize: number; done: boolean }>(
          `/tooling/query/?q=${encodeURIComponent(soql)}`
        ), {}
      );

      const response = {
        records: (result.records || []).map((r) => ({
          id: r["Id"],
          validationName: r["ValidationName"],
          active: r["Active"],
          errorMessage: r["ErrorMessage"],
          errorFormula: r["ErrorFormula"],
          entityDefinitionId: r["EntityDefinitionId"],
          description: r["Description"],
          createdDate: r["CreatedDate"],
          lastModifiedDate: r["LastModifiedDate"],
        })),
        meta: { total: result.totalSize, returned: (result.records || []).length, hasMore: (result.records || []).length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_validation_rule: async (args) => {
      const { rule_id } = GetValidationRuleSchema.parse(args);
      const soql = `SELECT Id,ValidationName,Active,ErrorMessage,ErrorFormula,ErrorDisplayField,EntityDefinitionId,Description,CreatedDate,LastModifiedDate FROM ValidationRule WHERE Id = '${rule_id}'`;
      const result = await logger.time("tool.get_validation_rule", () =>
        client.get<{ records: Record<string, unknown>[] }>(
          `/tooling/query/?q=${encodeURIComponent(soql)}`
        ), {}
      );

      const rule = (result.records || [])[0] as Record<string, unknown> | undefined;
      if (!rule) {
        const response = { error: `ValidationRule with ID '${rule_id}' not found` };
        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
      }

      const response = {
        id: rule["Id"],
        validationName: rule["ValidationName"],
        active: rule["Active"],
        errorMessage: rule["ErrorMessage"],
        errorFormula: rule["ErrorFormula"],
        errorDisplayField: rule["ErrorDisplayField"],
        entityDefinitionId: rule["EntityDefinitionId"],
        description: rule["Description"],
        createdDate: rule["CreatedDate"],
        lastModifiedDate: rule["LastModifiedDate"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_validation_rule: async (args) => {
      const params = CreateValidationRuleSchema.parse(args);
      const payload: Record<string, unknown> = {
        EntityDefinitionId: params.entity_definition_id,
        ValidationName: params.validation_name,
        Active: params.active,
        ErrorMessage: params.error_message,
        ErrorFormula: params.error_formula,
      };
      if (params.error_display_field) payload["ErrorDisplayField"] = params.error_display_field;
      if (params.description) payload["Description"] = params.description;

      const result = await logger.time("tool.create_validation_rule", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>("/tooling/sobjects/ValidationRule", payload), {}
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },

    update_validation_rule: async (args) => {
      const { rule_id, ...updates } = UpdateValidationRuleSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.validation_name !== undefined) payload["ValidationName"] = updates.validation_name;
      if (updates.error_message !== undefined) payload["ErrorMessage"] = updates.error_message;
      if (updates.error_formula !== undefined) payload["ErrorFormula"] = updates.error_formula;
      if (updates.error_display_field !== undefined) payload["ErrorDisplayField"] = updates.error_display_field;
      if (updates.active !== undefined) payload["Active"] = updates.active;
      if (updates.description !== undefined) payload["Description"] = updates.description;

      await logger.time("tool.update_validation_rule", () =>
        client.patch(`/tooling/sobjects/ValidationRule/${rule_id}`, payload), {}
      );

      const response = { success: true, rule_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    delete_validation_rule: async (args) => {
      const { rule_id } = DeleteValidationRuleSchema.parse(args);
      await logger.time("tool.delete_validation_rule", () =>
        client.delete(`/tooling/sobjects/ValidationRule/${rule_id}`), {}
      );
      const response = { success: true, rule_id, deleted: true };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
