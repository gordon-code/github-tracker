import { createSignal, createEffect } from "solid-js";
import { Octokit } from "@octokit/core";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { cachedFetch, type ConditionalHeaders } from "../stores/cache";
import { token } from "../stores/auth";
import { pushNotification } from "../lib/errors";

// ── Plugin-extended Octokit class ────────────────────────────────────────────

const GitHubOctokit = Octokit.plugin(throttling, retry, paginateRest);

// ── Types ────────────────────────────────────────────────────────────────────

type GitHubOctokitInstance = InstanceType<typeof GitHubOctokit>;

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: Date;
}

// ── Rate limit signals ───────────────────────────────────────────────────────

const [_coreRateLimit, _setCoreRateLimit] = createSignal<RateLimitInfo | null>(null);
const [_graphqlRateLimit, _setGraphqlRateLimit] = createSignal<RateLimitInfo | null>(null);

export function getCoreRateLimit(): RateLimitInfo | null {
  return _coreRateLimit();
}

export function getGraphqlRateLimit(): RateLimitInfo | null {
  return _graphqlRateLimit();
}

function safePositiveNumber(raw: number | undefined, fallback: number): number {
  return raw != null && Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function updateGraphqlRateLimit(rateLimit: { limit: number; remaining: number; resetAt: string }): void {
  _setGraphqlRateLimit({
    limit: safePositiveNumber(rateLimit.limit, _graphqlRateLimit()?.limit ?? 5000),
    remaining: rateLimit.remaining,
    resetAt: new Date(rateLimit.resetAt), // ISO 8601 string → Date
  });
}

export function updateRateLimitFromHeaders(headers: Record<string, string>): void {
  const remaining = headers["x-ratelimit-remaining"];
  const reset = headers["x-ratelimit-reset"];
  const limit = headers["x-ratelimit-limit"];
  if (remaining !== undefined && reset !== undefined) {
    const parsedLimit = limit !== undefined ? parseInt(limit, 10) : NaN;
    _setCoreRateLimit({
      limit: safePositiveNumber(parsedLimit, 5000),
      remaining: parseInt(remaining, 10),
      resetAt: new Date(parseInt(reset, 10) * 1000),
    });
  }
}

// ── API request tracking callback ────────────────────────────────────────────

export interface ApiRequestInfo {
  url: string;
  method: string;
  status: number;
  isGraphql: boolean;
  /** Custom label from caller (e.g., "heavyBackfill"), passed via octokit options */
  apiSource?: string;
  /** x-ratelimit-reset converted to ms, or null if unavailable */
  resetEpochMs: number | null;
}

const _requestCallbacks: Array<(info: ApiRequestInfo) => void> = [];

export function onApiRequest(cb: (info: ApiRequestInfo) => void): void {
  _requestCallbacks.push(cb);
}

// ── Client factory ───────────────────────────────────────────────────────────

export function createGitHubClient(token: string): GitHubOctokitInstance {
  const client = new GitHubOctokit({
    auth: token,
    userAgent: "github-tracker",
    throttle: {
      onRateLimit: (
        retryAfter: number,
        options: { method: string; url: string },
        _octokit: GitHubOctokitInstance,
        retryCount: number
      ) => {
        console.warn(
          `[github] Rate limit hit for ${options.method} ${options.url}. Retry after ${retryAfter}s.`
        );
        pushNotification("rate-limit", `Rate limit hit — retrying in ${retryAfter}s`, "warning", true);
        return retryCount < 1;
      },
      onSecondaryRateLimit: (
        retryAfter: number,
        options: { method: string; url: string },
        _octokit: GitHubOctokitInstance,
        retryCount: number
      ) => {
        console.warn(
          `[github] Secondary rate limit for ${options.method} ${options.url}. Retry after ${retryAfter}s.`
        );
        pushNotification("rate-limit", `Secondary rate limit — retrying in ${retryAfter}s. Consider reducing tracked repos.`, "warning", true);
        return retryCount < 1;
      },
    },
    retry: {
      retries: 2,
      // Extend the plugin's default doNotRetry list [400,401,403,404,410,422,451]
      // with 429 to prevent double-handling with plugin-throttling
      doNotRetry: [400, 401, 403, 404, 410, 422, 429, 451],
    },
  });

  // Read-only guard: the OAuth App `repo` scope grants write access, but this
  // app is strictly read-only. Block any non-GET request except POST /graphql
  // (GraphQL queries are read-only but always use POST).
  client.hook.before("request", (options) => {
    const method = (options.method ?? "GET").toUpperCase();
    if (method === "GET") return;
    if (method === "POST" && options.url === "/graphql") return;
    throw new Error(`[github] Write operation blocked: ${method} ${options.url}. This app is read-only.`);
  });

  // Track every API request for usage analytics + update rate limit display
  client.hook.wrap("request", async (request, options) => {
    const isGraphql = options.url === "/graphql";
    const method = (options.method ?? "GET").toUpperCase();
    // GraphQL: apiSource is passed via `request: { apiSource }` because @octokit/graphql
    // treats unknown top-level keys as GraphQL variables. The `request` key is in
    // NON_VARIABLE_OPTIONS so it's preserved in the parsed request options.
    const reqMeta = (options as Record<string, unknown>).request as Record<string, unknown> | undefined;
    const apiSource = reqMeta?.apiSource as string | undefined;

    let response;
    let status = 0;
    try {
      response = await request(options);
      status = response.status;
    } catch (err) {
      if (typeof err === "object" && err !== null && "status" in err) {
        status = (err as { status: number }).status;
      }
      // Fire callbacks even on errors — these are real API calls.
      // Octokit's RequestError includes response.headers for HTTP errors (403, 404, etc.)
      // so we can still extract x-ratelimit-reset when available.
      if (status > 0) {
        let resetEpochMs: number | null = null;
        const errResponse = (err as { response?: { headers?: Record<string, string> } }).response;
        const errResetHeader = errResponse?.headers?.["x-ratelimit-reset"];
        if (errResetHeader) resetEpochMs = parseInt(errResetHeader, 10) * 1000;
        const info: ApiRequestInfo = {
          url: options.url, method, status, isGraphql, apiSource, resetEpochMs,
        };
        for (const cb of _requestCallbacks) { try { cb(info); } catch { /* swallow */ } }
      }
      throw err;
    }

    // Success path — fire callbacks (api-usage.ts registers at module scope) and update RL display
    const headers = (response.headers ?? {}) as Record<string, string>;
    const resetHeader = headers["x-ratelimit-reset"];
    const resetEpochMs = resetHeader ? parseInt(resetHeader, 10) * 1000 : null;
    const info: ApiRequestInfo = {
      url: options.url, method, status, isGraphql, apiSource, resetEpochMs,
    };
    for (const cb of _requestCallbacks) { try { cb(info); } catch { /* swallow */ } }

    if (response.headers) {
      updateRateLimitFromHeaders(response.headers as Record<string, string>);
    }

    return response;
  });

  return client;
}

// ── ETag-aware request wrapper ───────────────────────────────────────────────

export async function cachedRequest(
  octokit: GitHubOctokitInstance,
  cacheKey: string,
  route: string,
  params?: Record<string, unknown>,
  maxAge?: number
): Promise<{ data: unknown; fromCache: boolean }> {
  return cachedFetch(cacheKey, async (cached: ConditionalHeaders) => {
    const conditionalHeaders: Record<string, string> = {};
    if (cached.etag) {
      conditionalHeaders["If-None-Match"] = cached.etag;
    } else if (cached.lastModified) {
      // Fall back to If-Modified-Since when no ETag is available
      conditionalHeaders["If-Modified-Since"] = cached.lastModified;
    }

    const requestParams: Record<string, unknown> = {
      ...params,
      headers: conditionalHeaders,
    };

    try {
      const response = await octokit.request(route, requestParams);
      const headers = response.headers as Record<string, string>;

      // NOTE: updateRateLimitFromHeaders is handled by the hook.wrap on the
      // Octokit client — no need to call it here.

      return {
        data: response.data as unknown,
        etag: headers["etag"] ?? null,
        lastModified: headers["last-modified"] ?? null,
        status: 200,
      };
    } catch (err) {
      // Octokit throws RequestError with status 304 instead of returning a response
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { status?: number }).status === 304
      ) {
        return { data: null, etag: null, lastModified: null, status: 304 };
      }
      throw err;
    }
  }, maxAge);
}

