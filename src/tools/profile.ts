// Profile tool group — Salesforce Profile management
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListProfilesSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  name_filter: z.string().optional().describe("Filter by profile name (case-insensitive substring)"),
  user_license: z.string().optional().describe("Filter by user license name (e.g. 'Salesforce', 'Force.com - App Subscription')"),
  order_by: z.enum(["Name", "CreatedDate", "LastModifiedDate"]).optional().default("Name"),
});

const GetProfileSchema = z.object({
  profile_id: z.string().describe("Profile ID"),
  include_users: z.boolean().optional().default(false).describe("Include users assigned to this profile"),
});

const UpdateProfileSchema = z.object({
  profile_id: z.string().describe("Profile ID to update"),
  description: z.string().optional().describe("Profile description"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_profiles",
      title: "List Profiles",
      description: "List Salesforce Profiles in the org. Returns profile names, user license types, and descriptions. Filter by name or user license type.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          name_filter: { type: "string", description: "Filter by profile name substring" },
          user_license: { type: "string", description: "Filter by user license name" },
          order_by: { type: "string", enum: ["Name", "CreatedDate", "LastModifiedDate"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_profile",
      title: "Get Profile",
      description: "Get full details for a Salesforce Profile by ID including user license, login hours, and IP ranges. Optionally include users assigned to this profile.",
      inputSchema: {
        type: "object",
        properties: {
          profile_id: { type: "string", description: "Profile ID (required)" },
          include_users: { type: "boolean", description: "Include users assigned to this profile (default false)" },
        },
        required: ["profile_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "update_profile",
      title: "Update Profile",
      description: "Update a Salesforce Profile. Note: Profiles have limited editable fields via REST API — description is the primary one. Use Metadata API for full profile management.",
      inputSchema: {
        type: "object",
        properties: {
          profile_id: { type: "string", description: "Profile ID (required)" },
          description: { type: "string", description: "Profile description" },
        },
        required: ["profile_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_profiles: async (args) => {
      const params = ListProfilesSchema.parse(args);
      const conditions: string[] = [];
      if (params.name_filter) conditions.push(`Name LIKE '%${params.name_filter.replace(/'/g, "\\'")}%'`);
      if (params.user_license) conditions.push(`UserLicense.Name = '${params.user_license.replace(/'/g, "\\'")}'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,Name,Description,UserLicenseId,UserLicense.Name,CreatedDate,LastModifiedDate FROM Profile ${where} ORDER BY ${params.order_by} ASC LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM Profile ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_profiles", () => client.query<Record<string, unknown>>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => {
          const license = r["UserLicense"] as Record<string, unknown> | undefined;
          return {
            id: r["Id"],
            name: r["Name"],
            description: r["Description"],
            userLicenseId: r["UserLicenseId"],
            userLicenseName: license?.["Name"],
            createdDate: r["CreatedDate"],
            lastModifiedDate: r["LastModifiedDate"],
          };
        }),
        meta: { total: countResult.totalSize, returned: result.records.length, hasMore: result.records.length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_profile: async (args) => {
      const params = GetProfileSchema.parse(args);
      const promises: Promise<unknown>[] = [
        client.get<Record<string, unknown>>(`/sobjects/Profile/${params.profile_id}`),
      ];
      if (params.include_users) {
        promises.push(client.query<Record<string, unknown>>(`SELECT Id,Name,Username,Email FROM User WHERE ProfileId = '${params.profile_id}' LIMIT 50`));
      }

      const results = await Promise.all(promises);
      const profile = results[0] as Record<string, unknown>;

      const response: Record<string, unknown> = {
        id: profile["Id"],
        name: profile["Name"],
        description: profile["Description"],
        userLicenseId: profile["UserLicenseId"],
        createdDate: profile["CreatedDate"],
        lastModifiedDate: profile["LastModifiedDate"],
        loginIpRanges: profile["LoginIpRanges"],
      };

      if (params.include_users) {
        const userResult = results[1] as { records: unknown[]; totalSize: number };
        response.users = userResult.records;
        response.userCount = userResult.totalSize;
      }

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    update_profile: async (args) => {
      const { profile_id, ...updates } = UpdateProfileSchema.parse(args);
      const payload: Record<string, unknown> = {};
      if (updates.description !== undefined) payload["Description"] = updates.description;

      await logger.time("tool.update_profile", () =>
        client.patch(`/sobjects/Profile/${profile_id}`, payload), {}
      );

      const response = { success: true, profile_id };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
