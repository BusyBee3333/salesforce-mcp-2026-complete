// Tool registry with lazy loading — each group is imported only when needed
import type { SalesforceClient } from "../client.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

interface ToolGroup {
  tools: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
  loaded: boolean;
}

export class ToolRegistry {
  private groups: Map<string, ToolGroup> = new Map();
  private toolToGroup: Map<string, string> = new Map();
  private client: SalesforceClient;

  private groupLoaders: Record<
    string,
    () => Promise<{ tools: ToolDefinition[]; handlers: Record<string, ToolHandler> }>
  >;

  constructor(client: SalesforceClient) {
    this.client = client;
    this.groupLoaders = {
      health: async () => {
        const mod = await import("./health.js");
        return mod.getTools(this.client);
      },
      leads: async () => {
        const mod = await import("./leads.js");
        return mod.getTools(this.client);
      },
      contacts: async () => {
        const mod = await import("./contacts.js");
        return mod.getTools(this.client);
      },
      accounts: async () => {
        const mod = await import("./accounts.js");
        return mod.getTools(this.client);
      },
      opportunities: async () => {
        const mod = await import("./opportunities.js");
        return mod.getTools(this.client);
      },
      cases: async () => {
        const mod = await import("./cases.js");
        return mod.getTools(this.client);
      },
      soql: async () => {
        const mod = await import("./soql.js");
        return mod.getTools(this.client);
      },
      tasks: async () => {
        const mod = await import("./tasks.js");
        return mod.getTools(this.client);
      },
      events: async () => {
        const mod = await import("./events.js");
        return mod.getTools(this.client);
      },
      campaigns: async () => {
        const mod = await import("./campaigns.js");
        return mod.getTools(this.client);
      },
      reports: async () => {
        const mod = await import("./reports.js");
        return mod.getTools(this.client);
      },
      custom_objects: async () => {
        const mod = await import("./custom_objects.js");
        return mod.getTools(this.client);
      },
      attachments: async () => {
        const mod = await import("./attachments.js");
        return mod.getTools(this.client);
      },
      users: async () => {
        const mod = await import("./users.js");
        return mod.getTools(this.client);
      },
    };
  }

  private async loadGroup(name: string): Promise<void> {
    if (this.groups.get(name)?.loaded) return;
    const loader = this.groupLoaders[name];
    if (!loader) throw new Error(`Unknown tool group: ${name}`);
    const { tools, handlers } = await loader();
    this.groups.set(name, { tools, handlers, loaded: true });
    for (const tool of tools) {
      this.toolToGroup.set(tool.name, name);
    }
  }

  async loadAllGroups(): Promise<void> {
    await Promise.all(Object.keys(this.groupLoaders).map((n) => this.loadGroup(n)));
  }

  async getAllTools(): Promise<ToolDefinition[]> {
    await this.loadAllGroups();
    const all: ToolDefinition[] = [];
    for (const group of this.groups.values()) all.push(...group.tools);
    return all;
  }

  async getHandler(toolName: string): Promise<ToolHandler> {
    let groupName = this.toolToGroup.get(toolName);
    if (!groupName) {
      await this.loadAllGroups();
      groupName = this.toolToGroup.get(toolName);
      if (!groupName) throw new Error(`Unknown tool: ${toolName}`);
    }
    await this.loadGroup(groupName);
    const handler = this.groups.get(groupName)!.handlers[toolName];
    if (!handler) throw new Error(`No handler for tool: ${toolName}`);
    return handler;
  }
}
