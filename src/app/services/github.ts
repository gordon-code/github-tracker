import { createSignal, createEffect } from "solid-js";
import { Octokit } from "@octokit/core";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { cachedFetch, type ConditionalHeaders } from "../stores/cache";
import { token } from "../stores/auth";
import { pushNotification } from "../lib/errors";
import { APPROVE_PR_MUTATION, MARK_PR_READY_MUTATION, GITHUB_NODE_ID_RE, GIT_SHA_RE, isReadOnlyGraphqlQuery } from "../../shared/validation";

export { APPROVE_PR_MUTATION, MARK_PR_READY_MUTATION, GITHUB_NODE_ID_RE, GIT_SHA_RE, isReadOnlyGraphqlQuery };

const NORMALIZED_APPROVE_MUTATION = APPROVE_PR_MUTATION.replace(/\s+/g, " ");
const NORMALIZED_MARK_READY_MUTATION = MARK_PR_READY_MUTATION.replace(/\s+/g, " ");
const APPROVE_ALLOWED_KEYS = new Set(["pullRequestId", "commitOID", "event"]);

function isAllowedGraphqlRequest(options: { query?: unknown; variables?: unknown }): boolean {
  if (typeof options.query !== "string") return false;

  // 1. Allow read-only GraphQL queries (starts with `query` or `{` and has no top-level mutation/subscription)
  if (isReadOnlyGraphqlQuery(options.query)) {
    return true;
  }

  // 2. Allow ONLY the exact canonical ApprovePullRequest or MarkPullRequestReadyForReview mutations
  const stripped = options.query.replace(/#[^\r\n]*/g, "").trim();
  const normalized = stripped.replace(/\s+/g, " ");

  // 3. Validate mutation variables
  const vars = options.variables as Record<string, unknown> | undefined;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return false;

  if (normalized === NORMALIZED_APPROVE_MUTATION) {
    if (!Object.keys(vars).every((k) => APPROVE_ALLOWED_KEYS.has(k))) {
      return false;
    }
    if (typeof vars.pullRequestId !== "string" || !GITHUB_NODE_ID_RE.test(vars.pullRequestId)) {
      return false;
    }
    if (typeof vars.commitOID !== "string" || !GIT_SHA_RE.test(vars.commitOID)) {
      return false;
    }
    if (vars.event !== undefined && vars.event !== "APPROVE") {
      return false;
    }
    return true;
  }

  if (normalized === NORMALIZED_MARK_READY_MUTATION) {
    const keys = Object.keys(vars);
    if (keys.length !== 1 || keys[0] !== "pullRequestId") {
      return false;
    }
    if (typeof vars.pullRequestId !== "string" || !GITHUB_NODE_ID_RE.test(vars.pullRequestId)) {
      return false;
    }
    return true;
  }

  return false;
}

// ── Plugin-extended Octokit class ────────────────────────────────────────────

export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_INLINE_RATE_LIMIT_RETRY_AFTER_SEC = 15;

const _syntheticResponseErrors = new WeakSet<object>();

/**
 * Runs inside @octokit/plugin-throttling (closest to @octokit/request) to abort
 * requests whose AbortSignal fired while queued in Bottleneck and to attach
 * a temporary empty response when a network or timeout error has no response object.
 * This prevents plugin-throttling from throwing TypeError on error.response.headers
 * when evaluating /graphql errors.
 */
function preThrottlingPlugin(octokit: Octokit): void {
  octokit.hook.wrap("request", async (request, options) => {
    const reqOpts = (options as { request?: { signal?: AbortSignal } }).request;
    try {
      if (reqOpts?.signal?.aborted) {
        const reason: unknown = reqOpts.signal.reason;
        throw reason instanceof Error
          ? reason
          : new DOMException("The operation was aborted.", "AbortError");
      }
      return await request(options);
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        (!("response" in err) || (err as { response?: unknown }).response == null)
      ) {
        (err as { response?: unknown }).response = {
          url: options.url ?? "",
          status: (err as { status?: number }).status ?? 500,
          headers: {},
          data: "",
        };
        _syntheticResponseErrors.add(err);
      }
      throw err;
    }
  });
}

