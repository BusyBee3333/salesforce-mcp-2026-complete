// Email Message tool group — Salesforce EmailMessage CRUD and send
import { z } from "zod";
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

const ListEmailMessagesSchema = z.object({
  limit: z.number().min(1).max(200).optional().default(25),
  offset: z.number().min(0).optional().default(0),
  parent_id: z.string().optional().describe("Filter by parent case ID"),
  status: z.enum(["0", "1", "2", "3"]).optional().describe("0=New, 1=Read, 2=Replied, 3=Sent"),
  from_address: z.string().optional().describe("Filter by sender email address"),
  to_address: z.string().optional().describe("Filter by recipient email address"),
  order_by: z.enum(["MessageDate", "CreatedDate", "Subject"]).optional().default("MessageDate"),
  order_dir: z.enum(["ASC", "DESC"]).optional().default("DESC"),
});

const GetEmailMessageSchema = z.object({
  email_message_id: z.string().describe("EmailMessage ID"),
});

const SendEmailSchema = z.object({
  subject: z.string().describe("Email subject (required)"),
  html_body: z.string().optional().describe("HTML body content"),
  plain_text_body: z.string().optional().describe("Plain text body content"),
  to_addresses: z.array(z.string()).min(1).describe("Recipient email addresses (required)"),
  cc_addresses: z.array(z.string()).optional().describe("CC email addresses"),
  bcc_addresses: z.array(z.string()).optional().describe("BCC email addresses"),
  target_object_id: z.string().optional().describe("Target object ID (Contact/Lead/User) for activity tracking"),
  what_id: z.string().optional().describe("Related record ID (e.g. Case, Opportunity)"),
  sender_display_name: z.string().optional().describe("From display name"),
  reply_to: z.string().optional().describe("Reply-to email address"),
  use_signature: z.boolean().optional().default(true),
  template_id: z.string().optional().describe("EmailTemplate ID to use"),
  save_as_activity: z.boolean().optional().default(true),
});

