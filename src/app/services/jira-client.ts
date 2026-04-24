import type { JiraIssue, JiraSearchResult, JiraBulkFetchResult, JiraAccessibleResource } from "../../shared/jira-types";

const DEFAULT_FIELDS = ["summary", "status", "priority", "assignee", "project"];

// ── Error classes ─────────────────────────────────────────────────────────────

export class JiraApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string
  ) {
    super(message);
    this.name = "JiraApiError";
  }
}

export class JiraRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Jira rate limit exceeded. Retry after ${retryAfterSeconds}s`);
    this.name = "JiraRateLimitError";
  }
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface IJiraClient {
  getIssue(key: string, fields?: string[]): Promise<JiraIssue | null>;
  searchJql(jql: string, opts?: { maxResults?: number; fields?: string[]; startAt?: number }): Promise<JiraSearchResult>;
  bulkFetch(keys: string[], fields?: string[]): Promise<JiraBulkFetchResult>;
}

// ── JiraClient (OAuth / Bearer) ───────────────────────────────────────────────

export class JiraClient implements IJiraClient {
  private readonly baseUrl: string;

  constructor(
    cloudId: string,
    private readonly getAccessToken: () => Promise<string>
  ) {
    this.baseUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const accessToken = await this.getAccessToken();
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("Retry-After") ?? "60", 10);
      throw new JiraRateLimitError(Number.isFinite(retryAfter) ? retryAfter : 60);
    }

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => null);
      }
      throw new JiraApiError(response.status, body, `Jira API error ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  async getIssue(key: string, fields: string[] = DEFAULT_FIELDS): Promise<JiraIssue | null> {
    try {
      return await this.request<JiraIssue>(`/issue/${encodeURIComponent(key)}?fields=${fields.join(",")}`);
    } catch (err) {
      if (err instanceof JiraApiError && err.status === 404) return null;
      throw err;
    }
  }

  async searchJql(
    jql: string,
    opts: { maxResults?: number; fields?: string[]; startAt?: number } = {}
  ): Promise<JiraSearchResult> {
    const { maxResults = 100, fields = DEFAULT_FIELDS, startAt = 0 } = opts;
    const params = new URLSearchParams({
      jql,
      maxResults: String(maxResults),
      startAt: String(startAt),
      fields: fields.join(","),
    });
    return this.request<JiraSearchResult>(`/search/jql?${params.toString()}`);
  }

  async bulkFetch(keys: string[], fields: string[] = DEFAULT_FIELDS): Promise<JiraBulkFetchResult> {
    return this.request<JiraBulkFetchResult>("/issue/bulkfetch", {
      method: "POST",
      body: JSON.stringify({ issueIdsOrKeys: keys, fields }),
    });
  }

  static async getAccessibleResources(accessToken: string): Promise<JiraAccessibleResource[]> {
    const response = await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
      redirect: "error",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("Retry-After") ?? "60", 10);
      throw new JiraRateLimitError(Number.isFinite(retryAfter) ? retryAfter : 60);
    }

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => null);
      }
      throw new JiraApiError(response.status, body, `Jira accessible resources error ${response.status}`);
    }

    return response.json() as Promise<JiraAccessibleResource[]>;
  }
}

// ── JiraProxyClient (API token / Worker proxy) ────────────────────────────────

export class JiraProxyClient implements IJiraClient {
  constructor(
    private readonly cloudId: string,
    private readonly email: string,
    private readonly sealed: string,
    private readonly onResealed?: (resealed: string) => void
  ) {}

  private async request<T>(
    endpoint: "search" | "issue",
    params: Record<string, unknown>
  ): Promise<T & { resealed?: string }> {
    const response = await fetch("/api/jira/proxy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "fetch",
      },
      body: JSON.stringify({
        endpoint,
        cloudId: this.cloudId,
        email: this.email,
        sealed: this.sealed,
        params,
      }),
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("Retry-After") ?? "60", 10);
      throw new JiraRateLimitError(Number.isFinite(retryAfter) ? retryAfter : 60);
    }

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => null);
      }
      throw new JiraApiError(response.status, body, `Jira proxy error ${response.status}`);
    }

    return response.json() as Promise<T & { resealed?: string }>;
  }

  async getIssue(key: string, fields: string[] = DEFAULT_FIELDS): Promise<JiraIssue | null> {
    const result = await this.bulkFetch([key], fields);
    if (result.issues.length === 0) return null;
    const hasError = result.errors?.some((e) => e.issueIdsOrKeys.includes(key));
    if (hasError) return null;
    return result.issues[0] ?? null;
  }

  async searchJql(
    jql: string,
    opts: { maxResults?: number; fields?: string[]; startAt?: number } = {}
  ): Promise<JiraSearchResult> {
    const { maxResults = 100, fields = DEFAULT_FIELDS, startAt = 0 } = opts;
    const result = await this.request<JiraSearchResult>("search", { jql, maxResults, fields, startAt });
    if (result.resealed && this.onResealed) {
      this.onResealed(result.resealed);
    }
    return result;
  }

  async bulkFetch(keys: string[], fields: string[] = DEFAULT_FIELDS): Promise<JiraBulkFetchResult> {
    const result = await this.request<JiraBulkFetchResult>("issue", {
      issueIdsOrKeys: keys,
      fields,
    });
    if (result.resealed && this.onResealed) {
      this.onResealed(result.resealed);
    }
    return { issues: result.issues, errors: result.errors };
  }
}
