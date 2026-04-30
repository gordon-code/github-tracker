import { DEFAULT_FIELDS, JiraClient, JiraProxyClient, type IJiraClient } from "../services/jira-client";
import { jiraAuth, ensureJiraTokenValid } from "../stores/auth";

const VALID_FIELD_ID = /^[a-zA-Z0-9_\-]+$/;

export function mergeCustomFields(customFields: Array<{ id: string }>): string[] {
  const ids = customFields.map((f) => f.id).filter((id) => VALID_FIELD_ID.test(id));
  return [...DEFAULT_FIELDS, ...ids];
}

export function createJiraClient(
  authMethod: "oauth" | "token" | undefined,
  onResealed?: (resealed: string) => void,
): IJiraClient | null {
  if (!authMethod) return null;
  const auth = jiraAuth();
  if (!auth) return null;
  if (authMethod === "token") {
    if (!auth.email) return null;
    return new JiraProxyClient(auth.cloudId, auth.email, auth.accessToken, onResealed);
  }
  return new JiraClient(auth.cloudId, async () => {
    await ensureJiraTokenValid();
    const currentAuth = jiraAuth();
    if (!currentAuth) throw new Error("Jira auth cleared during token refresh");
    return currentAuth.accessToken;
  });
}

export function jiraJqlForScope(scope: string): string {
  const builtinFields: Record<string, string> = {
    assigned: "assignee = currentUser()",
    reported: "reporter = currentUser()",
    watching: "watcher = currentUser()",
  };
  if (builtinFields[scope]) {
    return `${builtinFields[scope]} AND statusCategory != Done ORDER BY priority DESC`;
  }
  if (!VALID_FIELD_ID.test(scope)) {
    return `assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC`;
  }
  return `${scope} in (currentUser()) AND statusCategory != Done ORDER BY priority DESC`;
}
