import type { IJiraClient } from "./jira-client";
import { JiraApiError } from "./jira-client";
import type { JiraIssue } from "../../shared/jira-types";
import { extractJiraKeys } from "../../shared/validation";

// Plain Map — not a module-level SolidJS signal (avoids cross-test pollution)
let _jiraKeyCache = new Map<string, JiraIssue | null>();

export function clearJiraKeyCache(): void {
  _jiraKeyCache = new Map();
}

export async function lookupKeys(
  keys: string[],
  client: IJiraClient
): Promise<Map<string, JiraIssue | null>> {
  if (keys.length === 0) return _jiraKeyCache;

  const uncached = keys.filter((k) => !_jiraKeyCache.has(k));

  if (uncached.length > 0) {
    try {
      // bulkFetch is required on IJiraClient (per reduction review) — call unconditionally
      const result = await client.bulkFetch(uncached);
      const byKey = new Map(result.issues.map((i) => [i.key, i]));

      // Mark errors as null (not found / inaccessible)
      const errored = new Set(
        (result.errors ?? []).flatMap((e) => e.issueIdsOrKeys)
      );

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
        for (const key of uncached) {
          _jiraKeyCache.set(key, null);
        }
      } else {
        // CORS or network error — fall back to sequential getIssue calls
        const results = await Promise.allSettled(
          uncached.map((k) => client.getIssue(k))
        );
        for (let i = 0; i < uncached.length; i++) {
          const r = results[i];
          _jiraKeyCache.set(uncached[i], r.status === "fulfilled" ? r.value : null);
        }
      }
    }
  }

  return _jiraKeyCache;
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
