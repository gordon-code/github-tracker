import { createSignal, createEffect } from "solid-js";
import { Octokit } from "@octokit/core";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { cachedFetch, type ConditionalHeaders } from "../stores/cache";
import { token } from "../stores/auth";
import { pushError } from "../lib/errors";

// ── Plugin-extended Octokit class ────────────────────────────────────────────

const GitHubOctokit = Octokit.plugin(throttling, retry, paginateRest);

// ── Types ────────────────────────────────────────────────────────────────────

type GitHubOctokitInstance = InstanceType<typeof GitHubOctokit>;

interface RateLimitInfo {
  remaining: number;
  resetAt: Date;
}

// ── Rate limit signals ───────────────────────────────────────────────────────

const [_coreRateLimit, _setCoreRateLimit] = createSignal<RateLimitInfo | null>(null);
const [_searchRateLimit, _setSearchRateLimit] = createSignal<RateLimitInfo | null>(null);

export function getCoreRateLimit(): RateLimitInfo | null {
  return _coreRateLimit();
}

export function getSearchRateLimit(): RateLimitInfo | null {
  return _searchRateLimit();
}

/** @deprecated Use getCoreRateLimit() instead */
export function getRateLimit(): RateLimitInfo | null {
  return _coreRateLimit();
}

export function updateRateLimitFromHeaders(
  headers: Record<string, string>,
  resource: "core" | "search" = "core"
): void {
  const remaining = headers["x-ratelimit-remaining"];
  const reset = headers["x-ratelimit-reset"];
  if (remaining !== undefined && reset !== undefined) {
    const info = {
      remaining: parseInt(remaining, 10),
      resetAt: new Date(parseInt(reset, 10) * 1000),
    };
    if (resource === "search") {
      _setSearchRateLimit(info);
    } else {
      _setCoreRateLimit(info);
    }
  }
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
        pushError("rate-limit", `Rate limit hit — retrying in ${retryAfter}s`, true);
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
        pushError("rate-limit", `Secondary rate limit — retrying in ${retryAfter}s. Consider reducing tracked repos.`, true);
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
    if (method === "POST" && options.url.endsWith("/graphql")) return;
    throw new Error(`[github] Write operation blocked: ${method} ${options.url}. This app is read-only.`);
  });

  return client;
}

// ── ETag-aware request wrapper ───────────────────────────────────────────────

export async function cachedRequest(
  octokit: GitHubOctokitInstance,
  cacheKey: string,
  route: string,
  params?: Record<string, unknown>,
  maxAge?: number,
  resource: "core" | "search" = "core"
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

      updateRateLimitFromHeaders(headers, resource);

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

const [_client, _setClient] = createSignal<GitHubOctokitInstance | null>(null);

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
      _setClient(createGitHubClient(currentToken));
    } else {
      _setClient(null);
    }
  });
}
