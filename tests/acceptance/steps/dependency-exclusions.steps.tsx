import { vi, expect, afterAll } from "vitest";

// vitest-cucumber maps each Given/When/Then to a separate test(). The DOM must
// persist across steps within a scenario, but @solidjs/testing-library registers
// afterEach(cleanup) at import time — vi.hoisted ensures the env var is set
// BEFORE that import evaluates. Manual cleanup in AfterEachScenario replaces it.
vi.hoisted(() => {
  process.env.STL_SKIP_AUTO_CLEANUP = "true";
});

// happy-dom's localStorage lacks .clear()/.removeItem() reliably — same shim
// as SettingsPage.test.tsx, needed because stores/config and stores/auth read
// localStorage at module-evaluation time.
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

// ── Mocks — union of what DashboardPage.test.tsx and SettingsPage.test.tsx
// each mock, since this file renders both DashboardPage and SettingsPage. ────

vi.mock("@solidjs/router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../../../src/app/stores/auth", () => ({
  clearAuth: vi.fn(),
  expireToken: vi.fn(),
  token: () => "fake-token",
  user: () => ({ login: "testuser", avatar_url: "", name: "Test User" }),
  isAuthenticated: () => true,
  onAuthCleared: vi.fn(),
  DASHBOARD_STORAGE_KEY: "github-tracker:dashboard",
  DEP_META_STORAGE_KEY: "github-tracker:dep-meta",
  jiraAuth: vi.fn(() => null),
  isJiraAuthenticated: vi.fn(() => false),
  setJiraAuth: vi.fn(),
  clearJiraAuth: vi.fn(),
  clearJiraConfigFull: vi.fn(),
  ensureJiraTokenValid: vi.fn().mockResolvedValue(false),
  setAuthFromPat: vi.fn(),
}));

vi.mock("@sentry/solid", () => ({
  captureException: vi.fn(),
  withSentryErrorBoundary: vi.fn((c: unknown) => c),
}));

vi.mock("../../../src/app/stores/cache", () => ({
  clearCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/app/services/jira-client", () => ({
  JiraClient: vi.fn(),
  JiraProxyClient: vi.fn(),
}));

vi.mock("../../../src/app/services/jira-keys", () => ({
  detectAndLookupJiraKeys: vi.fn().mockResolvedValue(new Map()),
  clearJiraKeyCache: vi.fn(),
}));

vi.mock("../../../src/app/services/github", () => ({
  getCoreRateLimit: () => null,
  getGraphqlRateLimit: () => null,
  getClient: vi.fn(() => null),
  fetchRateLimitDetails: vi.fn(),
  onApiRequest: vi.fn(),
}));

// Real fetchDashboardIssueBodies/fetchDepPRBodies are kept (S4/S7 exercise them
// through a mocked octokit.graphql) — only the org/repo discovery calls are
// stubbed, matching org-order-stability.steps.tsx's partial-mock convention.
vi.mock("../../../src/app/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/app/services/api")>();
  return {
    ...actual,
    fetchOrgs: vi.fn().mockResolvedValue([]),
    fetchRepos: vi.fn().mockResolvedValue([]),
    discoverUpstreamRepos: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../../../src/app/services/poll", () => ({
  fetchAllData: vi.fn(),
  createPollCoordinator: vi.fn(),
  createHotPollCoordinator: vi.fn(),
  createEventsPollCoordinator: vi.fn(),
  rebuildHotSets: vi.fn(),
  seedHotSetsFromTargeted: vi.fn(),
  clearHotSets: vi.fn(),
  getHotPollGeneration: vi.fn().mockReturnValue(0),
}));

vi.mock("../../../src/app/lib/notifications", () => ({
  detectNewItems: vi.fn(() => []),
  dispatchNotifications: vi.fn(),
  _resetNotificationState: vi.fn(),
}));

vi.mock("../../../src/app/lib/errors", () => ({
  getErrors: vi.fn().mockReturnValue([]),
  getNotifications: vi.fn().mockReturnValue([]),
  getUnreadCount: vi.fn().mockReturnValue(0),
  markAllAsRead: vi.fn(),
  dismissError: vi.fn(),
  dismissNotificationBySource: vi.fn(),
  pushError: vi.fn(),
  pushNotification: vi.fn(),
  clearErrors: vi.fn(),
  clearNotifications: vi.fn(),
  addMutedSource: vi.fn(),
  isMuted: vi.fn(() => false),
  clearMutedSources: vi.fn(),
}));

