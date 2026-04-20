export interface FilterChipGroupDef {
  label: string;
  field: string;
  options: { value: string; label: string }[];
  defaultValue?: string; // When set, replaces "all" as the "no filter active" value
}

export const scopeFilterGroup: FilterChipGroupDef = {
  label: "Scope",
  field: "scope",
  defaultValue: "involves_me",
  options: [
    { value: "involves_me", label: "Involves me" },
    { value: "all", label: "All activity" },
  ],
};

// Shared filter group definitions — used by tab components and CustomTabModal
export const issueFilterGroups: FilterChipGroupDef[] = [
  {
    label: "Role",
    field: "role",
    options: [
      { value: "author", label: "Author" },
      { value: "assignee", label: "Assignee" },
    ],
  },
  {
    label: "Comments",
    field: "comments",
    options: [
      { value: "has", label: "Has comments" },
      { value: "none", label: "No comments" },
    ],
  },
];

export const prFilterGroups: FilterChipGroupDef[] = [
  {
    label: "Role",
    field: "role",
    options: [
      { value: "author", label: "Author" },
      { value: "reviewer", label: "Reviewer" },
      { value: "assignee", label: "Assignee" },
    ],
  },
  {
    label: "Review",
    field: "reviewDecision",
    options: [
      { value: "APPROVED", label: "Approved" },
      { value: "CHANGES_REQUESTED", label: "Changes" },
      { value: "REVIEW_REQUIRED", label: "Needs review" },
      { value: "mergeable", label: "Mergeable" },
    ],
  },
  {
    label: "Status",
    field: "draft",
    options: [
      { value: "draft", label: "Draft" },
      { value: "ready", label: "Ready" },
    ],
  },
  {
    label: "Checks",
    field: "checkStatus",
    options: [
      { value: "success", label: "Passing" },
      { value: "failure", label: "Failing" },
      { value: "pending", label: "Pending" },
      { value: "conflict", label: "Conflict" },
      { value: "blocked", label: "Blocked" },
      { value: "none", label: "No CI" },
    ],
  },
  {
    label: "Size",
    field: "sizeCategory",
    options: [
      { value: "XS", label: "XS" },
      { value: "S", label: "S" },
      { value: "M", label: "M" },
      { value: "L", label: "L" },
      { value: "XL", label: "XL" },
    ],
  },
];

// Concrete conclusion/event values used for "other" exclusion logic.
// Shared between ActionsTab (rendering) and DashboardPage (badge counts).
export const KNOWN_CONCLUSIONS = ["success", "failure", "cancelled"] as const;
export const KNOWN_EVENTS = ["push", "pull_request", "schedule", "workflow_dispatch"] as const;

export const actionsFilterGroups: FilterChipGroupDef[] = [
  {
    label: "Result",
    field: "conclusion",
    options: [
      { value: "success", label: "Success" },
      { value: "failure", label: "Failure" },
      { value: "cancelled", label: "Cancelled" },
      { value: "running", label: "Running" },
      { value: "other", label: "Other" },
    ],
  },
  {
    label: "Trigger",
    field: "event",
    options: [
      { value: "push", label: "Push" },
      { value: "pull_request", label: "PR" },
      { value: "schedule", label: "Schedule" },
      { value: "workflow_dispatch", label: "Manual" },
    ],
  },
];
