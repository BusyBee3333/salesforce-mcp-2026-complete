// Bulk API v2 tool group — Salesforce Bulk API 2.0 for large data operations
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const CreateBulkJobSchema = z.object({
  object: z.string().describe("Salesforce SObject API name (e.g. 'Account', 'Contact')"),
  operation: z.enum(["insert", "update", "upsert", "delete", "hardDelete"]).describe("Bulk operation type"),
  external_id_field: z.string().optional().describe("External ID field name (required for upsert)"),
  column_delimiter: z.enum(["BACKQUOTE", "CARET", "COMMA", "PIPE", "SEMICOLON", "TAB"]).optional().default("COMMA"),
  line_ending: z.enum(["LF", "CRLF"]).optional().default("LF"),
  assignment_rule_id: z.string().optional().describe("Assignment rule ID to apply"),
});

const GetBulkJobSchema = z.object({
  job_id: z.string().describe("Bulk API v2 job ID"),
});

const ListBulkJobsSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  next_url: z.string().optional().describe("Pagination URL from previous response"),
  is_pk_chunking_supported: z.boolean().optional(),
  job_type: z.enum(["BigObjectIngest", "Classic", "V2Ingest"]).optional(),
  query_locator: z.string().optional(),
  state: z.enum(["Open", "UploadComplete", "InProgress", "Aborted", "JobComplete", "Failed"]).optional(),
});

const CloseBulkJobSchema = z.object({
  job_id: z.string().describe("Bulk API v2 job ID to close/abort"),
  state: z.enum(["UploadComplete", "Aborted"]).describe("'UploadComplete' to trigger processing, 'Aborted' to cancel"),
});