vi.mock("../../../src/app/lib/url", () => ({
  isSafeGitHubUrl: vi.fn(() => true),
  openGitHubUrl: vi.fn(),
}));

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { render, screen, waitFor, fireEvent, cleanup } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { makeIssue, makePullRequest, makeWorkflowRun } from "../../helpers/index";

import DashboardPage from "../../../src/app/components/dashboard/DashboardPage";
import SettingsPage from "../../../src/app/components/settings/SettingsPage";
import * as pollService from "../../../src/app/services/poll";
import * as configStore from "../../../src/app/stores/config";
import * as viewStore from "../../../src/app/stores/view";
import * as githubService from "../../../src/app/services/github";

const feature = await loadFeature("../dependency-exclusions.feature");

afterAll(() => {
  delete process.env.STL_SKIP_AUTO_CLEANUP;
});

// ── Render helpers ────────────────────────────────────────────────────────────

function renderDashboard() {
  return render(() => <DashboardPage />);
}

function renderSettings() {
  return render(() => <SettingsPage />);
}

function openManageModal() {
  fireEvent.click(screen.getByRole("button", { name: "Manage" }));
}

function findCheckboxByLabelText(text: string): HTMLInputElement {
  const checkbox = screen
    .getAllByRole("checkbox")
    .find((cb) => cb.closest("label")?.textContent?.includes(text));
  if (!checkbox) throw new Error(`No checkbox found for label text "${text}"`);
  return checkbox as HTMLInputElement;
}

function depBotPR(overrides: Parameters<typeof makePullRequest>[0] = {}) {
  return makePullRequest({
    userLogin: "dependabot[bot]",
    headRef: "dependabot/npm_and_yarn/pkg-1.0.0",
    ...overrides,
  });
}

