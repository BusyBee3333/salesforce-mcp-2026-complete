// Shared TypeScript interfaces for the Salesforce MCP server

export interface SalesforceTokenResponse {
  access_token: string;
  instance_url: string;
  token_type: string;
  issued_at: string;
  id: string;
}

export interface SalesforceSOQLResponse<T = SalesforceRecord> {
  totalSize: number;
  done: boolean;
  nextRecordsUrl?: string;
  records: T[];
}

export interface SalesforceRecord {
  attributes: { type: string; url: string };
  Id: string;
  [key: string]: unknown;
}

export interface SalesforceCreateResponse {
  id: string;
  success: boolean;
  errors: unknown[];
}

export interface SalesforceErrorResponse {
  errorCode: string;
  message: string;
  fields?: string[];
}

export interface SalesforceLead extends SalesforceRecord {
  FirstName?: string;
  LastName: string;
  Company: string;
  Email?: string;
  Phone?: string;
  Status: string;
  OwnerId?: string;
  LeadSource?: string;
  Rating?: string;
  Industry?: string;
  Title?: string;
  Website?: string;
  Description?: string;
  CreatedDate: string;
  LastModifiedDate: string;
}

export interface SalesforceContact extends SalesforceRecord {
  FirstName?: string;
  LastName: string;
  AccountId?: string;
  Email?: string;
  Phone?: string;
  Title?: string;
  Department?: string;
  MailingCity?: string;
  MailingState?: string;
  MailingCountry?: string;
  CreatedDate: string;
  LastModifiedDate: string;
}

export interface SalesforceAccount extends SalesforceRecord {
  Name: string;
  Type?: string;
  Industry?: string;
  AnnualRevenue?: number;
  NumberOfEmployees?: number;
  Phone?: string;
  Website?: string;
  BillingCity?: string;
  BillingState?: string;
  BillingCountry?: string;
  OwnerId?: string;
  CreatedDate: string;
  LastModifiedDate: string;
}

export interface SalesforceOpportunity extends SalesforceRecord {
  Name: string;
  AccountId?: string;
  StageName: string;
  Amount?: number;
  CloseDate: string;
  Probability?: number;
  OwnerId?: string;
  LeadSource?: string;
  Description?: string;
  Type?: string;
  CreatedDate: string;
  LastModifiedDate: string;
}

export interface SalesforceCase extends SalesforceRecord {
  Subject: string;
  AccountId?: string;
  ContactId?: string;
  Status: string;
  Priority?: string;
  Origin?: string;
  Description?: string;
  OwnerId?: string;
  CreatedDate: string;
  LastModifiedDate: string;
}

export interface PaginationMeta {
  total: number;
  returned: number;
  hasMore: boolean;
  nextRecordsUrl?: string;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string; uri?: string; name?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;
