import { createSignal, createEffect } from "solid-js";
import { Octokit } from "@octokit/core";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { cachedFetch } from "../stores/cache";
import { token } from "../stores/auth";

// ── Plugin-extended Octokit class ────────────────────────────────────────────

const GitHubOctokit = Octokit.plugin(throttling, retry, paginateRest);

// ── Types ────────────────────────────────────────────────────────────────────

type GitHubOctokitInstance = InstanceType<typeof GitHubOctokit>;

interface RateLimitInfo {
  remaining: number;
  resetAt: Date;
}

// ── Rate limit signal ────────────────────────────────────────────────────────

const [_rateLimit, _setRateLimit] = createSignal<RateLimitInfo | null>(null);

export function getRateLimit(): RateLimitInfo | null {
  return _rateLimit();
}

function updateRateLimitFromHeaders(
  headers: Record<string, string>
): void {
  const remaining = headers["x-ratelimit-remaining"];
  const reset = headers["x-ratelimit-reset"];
  if (remaining !== undefined && reset !== undefined) {
    _setRateLimit({
      remaining: parseInt(remaining, 10),
      resetAt: new Date(parseInt(reset, 10) * 1000),
    });
  }
}

// ── Client factory ───────────────────────────────────────────────────────────

export function createGitHubClient(token: string): GitHubOctokitInstance {
  return new GitHubOctokit({
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
        return retryCount < 1;
      },
      onSecondaryRateLimit: (
        retryAfter: number,
        options: { method: string; url: string }
      ) => {
        console.warn(
          `[github] Secondary rate limit for ${options.method} ${options.url}. Retry after ${retryAfter}s.`
        );
        return true;
      },
    },
    retry: {
      retries: 2,
    },
  });
}

// ── ETag-aware request wrapper ───────────────────────────────────────────────

export async function cachedRequest(
  octokit: GitHubOctokitInstance,
  cacheKey: string,
  route: string,
  params?: Record<string, unknown>,
  maxAge?: number
): Promise<{ data: unknown; fromCache: boolean }> {
  return cachedFetch(cacheKey, async (etag) => {
    const requestParams: Record<string, unknown> = {
      ...params,
      headers: {
        ...(etag ? { "If-None-Match": etag } : {}),
      },
    };

    try {
      const response = await octokit.request(route, requestParams);
      const responseEtag =
        (response.headers as Record<string, string>)["etag"] ?? null;

      updateRateLimitFromHeaders(
        response.headers as Record<string, string>
      );

      return {
        data: response.data as unknown,
        etag: responseEtag,
        status: 200,
      };
    } catch (err) {
      // Octokit throws RequestError with status 304 instead of returning a response
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { status?: number }).status === 304
      ) {
        return { data: null, etag: null, status: 304 };
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
