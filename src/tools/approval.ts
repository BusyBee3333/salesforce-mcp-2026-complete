// Approval tool group — Salesforce Approval Processes via /process/approvals/
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListApprovalProcessesSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  object_type: z.string().optional().describe("Filter by SObject type (e.g. 'Opportunity', 'Quote')"),
});

const SubmitForApprovalSchema = z.object({
  record_id: z.string().describe("ID of the record to submit for approval (required)"),
  process_definition_name_or_id: z.string().optional().describe("API name or ID of the approval process. If omitted, Salesforce selects the active process automatically."),
  submitter_id: z.string().optional().describe("Submitter User ID (defaults to current user)"),
  comments: z.string().optional().describe("Submission comments"),
  next_approver_ids: z.array(z.string()).optional().describe("Override next approver User IDs (if allowed by the process)"),
});

const ApproveRecordSchema = z.object({
  work_item_id: z.string().describe("ProcessInstanceWorkitem ID (the pending approval item ID, required)"),
  comments: z.string().optional().describe("Approval comments"),
  next_approver_ids: z.array(z.string()).optional().describe("Override next approver IDs"),
});

const RejectRecordSchema = z.object({
  work_item_id: z.string().describe("ProcessInstanceWorkitem ID (the pending approval item ID, required)"),
  comments: z.string().optional().describe("Rejection comments (strongly recommended)"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_approval_processes",
      title: "List Approval Processes",
      description: "List configured Salesforce approval processes via /process/approvals/. Returns process names, object types, entry criteria, and active status. Optionally filter by SObject type.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          object_type: { type: "string", description: "Filter by SObject type (e.g. 'Opportunity')" },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "submit_for_approval",
      title: "Submit Record for Approval",
      description: "Submit a Salesforce record for approval using the Process Approvals REST API. Works on any object that has an active approval process. Returns the new ProcessInstance ID.",
      inputSchema: {
        type: "object",
        properties: {
          record_id: { type: "string", description: "Record ID to submit for approval (required)" },
          process_definition_name_or_id: { type: "string", description: "Approval process name or ID (optional — auto-selected if omitted)" },
          submitter_id: { type: "string", description: "Submitter User ID (defaults to current user)" },
          comments: { type: "string", description: "Submission comments" },
          next_approver_ids: { type: "array", items: { type: "string" }, description: "Override next approver IDs" },
        },
        required: ["record_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "approve_record",
      title: "Approve Record",
      description: "Approve a pending approval request by providing the ProcessInstanceWorkitem ID. Optionally add comments or override next approvers.",
      inputSchema: {
        type: "object",
        properties: {
          work_item_id: { type: "string", description: "ProcessInstanceWorkitem ID (required)" },
          comments: { type: "string", description: "Approval comments" },
          next_approver_ids: { type: "array", items: { type: "string" }, description: "Override next approver IDs" },
        },
        required: ["work_item_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "reject_record",
      title: "Reject Record",
      description: "Reject a pending approval request by providing the ProcessInstanceWorkitem ID. Comments are strongly recommended for audit trail.",
      inputSchema: {
        type: "object",
        properties: {
          work_item_id: { type: "string", description: "ProcessInstanceWorkitem ID (required)" },
          comments: { type: "string", description: "Rejection comments (recommended)" },
        },
        required: ["work_item_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_approval_processes: async (args) => {
      const params = ListApprovalProcessesSchema.parse(args);

      const result = await logger.time("tool.list_approval_processes", () =>
        client.get<{ approvals: Record<string, unknown[]> }>("/process/approvals/"), {}
      );

      // The response is { approvals: { ObjectType: [processes...] } }
      const approvalsMap = result["approvals"] || {};
      let allProcesses: Record<string, unknown>[] = [];

      for (const [objectType, processes] of Object.entries(approvalsMap)) {
        if (params.object_type && objectType !== params.object_type) continue;
        for (const proc of processes as Record<string, unknown>[]) {
          allProcesses.push({ objectType, ...proc });
        }
      }

      // Apply pagination
      const total = allProcesses.length;
      allProcesses = allProcesses.slice(params.offset, params.offset + params.limit);

      const response = {
        records: allProcesses.map((p) => ({
          objectType: p["objectType"],
          id: p["id"],
          name: p["name"],
          description: p["description"],
          sortOrder: p["sortOrder"],
        })),
        meta: {
          total,
          returned: allProcesses.length,
          hasMore: params.offset + allProcesses.length < total,
          offset: params.offset,
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    submit_for_approval: async (args) => {
      const params = SubmitForApprovalSchema.parse(args);

      const requestBody: Record<string, unknown> = {
        actionType: "Submit",
        contextId: params.record_id,
      };

      if (params.comments) requestBody["comments"] = params.comments;
      if (params.submitter_id) requestBody["submitterId"] = params.submitter_id;
      if (params.process_definition_name_or_id) {
        requestBody["processDefinitionNameOrId"] = params.process_definition_name_or_id;
      }
      if (params.next_approver_ids && params.next_approver_ids.length > 0) {
        requestBody["nextApproverIds"] = params.next_approver_ids;
      }

      const result = await logger.time("tool.submit_for_approval", () =>
        client.post<{ instanceId: string; newWorkitemIds: string[]; success: boolean; errors: unknown[] }[]>(
          "/process/approvals/",
          [requestBody]
        ), {}
      );

      const first = Array.isArray(result) ? result[0] : result;
      const response = {
        success: (first as Record<string, unknown>)["success"] ?? true,
        instanceId: (first as Record<string, unknown>)["instanceId"],
        newWorkitemIds: (first as Record<string, unknown>)["newWorkitemIds"],
        errors: (first as Record<string, unknown>)["errors"],
        record_id: params.record_id,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    approve_record: async (args) => {
      const params = ApproveRecordSchema.parse(args);

      const requestBody: Record<string, unknown> = {
        actionType: "Approve",
        contextId: params.work_item_id,
      };

      if (params.comments) requestBody["comments"] = params.comments;
      if (params.next_approver_ids && params.next_approver_ids.length > 0) {
        requestBody["nextApproverIds"] = params.next_approver_ids;
      }

      const result = await logger.time("tool.approve_record", () =>
        client.post<{ instanceStatus: string; success: boolean; errors: unknown[] }[]>(
          "/process/approvals/",
          [requestBody]
        ), {}
      );

      const first = Array.isArray(result) ? result[0] : result;
      const response = {
        success: (first as Record<string, unknown>)["success"] ?? true,
        instanceStatus: (first as Record<string, unknown>)["instanceStatus"],
        workItemId: params.work_item_id,
        errors: (first as Record<string, unknown>)["errors"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    reject_record: async (args) => {
      const params = RejectRecordSchema.parse(args);

      const requestBody: Record<string, unknown> = {
        actionType: "Reject",
        contextId: params.work_item_id,
      };

      if (params.comments) requestBody["comments"] = params.comments;

      const result = await logger.time("tool.reject_record", () =>
        client.post<{ instanceStatus: string; success: boolean; errors: unknown[] }[]>(
          "/process/approvals/",
          [requestBody]
        ), {}
      );

      const first = Array.isArray(result) ? result[0] : result;
      const response = {
        success: (first as Record<string, unknown>)["success"] ?? true,
        instanceStatus: (first as Record<string, unknown>)["instanceStatus"],
        workItemId: params.work_item_id,
        errors: (first as Record<string, unknown>)["errors"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