/**
 * Runs between @octokit/plugin-throttling and @octokit/plugin-retry to strip the
 * synthetic response attached by preThrottlingPlugin, preserve options.request.retryCount
 * when plugin-throttling resets it on non-rate-limit /graphql errors, and suppress retries
 * when the caller's AbortSignal is already aborted.
 */
function postThrottlingPlugin(octokit: Octokit): void {
  octokit.hook.wrap("request", async (request, options) => {
    const reqOpts = (
      options as { request?: { retryCount?: number; retries?: number; signal?: AbortSignal } }
    ).request;
    const priorRetryCount = reqOpts?.retryCount;
    try {
      return await request(options);
    } catch (err) {
      if (err && typeof err === "object" && _syntheticResponseErrors.has(err)) {
        delete (err as { response?: unknown }).response;
        _syntheticResponseErrors.delete(err);
      }
      if (reqOpts && priorRetryCount !== undefined) {
        reqOpts.retryCount = Math.max(reqOpts.retryCount ?? 0, priorRetryCount);
      }
      if (reqOpts?.signal?.aborted) {
        reqOpts.retries = 0;
      }
      throw err;
    }
  });
}

const GitHubOctokit = Octokit.plugin(
  preThrottlingPlugin,
  throttling,
  postThrottlingPlugin,
  retry,
  paginateRest
);

// ── Types ────────────────────────────────────────────────────────────────────

import type { RateLimitInfo } from "../../shared/types";

type GitHubOctokitInstance = InstanceType<typeof GitHubOctokit>;

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

