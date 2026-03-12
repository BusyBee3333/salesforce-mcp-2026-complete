// Structured JSON logger — all output to stderr (stdout reserved for MCP protocol)

import { randomUUID } from "crypto";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  server: string;
  [key: string]: unknown;
}

class Logger {
  private serverName: string;

  constructor(serverName: string) {
    this.serverName = serverName;
  }

  private write(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      server: this.serverName,
      ...data,
    };
    process.stderr.write(JSON.stringify(entry) + "\n");
  }

  debug(event: string, data?: Record<string, unknown>): void {
    this.write("debug", event, data);
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.write("info", event, data);
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.write("warn", event, data);
  }

  error(event: string, data?: Record<string, unknown>): void {
    this.write("error", event, data);
  }

  requestId(): string {
    return randomUUID().slice(0, 8);
  }

  async time<T>(event: string, fn: () => Promise<T>, data?: Record<string, unknown>): Promise<T> {
    const requestId = this.requestId();
    const start = performance.now();
    this.info(`${event}.start`, { requestId, ...data });
    try {
      const result = await fn();
      const durationMs = Math.round(performance.now() - start);
      this.info(`${event}.done`, { requestId, durationMs, ...data });
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      this.error(`${event}.error`, {
        requestId,
        durationMs,
        error: error instanceof Error ? error.message : String(error),
        ...data,
      });
      throw error;
    }
  }
}

export const logger = new Logger("salesforce-mcp");
