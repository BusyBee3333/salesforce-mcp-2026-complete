// Tooling tool group — Salesforce Tooling API for metadata, test execution, and code coverage
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const RunApexTestsSchema = z.object({
  class_ids: z.array(z.string()).optional().describe("Array of ApexClass IDs to run tests for"),
  class_names: z.array(z.string()).optional().describe("Array of Apex test class names to run"),
  test_level: z.enum(["RunLocalTests", "RunAllTestsInOrg", "RunSpecifiedTests"]).optional().default("RunSpecifiedTests"),
  skip_code_coverage: z.boolean().optional().default(false),
  max_failed_tests: z.number().optional().describe("Max number of failures before stopping (-1 = unlimited)"),
});

const GetTestRunSchema = z.object({
  test_run_id: z.string().describe("Apex test run ID (AsyncApexJob ID)"),
  include_test_results: z.boolean().optional().default(false),
});

const GetCodeCoverageSchema = z.object({
  class_id: z.string().optional().describe("ApexClass ID to get coverage for (omit for all)"),
  limit: z.number().min(1).max(200).optional().default(50),
  offset: z.number().min(0).optional().default(0),
});

const ListApexTriggersSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  name_filter: z.string().optional(),
  sobject_type: z.string().optional().describe("Filter by SObject type (e.g. 'Account')"),
  status: z.enum(["Active", "Inactive"]).optional(),
});

