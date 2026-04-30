import type { IJiraClient } from "./jira-client";
import { JiraApiError } from "./jira-client";
import type { JiraIssue } from "../../shared/jira-types";
import { extractJiraKeys } from "../../shared/validation";

// Plain Map — not a module-level SolidJS signal (avoids cross-test pollution)
let _jiraKeyCache = new Map<string, JiraIssue | null>();
const JIRA_KEY_CACHE_CAP = 500;

export function clearJiraKeyCache(): void {
  _jiraKeyCache = new Map();
}

// Evict oldest entries to make room — call before writing `incoming` new entries.
function evictToFit(incoming: number): void {
  const excess = _jiraKeyCache.size + incoming - JIRA_KEY_CACHE_CAP;
  if (excess <= 0) return;
  const iter = _jiraKeyCache.keys();
  for (let i = 0; i < excess; i++) {
    const key = iter.next().value;
    if (key !== undefined) _jiraKeyCache.delete(key);
  }
}

export async function lookupKeys(
  keys: string[],
  client: IJiraClient
): Promise<Map<string, JiraIssue | null>> {
  if (keys.length === 0) return new Map<string, JiraIssue | null>();

  const uncached = keys.filter((k) => !_jiraKeyCache.has(k));

  if (uncached.length > 0) {
    try {
      // bulkFetch batches all uncached keys in a single round-trip
      const result = await client.bulkFetch(uncached);
      const byKey = new Map(result.issues.map((i) => [i.key, i]));

      // Mark errors as null (not found / inaccessible)
      const errored = new Set(
        (result.errors ?? []).flatMap((e) => e.issueIdsOrKeys)
      );

      evictToFit(uncached.length);
      for (const key of uncached) {
        if (errored.has(key)) {
          _jiraKeyCache.set(key, null);
        } else if (byKey.has(key)) {
          _jiraKeyCache.set(key, byKey.get(key)!);
        } else {
          _jiraKeyCache.set(key, null);
        }
      }
    } catch (err) {
      if (err instanceof JiraApiError) {
        // Cache null for all keys in the failed batch — don't throw, return partial map
        evictToFit(uncached.length);
        for (const key of uncached) {
          _jiraKeyCache.set(key, null);
        }
      } else {
        // Network error — fall back to concurrent individual getIssue calls
        // (CORS for POST to api.atlassian.com with OAuth Bearer is verified working)
        const results = await Promise.allSettled(
          uncached.map((k) => client.getIssue(k))
        );
        evictToFit(uncached.length);
        for (let i = 0; i < uncached.length; i++) {
          const r = results[i];
          _jiraKeyCache.set(uncached[i], r.status === "fulfilled" ? r.value : null);
        }
      }
    }
  }

  const result = new Map<string, JiraIssue | null>();
  for (const k of keys) {
    if (_jiraKeyCache.has(k)) result.set(k, _jiraKeyCache.get(k)!);
  }
  return result;
}

export async function detectAndLookupJiraKeys(
  items: Array<{ title: string; headRef?: string }>,
  client: IJiraClient
): Promise<Map<string, JiraIssue | null>> {
  const allKeys = new Set<string>();
  for (const item of items) {
    for (const k of extractJiraKeys(item.title)) allKeys.add(k);
    if (item.headRef) {
      for (const k of extractJiraKeys(item.headRef)) allKeys.add(k);
    }
  }
  return lookupKeys([...allKeys], client);
}
