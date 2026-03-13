// Sharing Rules tool group — Salesforce AccountShare, CaseShare, and manual sharing
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListSharesSchema = z.object({
  sobject_type: z.string().describe("SObject type name (e.g. 'Account', 'Case', 'Opportunity') — maps to AccountShare, CaseShare, etc."),
  record_id: z.string().optional().describe("Filter by specific record ID"),
  user_or_group_id: z.string().optional().describe("Filter by user or group ID that has access"),
  access_level: z.string().optional().describe("Filter by access level (e.g. 'Edit', 'Read', 'All')"),
  row_cause: z.string().optional().describe("Filter by row cause (e.g. 'Manual', 'Rule', 'Owner')"),
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
});

const CreateShareSchema = z.object({
  sobject_type: z.string().describe("SObject type (e.g. 'Account', 'Case', 'Opportunity')"),
  record_id: z.string().describe("Record ID to grant access to (required)"),
  user_or_group_id: z.string().describe("User ID or Group ID to share with (required)"),
  access_level: z.enum(["Read", "Edit", "All"]).describe("Access level: Read, Edit, or All (Full Control)"),
});

const DeleteShareSchema = z.object({
  sobject_type: z.string().describe("SObject type (e.g. 'Account', 'Case')"),
  share_id: z.string().describe("Share record ID to delete"),
});

const GetRecordAccessSchema = z.object({
  sobject_type: z.string().describe("SObject type (e.g. 'Account')"),
  record_id: z.string().describe("Record ID to check access for"),
  user_id: z.string().describe("User ID to check access for"),
});