const QueryToolingSchema = z.object({
  soql: z.string().describe("SOQL query against Tooling API objects (e.g. 'SELECT Id,Name FROM ApexClass LIMIT 10')"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "run_apex_tests",
      title: "Run Apex Tests",
      description: "Execute Apex unit tests in the org via the Tooling API. Can run specific test classes or all local tests. Returns the async test run ID for polling status.",
      inputSchema: {
        type: "object",
        properties: {
          class_ids: { type: "array", items: { type: "string" }, description: "ApexClass IDs to run" },
          class_names: { type: "array", items: { type: "string" }, description: "Test class names to run" },
          test_level: { type: "string", enum: ["RunLocalTests", "RunAllTestsInOrg", "RunSpecifiedTests"] },
          skip_code_coverage: { type: "boolean", description: "Skip code coverage calculation" },
          max_failed_tests: { type: "number", description: "Max failures before stopping" },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "get_test_run_status",
      title: "Get Apex Test Run Status",
      description: "Poll the status of an Apex test run by its async job ID. Returns pass/fail counts, duration, and optionally detailed test method results.",
      inputSchema: {
        type: "object",
        properties: {
          test_run_id: { type: "string", description: "Apex test run ID (required)" },
          include_test_results: { type: "boolean", description: "Include per-method test results (default false)" },
        },
        required: ["test_run_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_code_coverage",
      title: "Get Apex Code Coverage",
      description: "Retrieve Apex code coverage results from the most recent test run. Returns line coverage percentages by class.",
      inputSchema: {
        type: "object",
        properties: {
          class_id: { type: "string", description: "Specific ApexClass ID (omit for all)" },
          limit: { type: "number", description: "Max records (default 50)" },
          offset: { type: "number", description: "Pagination offset" },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "list_apex_triggers",
      title: "List Apex Triggers",
      description: "List Apex Triggers in the org via the Tooling API. Filter by name, SObject type, or status (Active/Inactive).",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          name_filter: { type: "string", description: "Filter by trigger name" },
          sobject_type: { type: "string", description: "Filter by SObject type" },
          status: { type: "string", enum: ["Active", "Inactive"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "tooling_query",
      title: "Tooling API Query",
      description: "Execute a SOQL query against Salesforce Tooling API objects (ApexClass, ApexTrigger, ApexLog, ValidationRule, WorkflowRule, CustomObject, FieldDefinition, etc.). Use for metadata discovery.",
      inputSchema: {
        type: "object",
        properties: {
          soql: { type: "string", description: "SOQL query against Tooling API objects" },
        },
        required: ["soql"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    run_apex_tests: async (args) => {
      const params = RunApexTestsSchema.parse(args);
      const body: Record<string, unknown> = {
        testLevel: params.test_level,
        skipCodeCoverage: params.skip_code_coverage,
      };

      if (params.class_ids && params.class_ids.length > 0) {
        body["classids"] = params.class_ids.join(",");
      }
      if (params.class_names && params.class_names.length > 0) {
        body["classnames"] = params.class_names.join(",");
      }
      if (params.max_failed_tests !== undefined) {
        body["maxFailedTests"] = params.max_failed_tests;
      }

      const result = await logger.time("tool.run_apex_tests", () =>
        client.post<{ testRunId: string }>("/tooling/runTestsAsynchronous/", body), {}
      );

      const response = {
        testRunId: result.testRunId || (result as Record<string, unknown>)["id"],
        testLevel: params.test_level,
        message: "Test run started. Poll get_test_run_status with the testRunId.",
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_test_run_status: async (args) => {
      const params = GetTestRunSchema.parse(args);
      const soql = `SELECT Id,Status,StartTime,EndTime,TestTime,MethodsEnqueued,MethodsCompleted,MethodsFailed FROM ApexTestRunResult WHERE AsyncApexJobId = '${params.test_run_id}'`;

      const result = await logger.time("tool.get_test_run_status", () =>
        client.get<{ records: Record<string, unknown>[]; totalSize: number }>(
          `/tooling/query/?q=${encodeURIComponent(soql)}`
        ), {}
      );

      const runResult = (result.records || [])[0] as Record<string, unknown> | undefined;

      const response: Record<string, unknown> = {
        testRunId: params.test_run_id,
        status: runResult?.["Status"],
        startTime: runResult?.["StartTime"],
        endTime: runResult?.["EndTime"],
        testTime: runResult?.["TestTime"],
        methodsEnqueued: runResult?.["MethodsEnqueued"],
        methodsCompleted: runResult?.["MethodsCompleted"],
        methodsFailed: runResult?.["MethodsFailed"],
      };

      if (params.include_test_results) {
        const resSoql = `SELECT Id,Outcome,ApexClass.Name,MethodName,Message,StackTrace,RunTime FROM ApexTestResult WHERE AsyncApexJobId = '${params.test_run_id}' LIMIT 200`;
        const testResults = await client.get<{ records: Record<string, unknown>[] }>(
          `/tooling/query/?q=${encodeURIComponent(resSoql)}`
        );
        response.testResults = (testResults.records || []).map((r) => {
          const cls = r["ApexClass"] as Record<string, unknown> | undefined;
          return {
            id: r["Id"],
            outcome: r["Outcome"],
            className: cls?.["Name"],
            methodName: r["MethodName"],
            message: r["Message"],
            stackTrace: r["StackTrace"],
            runTime: r["RunTime"],
          };
        });
      }

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_code_coverage: async (args) => {
      const params = GetCodeCoverageSchema.parse(args);
      const conditions = params.class_id ? `WHERE ApexClassOrTriggerId = '${params.class_id}'` : "";
      const soql = `SELECT ApexClassOrTriggerId,ApexClassOrTrigger.Name,NumLinesCovered,NumLinesUncovered FROM ApexCodeCoverageAggregate ${conditions} ORDER BY NumLinesCovered DESC LIMIT ${params.limit} OFFSET ${params.offset}`;

      const result = await logger.time("tool.get_code_coverage", () =>
        client.get<{ records: Record<string, unknown>[]; totalSize: number }>(
          `/tooling/query/?q=${encodeURIComponent(soql)}`
        ), {}
      );

      const response = {
        records: (result.records || []).map((r) => {
          const cls = r["ApexClassOrTrigger"] as Record<string, unknown> | undefined;
          const covered = Number(r["NumLinesCovered"] || 0);
          const uncovered = Number(r["NumLinesUncovered"] || 0);
          const total = covered + uncovered;
          return {
            classId: r["ApexClassOrTriggerId"],
            className: cls?.["Name"],
            linesCovered: covered,
            linesUncovered: uncovered,
            totalLines: total,
            coveragePercent: total > 0 ? Math.round((covered / total) * 100) : 0,
          };
        }),
        meta: { total: result.totalSize, returned: (result.records || []).length, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    list_apex_triggers: async (args) => {
      const params = ListApexTriggersSchema.parse(args);
      const conditions: string[] = [];
      if (params.name_filter) conditions.push(`Name LIKE '%${params.name_filter.replace(/'/g, "\\'")}%'`);
      if (params.sobject_type) conditions.push(`TableEnumOrId = '${params.sobject_type}'`);
      if (params.status) conditions.push(`Status = '${params.status}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,Name,TableEnumOrId,Status,ApiVersion,LengthWithoutComments,CreatedDate,LastModifiedDate FROM ApexTrigger ${where} ORDER BY Name ASC LIMIT ${params.limit} OFFSET ${params.offset}`;

      const result = await logger.time("tool.list_apex_triggers", () =>
        client.get<{ records: Record<string, unknown>[]; totalSize: number }>(
          `/tooling/query/?q=${encodeURIComponent(soql)}`
        ), {}
      );

      const response = {
        records: (result.records || []).map((r) => ({
          id: r["Id"],
          name: r["Name"],
          sobjectType: r["TableEnumOrId"],
          status: r["Status"],
          apiVersion: r["ApiVersion"],
          lengthWithoutComments: r["LengthWithoutComments"],
          createdDate: r["CreatedDate"],
          lastModifiedDate: r["LastModifiedDate"],
        })),
        meta: { total: result.totalSize, returned: (result.records || []).length, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    tooling_query: async (args) => {
      const { soql } = QueryToolingSchema.parse(args);
      const result = await logger.time("tool.tooling_query", () =>
        client.get<{ records: unknown[]; totalSize: number; done: boolean }>(
          `/tooling/query/?q=${encodeURIComponent(soql)}`
        ), {}
      );

      const response = {
        records: result.records || [],
        meta: {
          total: result.totalSize,
          returned: (result.records || []).length,
          done: result.done,
        },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