describeFeature(feature, ({ Scenario, Background, BeforeEachScenario, AfterEachScenario }) => {
  BeforeEachScenario(() => {
    vi.clearAllMocks();
    configStore.resetConfig();
    viewStore.resetViewState();

    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });
    vi.mocked(pollService.createPollCoordinator).mockImplementation(
      (_getInterval: unknown, fetchAll: () => Promise<unknown>) => {
        void fetchAll().catch(() => {});
        return {
          isRefreshing: () => false,
          lastRefreshAt: () => null,
          manualRefresh: vi.fn(),
          destroy: vi.fn(),
        };
      }
    );
    vi.mocked(pollService.createHotPollCoordinator).mockImplementation(() => ({ destroy: vi.fn() }));
    vi.mocked(pollService.createEventsPollCoordinator).mockImplementation(() => ({ destroy: vi.fn() }));
    vi.mocked(githubService.getClient).mockReturnValue(null);
  });

  AfterEachScenario(() => {
    cleanup();
  });

  Background(({ Given }) => {
    Given("the user is authenticated with a GitHub account", () => {
      // Auth mock is set at module level — nothing to do here.
    });
  });

  // ── S1: Excluding a repo hides its dependency PR from the Dependencies tab ──
  Scenario(
    "S1 - Excluding a repo hides its dependency PR from the Dependencies tab",
    ({ Given, When, Then, And }) => {
      Given(
        'the user has two tracked repos, each with one open PR authored by a dependency bot (e.g. "dependabot[bot]" on a "dependabot/npm_and_yarn/..." branch), and one of those two repos is listed under Settings -> Dependencies -> Excluded repos/orgs',
        () => {
          configStore.updateConfig({
            dependencies: {
              ...configStore.config.dependencies,
              excludedRepos: [{ owner: "owner", name: "excluded-repo", fullName: "owner/excluded-repo" }],
            },
          });
          vi.mocked(pollService.fetchAllData).mockResolvedValue({
            issues: [],
            pullRequests: [
              depBotPR({
                repoFullName: "owner/excluded-repo",
                title: "Bump lodash from 4.1 to 4.2",
                headRef: "dependabot/npm_and_yarn/lodash-4.2",
              }),
              depBotPR({
                repoFullName: "owner/other-repo",
                title: "Bump axios from 0.27 to 1.0",
                headRef: "dependabot/npm_and_yarn/axios-1.0.0",
              }),
            ],
            workflowRuns: [],
            errors: [],
          });
        }
      );

      When("the user opens the Dependencies tab", async () => {
        renderDashboard();
        await waitFor(() => screen.getByRole("tab", { name: /Dependencies/ }));
        const user = userEvent.setup();
        await user.click(screen.getByRole("tab", { name: /Dependencies/ }));
      });

      Then("only the non-excluded repo's dependency-bot PR is shown in the list", async () => {
        await waitFor(() => {
          expect(screen.getByText("axios: 0.27 → 1.0")).toBeDefined();
          expect(screen.queryByText("lodash: 4.1 → 4.2")).toBeNull();
        });
      });

      And('the Dependencies tab badge count reads "1"', () => {
        const depsTab = screen.getByRole("tab", { name: /Dependencies/ });
        expect(depsTab.textContent?.replace(/\D+/g, "")).toBe("1");
      });
    }
  );

  // ── S2: Excluding a repo leaves Issues/PRs/Actions untouched for that repo ──
  Scenario(
    "S2 - Excluding a repo leaves Issues/Pull Requests/Actions untouched for that repo",
    ({ Given, When, Then }) => {
      const ISSUE_TITLE = "Fix login redirect bug";
      const PR_TITLE = "Add dark mode support";

      Given(
        "a repo is excluded from the Dependencies tab and has one open non-bot issue, one open non-bot pull request, and one workflow run, all visible before the exclusion was set",
        () => {
          configStore.updateConfig({
            dependencies: {
              ...configStore.config.dependencies,
              excludedRepos: [{ owner: "owner", name: "repo", fullName: "owner/repo" }],
            },
          });
          vi.mocked(pollService.fetchAllData).mockResolvedValue({
            issues: [makeIssue({ title: ISSUE_TITLE, userLogin: "developer", state: "OPEN" })],
            pullRequests: [makePullRequest({ title: PR_TITLE, userLogin: "developer" })],
            workflowRuns: [makeWorkflowRun({ isPrRun: false })],
            errors: [],
          });
        }
      );

      When(
        "the user views the Issues, Pull Requests, and Actions tabs after excluding the repo",
        async () => {
          renderDashboard();
          const user = userEvent.setup();
          await waitFor(() => screen.getByLabelText("Expand all repos"));
          await user.click(screen.getByLabelText("Expand all repos"));
          await waitFor(() => screen.getByText(ISSUE_TITLE));
          await user.click(screen.getByRole("tab", { name: /Pull Requests/ }));
          await user.click(screen.getByLabelText("Expand all repos"));
          await waitFor(() => screen.getByText(PR_TITLE));
          await user.click(screen.getByRole("tab", { name: /Actions/ }));
          await waitFor(() => screen.getByText("Show PR runs"));
        }
      );

      Then(
        "the same issue, pull request, and workflow run are still listed exactly as before exclusion, with the same titles, same tab, and same counts",
        () => {
          expect(screen.getByRole("tab", { name: /Issues/ }).textContent?.replace(/\D+/g, "")).toBe("1");
          expect(screen.getByRole("tab", { name: /Pull Requests/ }).textContent?.replace(/\D+/g, "")).toBe("1");
          expect(screen.getByRole("tab", { name: /Actions/ }).textContent?.replace(/\D+/g, "")).toBe("1");
        }
      );
    }
  );

  // ── S3: Excluded repo's bot PR does not leak into the Pull Requests tab ─────
  Scenario(
    "S3 - Excluded repo's bot PR does not leak into the Pull Requests tab",
    ({ Given, When, Then, And }) => {
      const S3_REPO = { owner: "owner", name: "leaky-repo", fullName: "owner/leaky-repo" };

      Given(
        "a repo has an open dependency-bot PR, and that PR does not currently appear on the standard Pull Requests tab",
        async () => {
          vi.mocked(pollService.fetchAllData).mockResolvedValue({
            issues: [],
            pullRequests: [
              depBotPR({
                repoFullName: S3_REPO.fullName,
                title: "Bump lodash from 4.1 to 4.2",
                headRef: "dependabot/npm_and_yarn/lodash-4.2",
              }),
            ],
            workflowRuns: [],
            errors: [],
          });
          renderDashboard();
          await waitFor(() => {
            const prTab = screen.getByRole("tab", { name: /Pull Requests/ });
            expect(prTab.textContent?.replace(/\D+/g, "")).toBe("0");
          });
        }
      );

      When("the user excludes that repo from Dependencies in Settings", () => {
        configStore.updateConfig({
          dependencies: { ...configStore.config.dependencies, excludedRepos: [S3_REPO] },
        });
      });

      Then("the bot PR disappears from the Dependencies tab", async () => {
        await waitFor(() => {
          expect(screen.queryByRole("tab", { name: /Dependencies/ })).toBeNull();
        });
      });

      And("the bot PR still does not appear on the standard Pull Requests tab", () => {
        const prTab = screen.getByRole("tab", { name: /Pull Requests/ });
        expect(prTab.textContent?.replace(/\D+/g, "")).toBe("0");
      });
    }
  );

  // ── S4: Excluding a repo also hides its Renovate abandoned-package badges ──
  Scenario(
    "S4 - Excluding a repo also hides its Renovate abandoned-package badges",
    ({ Given, When, Then }) => {
      const S4_REPO = { owner: "owner", name: "abandon-repo", fullName: "owner/abandon-repo" };

      Given(
        'a repo has an open "Dependency Dashboard" issue whose body lists one package under "Ignored or Blocked", rendered as an "Abandoned" badge on that repo\'s entry in the Dependencies tab',
        async () => {
          vi.mocked(pollService.fetchAllData).mockResolvedValue({
            issues: [
              makeIssue({
                title: "Dependency Dashboard",
                userLogin: "renovate[bot]",
                nodeId: "DASH_S4",
                repoFullName: S4_REPO.fullName,
                state: "OPEN",
              }),
            ],
            pullRequests: [
              depBotPR({
                repoFullName: S4_REPO.fullName,
                title: "Bump lodash from 4.1 to 4.2",
                headRef: "dependabot/npm_and_yarn/lodash-4.2",
              }),
            ],
            workflowRuns: [],
            errors: [],
          });

          const graphqlSpy = vi.fn().mockResolvedValue({
            nodes: [
              {
                id: "DASH_S4",
                body: "## Abandoned\n| Datasource | Package | Last Updated |\n|---|---|---|\n| npm | lodash | 2023-01-15 |\n",
              },
            ],
            rateLimit: null,
          });
          vi.mocked(githubService.getClient).mockReturnValue(
            { graphql: graphqlSpy } as unknown as ReturnType<typeof githubService.getClient>
          );
          vi.mocked(pollService.createPollCoordinator).mockImplementation(
            (_getInterval: unknown, fetchAll: () => Promise<unknown>) => {
              const [lastRefreshAt, setLastRefreshAt] = createSignal<Date | null>(null);
              void fetchAll().then(() => setLastRefreshAt(new Date())).catch(() => {});
              return { isRefreshing: () => false, lastRefreshAt, manualRefresh: vi.fn(), destroy: vi.fn() };
            }
          );

          renderDashboard();
          await waitFor(() => expect(graphqlSpy).toHaveBeenCalled());

          const user = userEvent.setup();
          await waitFor(() => screen.getByRole("tab", { name: /Dependencies/ }));
          await user.click(screen.getByRole("tab", { name: /Dependencies/ }));
          await waitFor(() => screen.getByText("Abandoned"));
        }
      );

      When(
        "the user excludes that repo from Dependencies in Settings and returns to the Dependencies tab",
        () => {
          configStore.updateConfig({
            dependencies: { ...configStore.config.dependencies, excludedRepos: [S4_REPO] },
          });
        }
      );

      Then('the "Abandoned" badge for that repo is no longer shown anywhere on the tab', async () => {
        await waitFor(() => {
          expect(screen.queryByText("Abandoned")).toBeNull();
        });
      });
    }
  );

  // ── S5: Excluding an org via the checkbox tree hides all its repos' PRs ─────
  Scenario(
    "S5 - Excluding an org via the checkbox tree hides all its repos' dependency PRs",
    ({ Given, When, Then }) => {
      const ORG = "big-org";
      const REPOS = [
        { owner: ORG, name: "repo1", fullName: `${ORG}/repo1` },
        { owner: ORG, name: "repo2", fullName: `${ORG}/repo2` },
        { owner: ORG, name: "repo3", fullName: `${ORG}/repo3` },
      ];

      Given("the user tracks 3 repos under one org, 2 of which have an open dependency-bot PR", () => {
        configStore.updateConfig({ selectedRepos: REPOS });
        vi.mocked(pollService.fetchAllData).mockResolvedValue({
          issues: [],
          pullRequests: [
            depBotPR({
              repoFullName: REPOS[0]!.fullName,
              title: "Bump lodash from 4.1 to 4.2",
              headRef: "dependabot/npm_and_yarn/lodash-4.2",
            }),
            depBotPR({
              repoFullName: REPOS[1]!.fullName,
              title: "Bump axios from 0.27 to 1.0",
              headRef: "dependabot/npm_and_yarn/axios-1.0.0",
            }),
          ],
          workflowRuns: [],
          errors: [],
        });
      });

      When("the user opens the Manage Dependencies-Exclusions modal and checks that org's checkbox", () => {
        renderSettings();
        openManageModal();
        fireEvent.click(findCheckboxByLabelText(ORG));
      });

      Then("all 3 of that org's nested repo checkboxes immediately show as checked and disabled", () => {
        for (const repo of REPOS) {
          const cb = findCheckboxByLabelText(repo.name);
          expect(cb.checked).toBe(true);
          expect(cb.disabled).toBe(true);
        }
      });

      When("the user then clicks Save", () => {
        fireEvent.click(screen.getByRole("button", { name: /save/i }));
      });

      Then("neither of the org's dependency-bot PRs appears in the Dependencies tab", async () => {
        cleanup();
        renderDashboard();
        await waitFor(() => {
          expect(screen.queryByRole("tab", { name: /Dependencies/ })).toBeNull();
        });
      });
    }
  );

  // ── S6: Org-level exclusion automatically covers a repo added later ────────
  Scenario(
    "S6 - Org-level exclusion automatically covers a repo added to that org later",
    ({ Given, When, Then, And }) => {
      const ORG = "late-org";
      const REPO = { owner: ORG, name: "late-repo", fullName: `${ORG}/late-repo` };

      Given(
        "the user has excluded an entire org from Dependencies, with no further changes made to the exclusion settings afterward",
        () => {
          configStore.updateConfig({
            dependencies: { ...configStore.config.dependencies, excludedOrgs: [ORG] },
          });
        }
      );

      When(
        "a repo under that same org is subsequently added to the user's tracked repos and that repo has an open dependency-bot PR",
        async () => {
          configStore.updateConfig({ selectedRepos: [...configStore.config.selectedRepos, REPO] });
          vi.mocked(pollService.fetchAllData).mockResolvedValue({
            issues: [],
            pullRequests: [
              depBotPR({
                repoFullName: REPO.fullName,
                title: "Bump lodash from 4.1 to 4.2",
                headRef: "dependabot/npm_and_yarn/lodash-4.2",
              }),
            ],
            workflowRuns: [],
            errors: [],
          });
          renderDashboard();
          await waitFor(() => screen.getByRole("tab", { name: /Issues/ }));
        }
      );

      Then("that repo's dependency-bot PR does not appear in the Dependencies tab", async () => {
        await waitFor(() => {
          expect(screen.queryByRole("tab", { name: /Dependencies/ })).toBeNull();
        });
      });

      And(
        "the Manage modal, if reopened, shows that repo's checkbox as checked and disabled without the user having touched it directly",
        () => {
          cleanup();
          renderSettings();
          openManageModal();
          const cb = findCheckboxByLabelText(REPO.name);
          expect(cb.checked).toBe(true);
          expect(cb.disabled).toBe(true);
        }
      );
    }
  );

  // ── S7: Un-excluding a repo restores its PRs and abandoned-package badges ──
  Scenario(
    "S7 - Un-excluding a repo restores its dependency PRs and abandoned-package badges",
    ({ Given, When, Then, And }) => {
      const REPO = { owner: "owner", name: "restore-repo", fullName: "owner/restore-repo" };

      Given(
        'a repo was excluded at the repo level, not inherited from an org exclusion, and it has an open dependency-bot PR and an "Abandoned" badge',
        () => {
          configStore.updateConfig({
            selectedRepos: [REPO],
            dependencies: { ...configStore.config.dependencies, excludedRepos: [REPO] },
          });
          vi.mocked(pollService.fetchAllData).mockResolvedValue({
            issues: [
              makeIssue({
                title: "Dependency Dashboard",
                userLogin: "renovate[bot]",
                nodeId: "DASH_S7",
                repoFullName: REPO.fullName,
                state: "OPEN",
              }),
            ],
            pullRequests: [
              depBotPR({
                repoFullName: REPO.fullName,
                title: "Bump lodash from 4.1 to 4.2",
                headRef: "dependabot/npm_and_yarn/lodash-4.2",
              }),
            ],
            workflowRuns: [],
            errors: [],
          });
          const graphqlSpy = vi.fn().mockResolvedValue({
            nodes: [
              {
                id: "DASH_S7",
                body: "## Abandoned\n| Datasource | Package | Last Updated |\n|---|---|---|\n| npm | lodash | 2023-01-15 |\n",
              },
            ],
            rateLimit: null,
          });
          vi.mocked(githubService.getClient).mockReturnValue(
            { graphql: graphqlSpy } as unknown as ReturnType<typeof githubService.getClient>
          );
          vi.mocked(pollService.createPollCoordinator).mockImplementation(
            (_getInterval: unknown, fetchAll: () => Promise<unknown>) => {
              const [lastRefreshAt, setLastRefreshAt] = createSignal<Date | null>(null);
              void fetchAll().then(() => setLastRefreshAt(new Date())).catch(() => {});
              return { isRefreshing: () => false, lastRefreshAt, manualRefresh: vi.fn(), destroy: vi.fn() };
            }
          );
        }
      );

      When("the user opens the Manage modal, unchecks that repo's checkbox, and clicks Save", () => {
        renderSettings();
        openManageModal();
        const cb = findCheckboxByLabelText(REPO.name);
        expect(cb.checked).toBe(true);
        fireEvent.click(cb);
        fireEvent.click(screen.getByRole("button", { name: /save/i }));
      });

      Then("the repo's dependency-bot PR reappears in the Dependencies tab", async () => {
        cleanup();
        renderDashboard();
        const user = userEvent.setup();
        await waitFor(() => screen.getByRole("tab", { name: /Dependencies/ }));
        await user.click(screen.getByRole("tab", { name: /Dependencies/ }));
        await waitFor(() => screen.getByText("lodash: 4.1 → 4.2"));
      });

      And('its "Abandoned" badge is shown again', async () => {
        await waitFor(() => screen.getByText("Abandoned"));
      });
    }
  );

  // ── S8: Exclusion pool spans selected, upstream, and monitored repos ───────
  Scenario(
    "S8 - Exclusion picker's available pool spans selected, upstream, and monitored repos",
    ({ Given, When, Then }) => {
      const SELECTED = { owner: "org-a", name: "repo-a", fullName: "org-a/repo-a" };
      const UPSTREAM = { owner: "org-b", name: "repo-b", fullName: "org-b/repo-b" };
      const MONITORED = { owner: "org-c", name: "repo-c", fullName: "org-c/repo-c" };

      Given(
        "the user has one repo added directly in Repository Selection, one repo reachable only via an upstream fork relationship, and one repo added via Monitor-All, each under a different org",
        () => {
          // selectedRepos must be set in its own call: updateConfig prunes
          // monitoredRepos to intersect with selectedRepos whenever the
          // "selectedRepos" key is present in the same partial update.
          configStore.updateConfig({ selectedRepos: [SELECTED] });
          configStore.updateConfig({ upstreamRepos: [UPSTREAM], monitoredRepos: [MONITORED] });
        }
      );

      When("the user opens Settings -> Dependencies -> Manage", () => {
        renderSettings();
        openManageModal();
      });

      Then("all three repos and their three orgs appear as unchecked, checkable options in the tree", () => {
        for (const repo of [SELECTED, UPSTREAM, MONITORED]) {
          const orgCb = findCheckboxByLabelText(repo.owner);
          expect(orgCb.checked).toBe(false);
          expect(orgCb.disabled).toBe(false);
          const repoCb = findCheckboxByLabelText(repo.name);
          expect(repoCb.checked).toBe(false);
          expect(repoCb.disabled).toBe(false);
        }
      });
    }
  );

  // ── S9: Settings summary shows "None excluded" ──────────────────────────────
  Scenario(
    'S9 - Settings summary text shows "None excluded" with no exclusions configured',
    ({ Given, When, Then }) => {
      Given("the user has no dependency exclusions configured", () => {
        configStore.updateConfig({
          dependencies: { ...configStore.config.dependencies, excludedOrgs: [], excludedRepos: [] },
        });
      });

      When("the user views Settings -> Dependencies", () => {
        renderSettings();
      });

      Then('the "Excluded repos/orgs" row reads "None excluded"', () => {
        screen.getByText("None excluded");
      });
    }
  );

  // ── S10: Settings summary updates to reflect saved exclusion count ─────────
  Scenario(
    "S10 - Settings summary text updates to reflect a saved exclusion count",
    ({ Given, When, Then }) => {
      const REPOS = [
        { owner: "org-x", name: "repo-x1", fullName: "org-x/repo-x1" },
        { owner: "org-y", name: "repo-y1", fullName: "org-y/repo-y1" },
        { owner: "org-z", name: "repo-z1", fullName: "org-z/repo-z1" },
      ];

      Given("the user has no dependency exclusions configured", () => {
        configStore.updateConfig({
          selectedRepos: REPOS,
          dependencies: { ...configStore.config.dependencies, excludedOrgs: [], excludedRepos: [] },
        });
      });

      When(
        "the user opens the Manage modal, checks 1 org's checkbox and 2 individual repo checkboxes under different orgs, and clicks Save",
        () => {
          renderSettings();
          openManageModal();
          fireEvent.click(findCheckboxByLabelText("org-x"));
          fireEvent.click(findCheckboxByLabelText("repo-y1"));
          fireEvent.click(findCheckboxByLabelText("repo-z1"));
          fireEvent.click(screen.getByRole("button", { name: /save/i }));
        }
      );

      Then('the "Excluded repos/orgs" row on the Settings page reads "1 org, 2 repos"', () => {
        screen.getByText("1 org, 2 repos");
      });
    }
  );

  // ── S11: Canceling the exclusion modal discards unsaved changes ────────────
  Scenario(
    "S11 - Canceling the exclusion modal discards unsaved changes",
    ({ Given, When, Then, And }) => {
      const REPO = { owner: "owner", name: "cancel-repo", fullName: "owner/cancel-repo" };

      Given(
        "a repo is not excluded and has an open dependency-bot PR visible on the Dependencies tab",
        async () => {
          configStore.updateConfig({ selectedRepos: [REPO] });
          vi.mocked(pollService.fetchAllData).mockResolvedValue({
            issues: [],
            pullRequests: [
              depBotPR({
                repoFullName: REPO.fullName,
                title: "Bump lodash from 4.1 to 4.2",
                headRef: "dependabot/npm_and_yarn/lodash-4.2",
              }),
            ],
            workflowRuns: [],
            errors: [],
          });
          renderDashboard();
          const user = userEvent.setup();
          await waitFor(() => screen.getByRole("tab", { name: /Dependencies/ }));
          await user.click(screen.getByRole("tab", { name: /Dependencies/ }));
          await waitFor(() => screen.getByText("lodash: 4.1 → 4.2"));
        }
      );

      When(
        "the user opens the Manage modal, checks that repo's checkbox, and clicks Cancel instead of Save",
        () => {
          cleanup();
          renderSettings();
          openManageModal();
          fireEvent.click(findCheckboxByLabelText(REPO.name));
          fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
        }
      );

      Then("the repo's dependency-bot PR still appears on the Dependencies tab", async () => {
        cleanup();
        renderDashboard();
        const user = userEvent.setup();
        await waitFor(() => screen.getByRole("tab", { name: /Dependencies/ }));
        await user.click(screen.getByRole("tab", { name: /Dependencies/ }));
        await waitFor(() => screen.getByText("lodash: 4.1 → 4.2"));
      });

      And("reopening the Manage modal shows that repo's checkbox unchecked again", () => {
        cleanup();
        renderSettings();
        openManageModal();
        const cb = findCheckboxByLabelText(REPO.name);
        expect(cb.checked).toBe(false);
      });
    }
  );
});
