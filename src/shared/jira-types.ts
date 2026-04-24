// ── Jira Cloud API response types ─────────────────────────────────────────────
// Shared between jira-client.ts and consuming components.

export type JiraStatusCategory = "new" | "indeterminate" | "done";

export interface JiraStatus {
  id: string;
  name: string;
  statusCategory: {
    id: number;
    key: JiraStatusCategory;
    name: string;
  };
}

export interface JiraPriority {
  id: string;
  name: string;
  iconUrl?: string;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  avatarUrls?: Record<string, string>;
}

export interface JiraIssueFields {
  summary: string;
  status: JiraStatus;
  priority: JiraPriority | null;
  assignee: JiraUser | null;
  project: {
    id: string;
    key: string;
    name: string;
  };
  [key: string]: unknown;
}

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: JiraIssueFields;
}

export interface JiraSearchResult {
  issues: JiraIssue[];
  total: number;
  maxResults: number;
  startAt: number;
  nextPageToken?: string;
}

export interface JiraBulkFetchResult {
  issues: JiraIssue[];
  errors?: Array<{
    issueIdsOrKeys: string[];
    status: number;
    elementErrors?: unknown;
  }>;
}

export interface JiraAccessibleResource {
  id: string;
  name: string;
  url: string;
  scopes: string[];
  avatarUrl?: string;
}

export interface JiraErrorResponse {
  errorMessages: string[];
  errors: Record<string, string>;
}

export interface JiraAuthState {
  accessToken: string;
  sealedRefreshToken: string;
  expiresAt: number;
  cloudId: string;
  siteUrl: string;
  siteName: string;
  email?: string;
}