function updateGraphqlRateLimitFromHeaders(headers: Record<string, string>): void {
  const remaining = headers["x-ratelimit-remaining"];
  const reset = headers["x-ratelimit-reset"];
  const limit = headers["x-ratelimit-limit"];
  if (remaining !== undefined && reset !== undefined) {
    const parsedRemaining = parseInt(remaining, 10);
    const parsedReset = parseInt(reset, 10);
    if (!Number.isFinite(parsedReset)) return;
    _setGraphqlRateLimit({
      limit: safePositiveNumber(limit !== undefined ? parseInt(limit, 10) : NaN, _graphqlRateLimit()?.limit ?? 5000),
      remaining: Number.isFinite(parsedRemaining) ? parsedRemaining : 0,
      resetAt: new Date(parsedReset * 1000),
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
  /** GraphQL query point cost from response body, or undefined for REST */
  graphqlCost?: number;
}

const _requestCallbacks: Array<(info: ApiRequestInfo) => void> = [];

export function onApiRequest(cb: (info: ApiRequestInfo) => void): void {
  _requestCallbacks.push(cb);
}

// ── Client factory ───────────────────────────────────────────────────────────

export function createGitHubClient(authToken: string): GitHubOctokitInstance {
  const boundedFetch: typeof fetch = (url, init) => {
    const baseFetch = globalThis.fetch;
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    return baseFetch(url, { ...init, signal });
  };

  const client = new GitHubOctokit({
    auth: authToken,
    userAgent: "github-tracker",
    request: {
      fetch: boundedFetch,
    },
    throttle: {
      onRateLimit: (
        retryAfter: number,
        options: { method: string; url: string; request?: { signal?: AbortSignal } },
        _octokit: GitHubOctokitInstance,
        retryCount: number
      ) => {
        console.warn(
          `[github] Rate limit hit for ${options.method} ${options.url}. Retry after ${retryAfter}s.`
        );
        pushNotification("rate-limit", `Rate limit hit — retrying in ${retryAfter}s`, "warning", true);
        return (
          retryCount < 1 &&
          retryAfter <= MAX_INLINE_RATE_LIMIT_RETRY_AFTER_SEC &&
          !options.request?.signal?.aborted
        );
      },
      onSecondaryRateLimit: (
        retryAfter: number,
        options: { method: string; url: string; request?: { signal?: AbortSignal } },
        _octokit: GitHubOctokitInstance,
        retryCount: number
      ) => {
        console.warn(
          `[github] Secondary rate limit for ${options.method} ${options.url}. Retry after ${retryAfter}s.`
        );
        pushNotification("rate-limit", `Secondary rate limit — retrying in ${retryAfter}s. Consider reducing tracked repos.`, "warning", true);
        return (
          retryCount < 1 &&
          retryAfter <= MAX_INLINE_RATE_LIMIT_RETRY_AFTER_SEC &&
          !options.request?.signal?.aborted
        );
      },
    },
    retry: {
      retries: 2,
      // Extend the plugin's default doNotRetry list [400,401,403,404,410,422,451]
      // with 429 to prevent double-handling with plugin-throttling
      doNotRetry: [400, 401, 403, 404, 410, 422, 429, 451],
    },
  });

  // Least-privilege write guard: the OAuth App `repo` scope grants broad write access,
  // but this app only permits GET requests, read-only GraphQL queries, and explicit
  // user-confirmed mutations (APPROVE_PR_MUTATION and MARK_PR_READY_MUTATION).
  client.hook.before("request", (options) => {
    const method = (options.method ?? "GET").toUpperCase();
    if (method === "GET") return;
    if (method === "POST" && options.url === "/graphql" && isAllowedGraphqlRequest(options)) return;
    throw new Error(`[github] Write operation blocked: ${method} ${options.url}. Only read queries, PR approvals, and marking draft PRs ready are permitted.`);
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
      const errResponse = (err as { response?: { headers?: Record<string, string> } }).response;
      if (status > 0) {
        let resetEpochMs: number | null = null;
        const errResetHeader = errResponse?.headers?.["x-ratelimit-reset"];
        if (errResetHeader) resetEpochMs = parseInt(errResetHeader, 10) * 1000;
        // Octokit errors store data in two shapes: err.data has the unwrapped GraphQL
        // data object, while errResponse.data is the raw HTTP body (GraphQL envelope)
        const errGraphqlCost = isGraphql
          ? ((err as { data?: { rateLimit?: { cost?: number } } }).data?.rateLimit?.cost
            ?? (errResponse as { data?: { data?: { rateLimit?: { cost?: number } } } } | undefined)?.data?.data?.rateLimit?.cost)
          : undefined;
        const info: ApiRequestInfo = {
          url: options.url, method, status, isGraphql, apiSource, resetEpochMs, graphqlCost: errGraphqlCost,
        };
        for (const cb of _requestCallbacks) { try { cb(info); } catch { /* swallow */ } }
      }
      const errHeaders = errResponse?.headers;
      if (errHeaders) {
        try {
          if (isGraphql) {
            updateGraphqlRateLimitFromHeaders(errHeaders);
          } else {
            updateRateLimitFromHeaders(errHeaders);
          }
        } catch { /* never mask the original error */ }
      }
      throw err;
    }

    // Success path — fire callbacks (api-usage.ts registers at module scope) and update RL display
    const headers = (response.headers ?? {}) as Record<string, string>;
    const resetHeader = headers["x-ratelimit-reset"];
    const resetEpochMs = resetHeader ? parseInt(resetHeader, 10) * 1000 : null;
    const bodyRateLimit = isGraphql
      ? (response.data as { data?: { rateLimit?: { cost?: number } } })?.data?.rateLimit
      : undefined;
    const graphqlCost = bodyRateLimit?.cost ?? undefined;
    const info: ApiRequestInfo = {
      url: options.url, method, status, isGraphql, apiSource, resetEpochMs, graphqlCost,
    };
    for (const cb of _requestCallbacks) { try { cb(info); } catch { /* swallow */ } }

    if (response.headers && !isGraphql) {
      updateRateLimitFromHeaders(response.headers as Record<string, string>);
    } else if (isGraphql && !bodyRateLimit) {
      updateGraphqlRateLimitFromHeaders(headers);
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
export async function fetchRateLimitDetails(clientOverride?: GitHubOctokitInstance): Promise<{ core: RateLimitInfo; graphql: RateLimitInfo } | null> {
  // Return cached result within 5-second staleness window
  if (_lastFetchResult !== null && Date.now() - _lastFetchTime < 5000) {
    _setCoreRateLimit(_lastFetchResult.core);
    _setGraphqlRateLimit(_lastFetchResult.graphql);
    return { ..._lastFetchResult };
  }

  const client = clientOverride ?? getClient();
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
    _setCoreRateLimit(result.core);
    _setGraphqlRateLimit(result.graphql);
    return { ...result };
  } catch {
    return null;
  }
}