const GetBulkJobResultsSchema = z.object({
  job_id: z.string().describe("Bulk API v2 job ID"),
  result_type: z.enum(["successfulResults", "failedResults", "unprocessedrecords"]).optional().default("successfulResults"),
  max_records: z.number().min(1).max(10000).optional().default(1000),
  locator: z.string().optional().describe("Pagination locator from previous response"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "create_bulk_job",
      title: "Create Bulk API Job",
      description: "Create a new Salesforce Bulk API v2 ingest job for insert, update, upsert, delete, or hardDelete operations on any SObject. Returns a job ID to upload data to.",
      inputSchema: {
        type: "object",
        properties: {
          object: { type: "string", description: "SObject API name (e.g. 'Account')" },
          operation: { type: "string", enum: ["insert", "update", "upsert", "delete", "hardDelete"] },
          external_id_field: { type: "string", description: "External ID field (required for upsert)" },
          column_delimiter: { type: "string", enum: ["BACKQUOTE", "CARET", "COMMA", "PIPE", "SEMICOLON", "TAB"] },
          line_ending: { type: "string", enum: ["LF", "CRLF"] },
          assignment_rule_id: { type: "string", description: "Assignment rule ID" },
        },
        required: ["object", "operation"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "get_bulk_job",
      title: "Get Bulk Job Status",
      description: "Get the current status and details of a Salesforce Bulk API v2 job. Returns state, number of records processed, success count, failed count, and job metadata.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Bulk API v2 job ID (required)" },
        },
        required: ["job_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "list_bulk_jobs",
      title: "List Bulk Jobs",
      description: "List Salesforce Bulk API v2 ingest jobs in the org. Filter by state or job type. Returns job IDs, object, operation, state, and record counts.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          next_url: { type: "string", description: "Pagination URL from previous response" },
          job_type: { type: "string", enum: ["BigObjectIngest", "Classic", "V2Ingest"] },
          state: { type: "string", enum: ["Open", "UploadComplete", "InProgress", "Aborted", "JobComplete", "Failed"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "close_bulk_job",
      title: "Close or Abort Bulk Job",
      description: "Close a Bulk API v2 job to begin processing (state='UploadComplete'), or abort it to cancel (state='Aborted').",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Bulk API v2 job ID (required)" },
          state: { type: "string", enum: ["UploadComplete", "Aborted"], description: "'UploadComplete' to process, 'Aborted' to cancel" },
        },
        required: ["job_id", "state"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_bulk_job_results",
      title: "Get Bulk Job Results",
      description: "Retrieve the results of a completed Salesforce Bulk API v2 job: successful records, failed records, or unprocessed records. Supports pagination via locator.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Bulk API v2 job ID (required)" },
          result_type: { type: "string", enum: ["successfulResults", "failedResults", "unprocessedrecords"], description: "Type of results to retrieve (default: successfulResults)" },
          max_records: { type: "number", description: "Max records to return (default 1000, max 10000)" },
          locator: { type: "string", description: "Pagination locator" },
        },
        required: ["job_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    create_bulk_job: async (args) => {
      const params = CreateBulkJobSchema.parse(args);
      const body: Record<string, unknown> = {
        object: params.object,
        operation: params.operation,
        contentType: "CSV",
        columnDelimiter: params.column_delimiter,
        lineEnding: params.line_ending,
      };
      if (params.external_id_field) body["externalIdFieldName"] = params.external_id_field;
      if (params.assignment_rule_id) body["assignmentRuleId"] = params.assignment_rule_id;

      const result = await logger.time("tool.create_bulk_job", () =>
        client.post<Record<string, unknown>>("/jobs/ingest", body), {}
      );

      const response = {
        jobId: result["id"],
        state: result["state"],
        object: result["object"],
        operation: result["operation"],
        contentType: result["contentType"],
        apiVersion: result["apiVersion"],
        createdDate: result["createdDate"],
        systemModstamp: result["systemModstamp"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_bulk_job: async (args) => {
      const { job_id } = GetBulkJobSchema.parse(args);
      const result = await logger.time("tool.get_bulk_job", () =>
        client.get<Record<string, unknown>>(`/jobs/ingest/${job_id}`), {}
      );

      const response = {
        jobId: result["id"],
        state: result["state"],
        object: result["object"],
        operation: result["operation"],
        numberRecordsProcessed: result["numberRecordsProcessed"],
        numberRecordsFailed: result["numberRecordsFailed"],
        totalProcessingTime: result["totalProcessingTime"],
        apiActiveProcessingTime: result["apiActiveProcessingTime"],
        apexProcessingTime: result["apexProcessingTime"],
        createdDate: result["createdDate"],
        systemModstamp: result["systemModstamp"],
        jobType: result["jobType"],
        errorMessage: result["errorMessage"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    list_bulk_jobs: async (args) => {
      const params = ListBulkJobsSchema.parse(args);
      let endpoint = `/jobs/ingest?maxRecords=${params.limit}`;
      if (params.job_type) endpoint += `&jobType=${params.job_type}`;
      if (params.state) endpoint += `&queryLocator=${params.state}`;
      if (params.next_url) endpoint = params.next_url.replace(/.*\/services\/data\/v\d+\.\d+/, "");

      const result = await logger.time("tool.list_bulk_jobs", () =>
        client.get<{ records: Record<string, unknown>[]; done: boolean; nextRecordsUrl?: string }>(`${endpoint}`), {}
      );

      const response = {
        records: (result.records || []).map((r) => ({
          jobId: r["id"],
          state: r["state"],
          object: r["object"],
          operation: r["operation"],
          numberRecordsProcessed: r["numberRecordsProcessed"],
          numberRecordsFailed: r["numberRecordsFailed"],
          createdDate: r["createdDate"],
          systemModstamp: r["systemModstamp"],
        })),
        done: result.done,
        nextRecordsUrl: result.nextRecordsUrl,
        hasMore: !result.done,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    close_bulk_job: async (args) => {
      const params = CloseBulkJobSchema.parse(args);
      const result = await logger.time("tool.close_bulk_job", () =>
        client.patch<Record<string, unknown>>(`/jobs/ingest/${params.job_id}`, { state: params.state }), {}
      );

      const response = {
        success: true,
        jobId: params.job_id,
        state: result["state"] || params.state,
        systemModstamp: result["systemModstamp"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_bulk_job_results: async (args) => {
      const params = GetBulkJobResultsSchema.parse(args);
      let endpoint = `/jobs/ingest/${params.job_id}/${params.result_type}?maxRecords=${params.max_records}`;
      if (params.locator) endpoint += `&locator=${encodeURIComponent(params.locator)}`;

      const result = await logger.time("tool.get_bulk_job_results", () =>
        client.get<string>(endpoint), {}
      );

      // Results come back as CSV text
      const csvText = typeof result === "string" ? result : JSON.stringify(result);
      const lines = csvText.trim().split("\n");
      const headers = lines[0] ? lines[0].split(",") : [];
      const records = lines.slice(1).map((line) => {
        const values = line.split(",");
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => { obj[h.trim()] = (values[i] || "").trim(); });
        return obj;
      });

      const response = {
        jobId: params.job_id,
        resultType: params.result_type,
        records,
        count: records.length,
        hasMore: records.length === params.max_records,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