const DeleteEmailMessageSchema = z.object({
  email_message_id: z.string().describe("EmailMessage ID to delete"),
});

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_email_messages",
      title: "List Email Messages",
      description: "List Salesforce EmailMessage records. Filter by parent case, status, sender, or recipient. Returns subject, from/to addresses, date, and status.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records (default 25, max 200)" },
          offset: { type: "number", description: "Pagination offset" },
          parent_id: { type: "string", description: "Filter by parent Case ID" },
          status: { type: "string", enum: ["0", "1", "2", "3"], description: "0=New, 1=Read, 2=Replied, 3=Sent" },
          from_address: { type: "string", description: "Filter by sender email" },
          to_address: { type: "string", description: "Filter by recipient email" },
          order_by: { type: "string", enum: ["MessageDate", "CreatedDate", "Subject"] },
          order_dir: { type: "string", enum: ["ASC", "DESC"] },
        },
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_email_message",
      title: "Get Email Message",
      description: "Get full details for a Salesforce EmailMessage by ID, including subject, body, from/to addresses, and attachments.",
      inputSchema: {
        type: "object",
        properties: {
          email_message_id: { type: "string", description: "EmailMessage ID (required)" },
        },
        required: ["email_message_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "send_email",
      title: "Send Email",
      description: "Send a single email via the Salesforce Messaging API. Can use an EmailTemplate, track against a related record, and save as an activity. Supports HTML and plain text bodies.",
      inputSchema: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Email subject (required)" },
          html_body: { type: "string", description: "HTML body" },
          plain_text_body: { type: "string", description: "Plain text body" },
          to_addresses: { type: "array", items: { type: "string" }, description: "To: addresses (required)" },
          cc_addresses: { type: "array", items: { type: "string" }, description: "CC addresses" },
          bcc_addresses: { type: "array", items: { type: "string" }, description: "BCC addresses" },
          target_object_id: { type: "string", description: "Contact/Lead/User ID for tracking" },
          what_id: { type: "string", description: "Related record ID (Case, Opportunity, etc.)" },
          sender_display_name: { type: "string", description: "From display name" },
          reply_to: { type: "string", description: "Reply-to address" },
          use_signature: { type: "boolean", description: "Use sender's email signature" },
          template_id: { type: "string", description: "EmailTemplate ID" },
          save_as_activity: { type: "boolean", description: "Save as activity (default true)" },
        },
        required: ["subject", "to_addresses"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    {
      name: "delete_email_message",
      title: "Delete Email Message",
      description: "Delete a Salesforce EmailMessage record.",
      inputSchema: {
        type: "object",
        properties: {
          email_message_id: { type: "string", description: "EmailMessage ID to delete" },
        },
        required: ["email_message_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
  ];
}

function getToolHandlers(client: SalesforceClient): Record<string, ToolHandler> {
  return {
    list_email_messages: async (args) => {
      const params = ListEmailMessagesSchema.parse(args);
      const conditions: string[] = [];
      if (params.parent_id) conditions.push(`ParentId = '${params.parent_id}'`);
      if (params.status) conditions.push(`Status = '${params.status}'`);
      if (params.from_address) conditions.push(`FromAddress = '${params.from_address.replace(/'/g, "\\'")}'`);
      if (params.to_address) conditions.push(`ToAddress LIKE '%${params.to_address.replace(/'/g, "\\'")}%'`);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const soql = `SELECT Id,Subject,FromAddress,FromName,ToAddress,CcAddress,Status,MessageDate,Incoming,HasAttachment,ParentId,CreatedDate FROM EmailMessage ${where} ORDER BY ${params.order_by} ${params.order_dir} LIMIT ${params.limit} OFFSET ${params.offset}`;
      const countSoql = `SELECT COUNT() FROM EmailMessage ${where}`;

      const [result, countResult] = await Promise.all([
        logger.time("tool.list_email_messages", () => client.query<Record<string, unknown>>(soql), {}),
        client.query(countSoql),
      ]);

      const response = {
        records: result.records.map((r) => ({
          id: r["Id"],
          subject: r["Subject"],
          fromAddress: r["FromAddress"],
          fromName: r["FromName"],
          toAddress: r["ToAddress"],
          ccAddress: r["CcAddress"],
          status: r["Status"],
          messageDate: r["MessageDate"],
          incoming: r["Incoming"],
          hasAttachment: r["HasAttachment"],
          parentId: r["ParentId"],
          createdDate: r["CreatedDate"],
        })),
        meta: { total: countResult.totalSize, returned: result.records.length, hasMore: result.records.length === params.limit, offset: params.offset },
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    get_email_message: async (args) => {
      const { email_message_id } = GetEmailMessageSchema.parse(args);
      const result = await logger.time("tool.get_email_message", () =>
        client.get<Record<string, unknown>>(`/sobjects/EmailMessage/${email_message_id}`), {}
      );

      const response = {
        id: result["Id"],
        subject: result["Subject"],
        fromAddress: result["FromAddress"],
        fromName: result["FromName"],
        toAddress: result["ToAddress"],
        ccAddress: result["CcAddress"],
        bccAddress: result["BccAddress"],
        status: result["Status"],
        htmlBody: result["HtmlBody"],
        textBody: result["TextBody"],
        messageDate: result["MessageDate"],
        incoming: result["Incoming"],
        hasAttachment: result["HasAttachment"],
        parentId: result["ParentId"],
        replyToEmailMessageId: result["ReplyToEmailMessageId"],
        createdDate: result["CreatedDate"],
        lastModifiedDate: result["LastModifiedDate"],
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    send_email: async (args) => {
      const params = SendEmailSchema.parse(args);
      const emailMsg: Record<string, unknown> = {
        subject: params.subject,
        toAddresses: params.to_addresses,
        useSignature: params.use_signature,
        saveAsActivity: params.save_as_activity,
      };

      if (params.html_body) emailMsg["htmlBody"] = params.html_body;
      if (params.plain_text_body) emailMsg["plainTextBody"] = params.plain_text_body;
      if (params.cc_addresses && params.cc_addresses.length > 0) emailMsg["ccAddresses"] = params.cc_addresses;
      if (params.bcc_addresses && params.bcc_addresses.length > 0) emailMsg["bccAddresses"] = params.bcc_addresses;
      if (params.target_object_id) emailMsg["targetObjectId"] = params.target_object_id;
      if (params.what_id) emailMsg["whatId"] = params.what_id;
      if (params.sender_display_name) emailMsg["senderDisplayName"] = params.sender_display_name;
      if (params.reply_to) emailMsg["replyTo"] = params.reply_to;
      if (params.template_id) emailMsg["templateId"] = params.template_id;

      const result = await logger.time("tool.send_email", () =>
        client.post<{ success: boolean; errors: unknown[] }>("/actions/standard/emailSimple", {
          inputs: [{ emailMessages: [emailMsg] }],
        }), {}
      );

      const response = {
        success: true,
        result,
        subject: params.subject,
        toAddresses: params.to_addresses,
      };

      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },

    delete_email_message: async (args) => {
      const { email_message_id } = DeleteEmailMessageSchema.parse(args);
      await logger.time("tool.delete_email_message", () =>
        client.delete(`/sobjects/EmailMessage/${email_message_id}`), {}
      );
      const response = { success: true, email_message_id, deleted: true };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], structuredContent: response };
    },
  };
}

export function getTools(client: SalesforceClient) {
  return { tools: getToolDefinitions(), handlers: getToolHandlers(client) };
}
