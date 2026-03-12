// Salesforce API Client
// Handles OAuth 2.0 (Username-Password flow), token refresh, SOQL queries,
// REST API calls, circuit breaker, rate limiting, and retry logic.

import { logger } from "./logger.js";
import type { SalesforceTokenResponse } from "./types.js";

const DEFAULT_LOGIN_URL = "https://login.salesforce.com";
const API_VERSION = "v59.0";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;

// ============================================
// CIRCUIT BREAKER
// ============================================
type CircuitState = "closed" | "open" | "half-open";

class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenLock = false;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(failureThreshold = 5, resetTimeoutMs = 60_000) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
  }

  canExecute(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        if (!this.halfOpenLock) {
          this.halfOpenLock = true;
          this.state = "half-open";
          logger.info("circuit_breaker.half_open");
          return true;
        }
        return false;
      }
      return false;
    }
    return false;
  }

  recordSuccess(): void {
    this.halfOpenLock = false;
    if (this.state !== "closed") {
      logger.info("circuit_breaker.closed", { previousFailures: this.failureCount });
    }
    this.failureCount = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.halfOpenLock = false;
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold || this.state === "half-open") {
      this.state = "open";
      logger.warn("circuit_breaker.open", {
        failureCount: this.failureCount,
        resetAfterMs: this.resetTimeoutMs,
      });
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

// ============================================
// SALESFORCE CLIENT
// ============================================
export class SalesforceClient {
  private clientId: string;
  private clientSecret: string;
  private username: string;
  private password: string;
  private instanceUrl: string;
  private loginUrl: string;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private circuitBreaker: CircuitBreaker;
  private timeoutMs: number;
  private rateLimitRemaining = Infinity;
  private rateLimitReset = 0;

  constructor(config: {
    clientId: string;
    clientSecret: string;
    username: string;
    password: string;
    instanceUrl: string;
    loginUrl?: string;
    timeoutMs?: number;
  }) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.username = config.username;
    this.password = config.password;
    this.instanceUrl = config.instanceUrl;
    this.loginUrl = config.loginUrl || DEFAULT_LOGIN_URL;
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.circuitBreaker = new CircuitBreaker();
  }

  // === OAuth 2.0 Token Acquisition (Username-Password flow) ===
  private async authenticate(): Promise<string> {
    logger.info("auth.authenticate.start");

    const params = new URLSearchParams({
      grant_type: "password",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      username: this.username,
      password: this.password,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.loginUrl}/services/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OAuth authentication failed (${response.status}): ${errorText}`);
      }

      const tokenData = (await response.json()) as SalesforceTokenResponse;
      this.accessToken = tokenData.access_token;
      // Salesforce tokens don't have explicit expiry — we'll refresh after 2h as a precaution
      this.tokenExpiresAt = Date.now() + 2 * 60 * 60 * 1000;

      logger.info("auth.authenticate.done", {
        instanceUrl: tokenData.instance_url,
      });

      return this.accessToken;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // === Get valid access token (auto-refresh if expired) ===
  private async getToken(): Promise<string> {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt - 60_000) {
      await this.authenticate();
    }
    return this.accessToken!;
  }

  // === Core HTTP request with circuit breaker + retry + rate limiting ===
  async request<T = unknown>(
    endpoint: string,
    options: RequestInit & { method?: string } = {}
  ): Promise<T> {
    if (!this.circuitBreaker.canExecute()) {
      throw new Error("Circuit breaker is open — Salesforce API temporarily unavailable. Retry in 60 seconds.");
    }

    await this.waitForRateLimit();

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const token = await this.getToken();
        const url = `${this.instanceUrl}/services/data/${API_VERSION}${endpoint}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        const requestId = logger.requestId();
        logger.debug("api_request.start", {
          requestId,
          method: options.method || "GET",
          endpoint,
          attempt: attempt + 1,
        });

        try {
          const response = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: {
              "Authorization": `Bearer ${token}`,
              "Content-Type": "application/json",
              "Accept": "application/json",
              ...options.headers,
            },
          });

          this.updateRateLimits(response);

          if (response.status === 401) {
            // Token expired — force re-authentication
            this.accessToken = null;
            this.tokenExpiresAt = 0;
            lastError = new Error("Authentication expired — will retry");
            await this.delay(500);
            continue;
          }

          if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get("Retry-After") || "5", 10);
            logger.warn("api_request.rate_limited", { requestId, retryAfter, endpoint });
            await this.delay(retryAfter * 1000);
            continue;
          }

          if (response.status >= 500) {
            this.circuitBreaker.recordFailure();
            const errorText = await response.text();
            lastError = new Error(`Salesforce server error (${response.status}): ${errorText}`);
            const baseDelay = RETRY_BASE_DELAY * Math.pow(2, attempt);
            await this.delay(baseDelay + Math.random() * baseDelay * 0.5);
            continue;
          }

          if (!response.ok) {
            const errorBody = await response.text();
            let parsed: unknown;
            try { parsed = JSON.parse(errorBody); } catch { parsed = errorBody; }
            const msg = Array.isArray(parsed)
              ? parsed.map((e: { message?: string }) => e.message).join("; ")
              : typeof parsed === "object" && parsed !== null && "message" in parsed
                ? (parsed as { message: string }).message
                : errorBody;
            throw new Error(`Salesforce API error (${response.status}): ${msg}`);
          }

          this.circuitBreaker.recordSuccess();

          if (response.status === 204 || response.headers.get("content-length") === "0") {
            return { success: true } as T;
          }

          return (await response.json()) as T;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          this.circuitBreaker.recordFailure();
          lastError = new Error(`Request timeout after ${this.timeoutMs}ms: ${endpoint}`);
          continue;
        }
        if (error instanceof Error && !error.message.startsWith("Salesforce server error") && !error.message.includes("expired")) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  // === SOQL Query ===
  async query<T = Record<string, unknown>>(soql: string): Promise<{
    totalSize: number;
    done: boolean;
    nextRecordsUrl?: string;
    records: T[];
  }> {
    const encoded = encodeURIComponent(soql);
    return this.request(`/query/?q=${encoded}`);
  }

  // === SOQL Query All (follows pagination automatically) ===
  async queryAll<T = Record<string, unknown>>(soql: string): Promise<T[]> {
    const allRecords: T[] = [];
    let nextUrl: string | undefined;

    const firstPage = await this.query<T>(soql);
    allRecords.push(...firstPage.records);
    nextUrl = firstPage.nextRecordsUrl;

    while (nextUrl) {
      const page = await this.request<{ records: T[]; done: boolean; nextRecordsUrl?: string }>(
        nextUrl.replace(`/services/data/${API_VERSION}`, "")
      );
      allRecords.push(...page.records);
      nextUrl = page.done ? undefined : page.nextRecordsUrl;
    }

    return allRecords;
  }

  // === Convenience CRUD methods ===
  async get<T = unknown>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: "GET" });
  }

  async post<T = unknown>(endpoint: string, data: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async patch<T = unknown>(endpoint: string, data: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async delete<T = unknown>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: "DELETE" });
  }

  // === Health check ===
  async healthCheck(): Promise<{
    reachable: boolean;
    authenticated: boolean;
    latencyMs: number;
    apiVersion?: string;
    orgId?: string;
    error?: string;
  }> {
    const start = performance.now();
    try {
      const token = await this.getToken();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      try {
        const response = await fetch(`${this.instanceUrl}/services/data/${API_VERSION}/`, {
          headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
          signal: controller.signal,
        });

        const latencyMs = Math.round(performance.now() - start);

        if (!response.ok) {
          return {
            reachable: true,
            authenticated: response.status !== 401,
            latencyMs,
            error: `Status ${response.status}`,
          };
        }

        const data = await response.json() as { identity?: string };

        return {
          reachable: true,
          authenticated: true,
          latencyMs,
          apiVersion: API_VERSION,
          orgId: data.identity,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      return {
        reachable: false,
        authenticated: false,
        latencyMs: Math.round(performance.now() - start),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // === Rate limit helpers ===
  private updateRateLimits(response: Response): void {
    const remaining = response.headers.get("Sforce-Limit-Info");
    if (remaining) {
      // Sforce-Limit-Info: api-usage=1/15000
      const match = remaining.match(/api-usage=(\d+)\/(\d+)/);
      if (match) {
        const used = parseInt(match[1], 10);
        const total = parseInt(match[2], 10);
        this.rateLimitRemaining = total - used;
        logger.debug("rate_limit.update", { used, total, remaining: this.rateLimitRemaining });
      }
    }
  }

  private async waitForRateLimit(): Promise<void> {
    if (this.rateLimitRemaining <= 1 && this.rateLimitReset > Date.now()) {
      const waitMs = this.rateLimitReset - Date.now() + 100;
      logger.warn("rate_limit.waiting", { waitMs });
      await this.delay(Math.min(waitMs, 30000));
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