// ── Client singleton ─────────────────────────────────────────────────────────

// Eagerly create client if token exists at module load (before initClientWatcher effect runs).
// This ensures getClient() returns non-null for early callers like the poll coordinator.
// Wrapped in try/catch: if Octokit construction fails, fall back to null and let
// initClientWatcher retry when its effect fires.
let _eagerClient: GitHubOctokitInstance | null = null;
let _clientToken: string | null = null;
try {
  const t = token();
  if (t) {
    _eagerClient = createGitHubClient(t);
    _clientToken = t;
  }
} catch {
  // Non-fatal — initClientWatcher will retry
}
const [_client, _setClient] = createSignal<GitHubOctokitInstance | null>(_eagerClient);

export function getClient(): GitHubOctokitInstance | null {
  return _client();
}

/**
 * Must be called from within a reactive root (e.g., App.tsx onMount).
 * Sets up a createEffect that watches the auth token signal and creates/clears
 * the Octokit instance accordingly.
 */
export function initClientWatcher(): void {
  createEffect(() => {
    const currentToken = token();
    if (currentToken) {
      // Skip if the eager init already created a client for this exact token
      if (currentToken === _clientToken && _client()) return;
      _setClient(createGitHubClient(currentToken));
      _clientToken = currentToken;
    } else {
      _setClient(null);
      _clientToken = null;
    }
  });
}

// ── Rate limit detail fetch ──────────────────────────────────────────────────

let _lastFetchTime = 0;
let _lastFetchResult: { core: RateLimitInfo; graphql: RateLimitInfo } | null = null;

/**
 * Fetches current rate limit details for both core and GraphQL pools.
 * Caches results for 5 seconds to avoid thrashing on rapid hovers.
 * GET /rate_limit is free — not counted against rate limits by GitHub.
 * Returns null if client unavailable or request fails.
 */
export async function fetchRateLimitDetails(): Promise<{ core: RateLimitInfo; graphql: RateLimitInfo } | null> {
  // Return cached result within 5-second staleness window
  if (_lastFetchResult !== null && Date.now() - _lastFetchTime < 5000) {
    return { ..._lastFetchResult };
  }

  const client = getClient();
  if (!client) return null;

  try {
    const response = await client.request("GET /rate_limit");
    const { core, graphql } = response.data.resources;
    if (!graphql) return null;
    const result = {
      core: {
        limit: core.limit,
        remaining: core.remaining,
        resetAt: new Date(core.reset * 1000),
      },
      graphql: {
        limit: graphql.limit,
        remaining: graphql.remaining,
        resetAt: new Date(graphql.reset * 1000),
      },
    };
    _lastFetchTime = Date.now();
    _lastFetchResult = result;
    return { ...result };
  } catch {
    return null;
  }
}
