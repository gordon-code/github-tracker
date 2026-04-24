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

function evictIfAtCap(): void {
  if (_jiraKeyCache.size >= JIRA_KEY_CACHE_CAP) {
    const oldest = _jiraKeyCache.keys().next().value;
    if (oldest !== undefined) _jiraKeyCache.delete(oldest);
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

      for (const key of uncached) {
        evictIfAtCap();
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
        for (const key of uncached) {
          evictIfAtCap();
          _jiraKeyCache.set(key, null);
        }
      } else {
        // CORS or network error — fall back to concurrent individual getIssue calls
        const results = await Promise.allSettled(
          uncached.map((k) => client.getIssue(k))
        );
        for (let i = 0; i < uncached.length; i++) {
          evictIfAtCap();
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