const ListOrgWideDefaultsSchema = z.object({
  sobject_type: z.string().optional().describe("Filter by specific SObject type"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_record_shares",
      title: "List Record Shares",
      description: "List sharing records for a Salesforce SObject type (AccountShare, CaseShare, OpportunityShare, etc.). Shows who has access to which records, access levels, and row causes (Manual, Rule, Owner).",
      inputSchema: {
        type: "object",
        properties: {
          sobject_type: { type: "string", description: "SObject type (e.g. 'Account', 'Case') — auto-mapped to Share table" },
          record_id: { type: "string", description: "Filter by specific record ID" },
          user_or_group_id: { type: "string", description: "Filter by user or group ID" },
          access_level: { type: "string", description: "Filter by access level (Read/Edit/All)" },
          row_cause: { type: "string", description: "Filter by row cause (Manual/Rule/Owner)" },
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
        },
        required: ["sobject_type"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_record_share",
      title: "Create Record Share (Manual Share)",
      description: "Manually share a Salesforce record with a user or group by creating a Share record (AccountShare, CaseShare, etc.). This grants the specified user/group Read, Edit, or Full Control (All) access.",
      inputSchema: {
        type: "object",
        properties: {
          sobject_type: { type: "string", description: "SObject type (e.g. 'Account')" },
          record_id: { type: "string", description: "Record ID to share (required)" },
          user_or_group_id: { type: "string", description: "User or Group ID to share with (required)" },
          access_level: { type: "string", enum: ["Read", "Edit", "All"], description: "Access level (required)" },
        },
        required: ["sobject_type", "record_id", "user_or_group_id", "access_level"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "delete_record_share",
      title: "Delete Record Share",
      description: "Remove a manual share on a Salesforce record by deleting the Share record. Note: Only Manual shares (RowCause = 'Manual') can be deleted via REST API.",
      inputSchema: {
        type: "object",
        properties: {
          sobject_type: { type: "string", description: "SObject type (e.g. 'Account')" },
          share_id: { type: "string", description: "Share record ID to delete (required)" },
        },
        required: ["sobject_type", "share_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "get_record_access",
      title: "Get Record Access for User",
      description: "Check what access a specific user has to a specific Salesforce record using the UserRecordAccess object. Returns hasReadAccess, hasEditAccess, hasDeleteAccess, etc.",
      inputSchema: {
        type: "object",
        properties: {
          sobject_type: { type: "string", description: "SObject type (e.g. 'Account')" },
          record_id: { type: "string", description: "Record ID to check (required)" },
          user_id: { type: "string", description: "User ID to check access for (required)" },
        },
        required: ["sobject_type", "record_id", "user_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "list_org_wide_defaults",
      title: "List Org-Wide Defaults",
      description: "List Salesforce Org-Wide Sharing Defaults (OWDs) for all or a specific SObject. Shows the default internal and external access levels set at the org level.",
      inputSchema: {
        type: "object",
        properties: {
          sobject_type: { type: "string", description: "Filter by specific SObject type (optional)" },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function buildShareObjectName(sobjectType: string): string {
  // Standard share objects follow <SObjectName>Share pattern
  // Some exceptions: Lead doesn't have LeadShare (it uses owner only)
  const shareMap: Record<string, string> = {
    Account: "AccountShare",
    Case: "CaseShare",
    Contact: "ContactShare",
    Lead: "LeadShare",
    Opportunity: "OpportunityShare",
    Campaign: "CampaignShare",
    Order: "OrderShare",
    Contract: "ContractShare",
    Asset: "AssetShare",
    User: "UserShare",
  };
  return shareMap[sobjectType] || `${sobjectType}Share`;
}

function buildAccessFieldName(sobjectType: string): string {
  const accessMap: Record<string, string> = {
    Account: "AccountAccessLevel",
    Case: "CaseAccessLevel",
    Contact: "ContactAccessLevel",
    Lead: "LeadAccessLevel",
    Opportunity: "OpportunityAccessLevel",
    Campaign: "CampaignAccessLevel",
    Order: "OrderAccessLevel",
    Contract: "ContractAccessLevel",
  };
  return accessMap[sobjectType] || `${sobjectType}AccessLevel`;
}

function buildRecordIdFieldName(sobjectType: string): string {
  return `${sobjectType}Id`;
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_record_shares: async (args) => {
      const params = ListSharesSchema.parse(args);
      const shareObj = buildShareObjectName(params.sobject_type);
      const recordIdField = buildRecordIdFieldName(params.sobject_type);
      const accessField = buildAccessFieldName(params.sobject_type);

      const conditions: string[] = [];
      if (params.record_id) conditions.push(`${recordIdField} = '${params.record_id}'`);
      if (params.user_or_group_id) conditions.push(`UserOrGroupId = '${params.user_or_group_id}'`);
      if (params.access_level) conditions.push(`${accessField} = '${params.access_level}'`);
      if (params.row_cause) conditions.push(`RowCause = '${params.row_cause}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,${recordIdField},UserOrGroupId,${accessField},RowCause FROM ${shareObj} ${where} LIMIT ${params.limit} OFFSET ${params.offset}`;

      const result = await logger.time("tool.list_record_shares", () =>
        client.query<Record<string, unknown>>(soql), {}
      );

      const response = {
        sobjectType: params.sobject_type,
        shareObject: shareObj,
        records: result.records.map((r) => ({
          id: r["Id"],
          recordId: r[recordIdField],
          userOrGroupId: r["UserOrGroupId"],
          accessLevel: r[accessField],
          rowCause: r["RowCause"],
        })),
        meta: { total: result.totalSize, returned: result.records.length, hasMore: result.records.length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    create_record_share: async (args) => {
      const params = CreateShareSchema.parse(args);
      const shareObj = buildShareObjectName(params.sobject_type);
      const recordIdField = buildRecordIdFieldName(params.sobject_type);
      const accessField = buildAccessFieldName(params.sobject_type);

      const payload: Record<string, unknown> = {
        [recordIdField]: params.record_id,
        UserOrGroupId: params.user_or_group_id,
        [accessField]: params.access_level,
      };

      const result = await logger.time("tool.create_record_share", () =>
        client.post<{ id: string; success: boolean; errors: unknown[] }>(`/sobjects/${shareObj}`, payload), {}
      );

      const response = {
        success: result.success,
        shareId: result.id,
        sobjectType: params.sobject_type,
        recordId: params.record_id,
        userOrGroupId: params.user_or_group_id,
        accessLevel: params.access_level,
        errors: result.errors,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    delete_record_share: async (args) => {
      const params = DeleteShareSchema.parse(args);
      const shareObj = buildShareObjectName(params.sobject_type);

      await logger.time("tool.delete_record_share", () =>
        client.delete(`/sobjects/${shareObj}/${params.share_id}`), {}
      );

      const response = { success: true, shareId: params.share_id, sobjectType: params.sobject_type, deleted: true };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_record_access: async (args) => {
      const params = GetRecordAccessSchema.parse(args);
      const soql = `SELECT RecordId,HasReadAccess,HasEditAccess,HasDeleteAccess,HasTransferAccess,MaxAccessLevel FROM UserRecordAccess WHERE UserId = '${params.user_id}' AND RecordId = '${params.record_id}'`;

      const result = await logger.time("tool.get_record_access", () =>
        client.query<Record<string, unknown>>(soql), {}
      );

      const access = (result.records || [])[0] as Record<string, unknown> | undefined;
      const response = {
        userId: params.user_id,
        recordId: params.record_id,
        sobjectType: params.sobject_type,
        hasReadAccess: access?.["HasReadAccess"] ?? false,
        hasEditAccess: access?.["HasEditAccess"] ?? false,
        hasDeleteAccess: access?.["HasDeleteAccess"] ?? false,
        hasTransferAccess: access?.["HasTransferAccess"] ?? false,
        maxAccessLevel: access?.["MaxAccessLevel"] ?? "None",
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    list_org_wide_defaults: async (args) => {
      const params = ListOrgWideDefaultsSchema.parse(args);
      const conditions: string[] = [];
      if (params.sobject_type) conditions.push(`SobjectType = '${params.sobject_type}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT SobjectType,DefaultAccess,DefaultAccessForGuest,InternalSharingModel,ExternalSharingModel FROM EntityDefinition ${where} ORDER BY SobjectType ASC LIMIT 200`;

      const result = await logger.time("tool.list_org_wide_defaults", () =>
        client.query<Record<string, unknown>>(soql), {}
      );

      const response = {
        orgWideDefaults: result.records.map((r) => ({
          sobjectType: r["SobjectType"],
          internalSharingModel: r["InternalSharingModel"],
          externalSharingModel: r["ExternalSharingModel"],
          defaultAccess: r["DefaultAccess"],
        })).filter((r) => r.internalSharingModel),
        meta: { total: result.totalSize },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
