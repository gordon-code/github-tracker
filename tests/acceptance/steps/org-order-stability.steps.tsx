import { vi, expect, afterAll } from "vitest";

// vitest-cucumber maps each Given/When/Then to a separate test(). The DOM must
// persist across steps within a scenario, but @solidjs/testing-library registers
// afterEach(cleanup) at import time — vi.hoisted ensures the env var is set
// BEFORE that import evaluates. Manual cleanup in AfterEachScenario replaces it.
vi.hoisted(() => {
  process.env.STL_SKIP_AUTO_CLEANUP = "true";
});
import type { RepoEntry, OrgEntry } from "../../../src/app/services/api";

// Mock getClient before importing component
const mockRequest = vi.fn().mockResolvedValue({ data: {} });
vi.mock("../../../src/app/services/github", () => ({
  getClient: () => ({ request: mockRequest }),
}));

vi.mock("../../../src/app/stores/auth", () => ({
  user: () => ({ login: "alice", name: "Alice", avatar_url: "" }),
  token: () => "fake-token",
  onAuthCleared: vi.fn(),
}));

vi.mock("../../../src/app/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/app/services/api")>();
  return {
    ...actual,
    fetchOrgs: vi.fn().mockResolvedValue([]),
    fetchRepos: vi.fn(),
    discoverUpstreamRepos: vi.fn().mockResolvedValue([]),
  };
});

import * as api from "../../../src/app/services/api";
import RepoSelector from "../../../src/app/components/onboarding/RepoSelector";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { render, screen, waitFor, fireEvent, cleanup } from "@solidjs/testing-library";

const feature = await loadFeature("../org-order-stability.feature");

// STL_SKIP_AUTO_CLEANUP is file-scoped (Vitest isolates each file in its own
// module context), but clean it up explicitly so the env doesn't leak if
// Vitest's isolation model changes in future versions.
afterAll(() => {
  delete process.env.STL_SKIP_AUTO_CLEANUP;
});

// ── Org entry fixtures ────────────────────────────────────────────────────────
const aliceEntry = { login: "alice", avatarUrl: "", type: "user" as const };
const acmeEntry = { login: "acme-corp", avatarUrl: "", type: "org" as const };
const betaEntry = { login: "beta-org", avatarUrl: "", type: "org" as const };
const deltaEntry = { login: "delta-inc", avatarUrl: "", type: "org" as const };

// ── Helper: create one repo per org ──────────────────────────────────────────
function makeOrgRepos(org: string): RepoEntry[] {
  return [
    {
      owner: org,
      name: `${org}-repo`,
      fullName: `${org}/${org}-repo`,
      pushedAt: "2026-03-20T10:00:00Z",
    },
  ];
}

// ── Helper: flat (non-accordion) org header order ────────────────────────────
// Org names follow GitHub's [A-Za-z0-9-] pattern — no regex escaping needed.
function getOrgHeaderOrder(orgNames: string[]): string[] {
  const escaped = orgNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`^(${escaped.join("|")})$`);
  return screen.getAllByText(pattern).map((el) => el.textContent!);
}

// ── Helper: accordion (6+ orgs) org header order ─────────────────────────────
function getAccordionOrder(orgNames: string[]): string[] {
  return orgNames
    .map((name) => ({ name, btn: screen.getByRole("button", { name: new RegExp(name) }) }))
    .sort((a, b) => {
      const pos = a.btn.compareDocumentPosition(b.btn);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    })
    .map(({ name }) => name);
}

// ── State shared across steps within a scenario ───────────────────────────────
let setSelectedOrgs: (orgs: string[]) => void = () => {};
let setOrgEntries: (entries: OrgEntry[]) => void = () => {};

describeFeature(feature, ({ Scenario, Background, BeforeEachScenario, AfterEachScenario }) => {
  BeforeEachScenario(() => {
    vi.clearAllMocks();
    mockRequest.mockResolvedValue({ data: {} });
    vi.mocked(api.fetchOrgs).mockResolvedValue([]);
    vi.mocked(api.discoverUpstreamRepos).mockResolvedValue([]);
    setSelectedOrgs = () => {};
    setOrgEntries = () => {};
  });

  AfterEachScenario(() => {
    cleanup();
  });

  // Background is handled by module-level vi.mock for auth store.
  Background(({ Given }) => {
    Given("the user is authenticated with a GitHub account", () => {
      // Auth mock is set at module level — nothing to do here.
    });
  });

  // ── S1: Org order remains stable after repo retry ─────────────────────────
  Scenario("S1 - Org order remains stable after repo retry", ({ Given, When, Then }) => {
    Given(
      'the RepoSelector displays 3 orgs sorted as "alice", "acme-corp", "beta-org" with beta-org showing a Retry button',
      async () => {
        vi.mocked(api.fetchRepos).mockImplementation((_client, org) => {
          if (org === "beta-org") return Promise.reject(new Error("beta load failed"));
          return Promise.resolve(makeOrgRepos(org as string));
        });

        render(() => (
          <RepoSelector
            selectedOrgs={["alice", "acme-corp", "beta-org"]}
            orgEntries={[aliceEntry, acmeEntry, betaEntry]}
            selected={[]}
            onChange={vi.fn()}
          />
        ));

        await waitFor(() => {
          screen.getByText("alice-repo");
          screen.getByText("acme-corp-repo");
          screen.getByText("Retry");
        });
      }
    );

    When(
      'the user clicks the Retry button on "beta-org" and the repos load successfully',
      async () => {
        vi.mocked(api.fetchRepos).mockImplementation((_client, org) =>
          Promise.resolve(makeOrgRepos(org as string))
        );

        fireEvent.click(screen.getByText("Retry"));

        await waitFor(() => {
          screen.getByText("beta-org-repo");
        });
      }
    );

    Then('the org header order remains "alice", "acme-corp", "beta-org"', () => {
      const order = getOrgHeaderOrder(["alice", "acme-corp", "beta-org"]);
      expect(order).toEqual(["alice", "acme-corp", "beta-org"]);
    });
  });

  // ── S2: Org order remains stable when toggling a repo checkbox ────────────
  Scenario(
    "S2 - Org order remains stable when toggling a repo checkbox",
    ({ Given, When, Then }) => {
      Given(
        'the RepoSelector displays 3 orgs sorted as "alice", "acme-corp", "beta-org" with all repos loaded',
        async () => {
          vi.mocked(api.fetchRepos).mockImplementation((_client, org) =>
            Promise.resolve(makeOrgRepos(org as string))
          );

          render(() => (
            <RepoSelector
              selectedOrgs={["alice", "acme-corp", "beta-org"]}
              orgEntries={[aliceEntry, acmeEntry, betaEntry]}
              selected={[]}
              onChange={vi.fn()}
            />
          ));

          await waitFor(() => {
            screen.getByText("alice-repo");
            screen.getByText("acme-corp-repo");
            screen.getByText("beta-org-repo");
          });
        }
      );

      When('the user toggles a repo checkbox under "acme-corp"', () => {
        const acmeCheckbox = screen.getAllByRole("checkbox").find((cb) => {
          const label = cb.closest("label");
          return label?.textContent?.includes("acme-corp-repo");
        });
        expect(acmeCheckbox).not.toBeUndefined();
        fireEvent.click(acmeCheckbox!);
      });

      Then('the org header order remains "alice", "acme-corp", "beta-org"', () => {
        const order = getOrgHeaderOrder(["alice", "acme-corp", "beta-org"]);
        expect(order).toEqual(["alice", "acme-corp", "beta-org"]);
      });
    }
  );

  // ── S3: Frozen order invalidated when a new org is granted ────────────────
  Scenario(
    "S3 - Frozen order invalidated when a new org is granted",
    ({ Given, When, Then }) => {
      Given(
        'the RepoSelector displays 2 orgs sorted as "alice", "delta-inc" with order frozen',
        async () => {
          vi.mocked(api.fetchRepos).mockImplementation((_client, org) =>
            Promise.resolve(makeOrgRepos(org as string))
          );

          const { createSignal } = await import("solid-js");
          const [orgs, setOrgs] = createSignal<string[]>(["alice", "delta-inc"]);
          const [entries, setEntries] = createSignal<OrgEntry[]>([aliceEntry, deltaEntry]);

          setSelectedOrgs = setOrgs;
          setOrgEntries = setEntries;

          render(() => (
            <RepoSelector
              selectedOrgs={orgs()}
              orgEntries={entries()}
              selected={[]}
              onChange={vi.fn()}
            />
          ));

          await waitFor(() => {
            screen.getByText("alice-repo");
            screen.getByText("delta-inc-repo");
          });
        }
      );

      When(
        'the user grants access to a new org "acme-corp" and it finishes loading',
        async () => {
          setSelectedOrgs(["alice", "delta-inc", "acme-corp"]);
          setOrgEntries([aliceEntry, deltaEntry, acmeEntry]);

          await waitFor(() => {
            screen.getByText("acme-corp-repo");
          });
        }
      );

      Then('the org header order becomes "alice", "acme-corp", "delta-inc"', () => {
        const order = getOrgHeaderOrder(["alice", "acme-corp", "delta-inc"]);
        expect(order).toEqual(["alice", "acme-corp", "delta-inc"]);
      });
    }
  );

  // ── S4: Initial sort applies personal org first ───────────────────────────
  Scenario("S4 - Initial sort applies personal org first", ({ Given, When, Then }) => {
    Given(
      'the RepoSelector is displayed with 4 orgs "charlie", "acme-corp", "beta-org", "delta-inc" where "charlie" is the personal org',
      async () => {
        vi.mocked(api.fetchRepos).mockImplementation((_client, org) =>
          Promise.resolve(makeOrgRepos(org as string))
        );

        // charlie has type "user" — sort puts it first (personal org)
        const charlieEntry = { login: "charlie", avatarUrl: "", type: "user" as const };

        render(() => (
          <RepoSelector
            selectedOrgs={["charlie", "acme-corp", "beta-org", "delta-inc"]}
            orgEntries={[charlieEntry, acmeEntry, betaEntry, deltaEntry]}
            selected={[]}
            onChange={vi.fn()}
          />
        ));
      }
    );

    When("all orgs finish loading", async () => {
      await waitFor(() => {
        screen.getByText("charlie-repo");
        screen.getByText("acme-corp-repo");
        screen.getByText("beta-org-repo");
        screen.getByText("delta-inc-repo");
      });
    });

    Then(
      'the org header order is "charlie", "acme-corp", "beta-org", "delta-inc"',
      () => {
        const order = getOrgHeaderOrder(["charlie", "acme-corp", "beta-org", "delta-inc"]);
        expect(order).toEqual(["charlie", "acme-corp", "beta-org", "delta-inc"]);
      }
    );
  });

  // ── S5: Org order stable in accordion layout after retry ────────────────
  Scenario(
    "S5 - Org order stable in accordion layout after retry",
    ({ Given, When, Then, And }) => {
      const sevenOrgs = ["alice", "acme-corp", "beta-org", "charlie-co", "delta-inc", "echo-labs", "foxtrot-io"];

      Given(
        'the RepoSelector displays 7 orgs in accordion layout with "alice" first and "echo-labs" showing a Retry button',
        async () => {
          vi.mocked(api.fetchRepos).mockImplementation((_client, org) => {
            if (org === "echo-labs") return Promise.reject(new Error("echo load failed"));
            return Promise.resolve(makeOrgRepos(org as string));
          });

          const sevenEntries = sevenOrgs.map((login) => ({
            login,
            avatarUrl: "",
            type: login === "alice" ? ("user" as const) : ("org" as const),
          }));

          render(() => (
            <RepoSelector
              selectedOrgs={sevenOrgs}
              orgEntries={sevenEntries}
              selected={[]}
              onChange={vi.fn()}
            />
          ));

          // Wait for accordion mode to render, expand echo-labs to show Retry
          await waitFor(() => {
            screen.getByRole("button", { name: /alice/ });
          });

          const echoBtn = screen.getByRole("button", { name: /echo-labs/ });
          fireEvent.click(echoBtn);

          await waitFor(() => {
            screen.getByText("Retry");
          });
        }
      );

      When(
        'the user clicks Retry on "echo-labs" and its repos load successfully',
        async () => {
          vi.mocked(api.fetchRepos).mockImplementation((_client, org) =>
            Promise.resolve(makeOrgRepos(org as string))
          );

          fireEvent.click(screen.getByText("Retry"));

          await waitFor(() => {
            screen.getByText("echo-labs-repo");
          });
        }
      );

      Then(
        'the org header order remains "alice", "acme-corp", "beta-org", "charlie-co", "delta-inc", "echo-labs", "foxtrot-io"',
        () => {
          const order = getAccordionOrder(sevenOrgs);
          expect(order).toEqual(sevenOrgs);
        }
      );

      And("the currently expanded accordion panel remains expanded", () => {
        const echoBtn = screen.getByRole("button", { name: /echo-labs/ });
        expect(echoBtn.getAttribute("aria-expanded")).toBe("true");
      });
    }
  );

  // ── S6: New org appears in correct sorted position with 6+ orgs ──────────
  Scenario(
    "S6 - New org appears in correct sorted position with 6+ orgs",
    ({ Given, When, Then }) => {
      const startOrgs = ["alice", "acme-corp", "charlie-co", "delta-inc", "echo-labs", "foxtrot-io"];

      Given(
        'the RepoSelector displays 6 orgs all loaded and sorted with "alice" as the personal org',
        async () => {
          vi.mocked(api.fetchRepos).mockImplementation((_client, org) =>
            Promise.resolve(makeOrgRepos(org as string))
          );

          const startEntries = startOrgs.map((login) => ({
            login,
            avatarUrl: "",
            type: login === "alice" ? ("user" as const) : ("org" as const),
          }));

          const { createSignal } = await import("solid-js");
          const [orgs, setOrgs] = createSignal<string[]>(startOrgs);
          const [entries, setEntries] = createSignal<OrgEntry[]>(startEntries);

          setSelectedOrgs = setOrgs;
          setOrgEntries = setEntries;

          render(() => (
            <RepoSelector
              selectedOrgs={orgs()}
              orgEntries={entries()}
              selected={[]}
              onChange={vi.fn()}
            />
          ));

          // Wait for accordion mode to render
          await waitFor(() => {
            screen.getByRole("button", { name: /alice/ });
          });
        }
      );

      When(
        'the user grants access to a new org "beta-org" and it finishes loading',
        async () => {
          const newOrgs = [
            "alice",
            "acme-corp",
            "beta-org",
            "charlie-co",
            "delta-inc",
            "echo-labs",
            "foxtrot-io",
          ];
          const newEntries = newOrgs.map((login) => ({
            login,
            avatarUrl: "",
            type: login === "alice" ? ("user" as const) : ("org" as const),
          }));

          setSelectedOrgs(newOrgs);
          setOrgEntries(newEntries);

          await waitFor(() => {
            screen.getByRole("button", { name: /beta-org/ });
          });
        }
      );

      Then(
        'the org header order becomes "alice", "acme-corp", "beta-org", "charlie-co", "delta-inc", "echo-labs", "foxtrot-io"',
        () => {
          const allOrgs = [
            "alice",
            "acme-corp",
            "beta-org",
            "charlie-co",
            "delta-inc",
            "echo-labs",
            "foxtrot-io",
          ];
          const order = getAccordionOrder(allOrgs);
          expect(order).toEqual(allOrgs);
        }
      );
    }
  );

  // ── S7: Frozen order invalidated on simultaneous add and remove ───────────
  Scenario(
    "S7 - Frozen order invalidated on simultaneous add and remove",
    ({ Given, When, Then, And }) => {
      Given(
        'the RepoSelector displays 3 orgs sorted as "alice", "acme-corp", "delta-inc" with order frozen',
        async () => {
          vi.mocked(api.fetchRepos).mockImplementation((_client, org) =>
            Promise.resolve(makeOrgRepos(org as string))
          );

          const { createSignal } = await import("solid-js");
          const [orgs, setOrgs] = createSignal<string[]>(["alice", "acme-corp", "delta-inc"]);
          const [entries, setEntries] = createSignal<OrgEntry[]>([aliceEntry, acmeEntry, deltaEntry]);

          setSelectedOrgs = setOrgs;
          setOrgEntries = setEntries;

          render(() => (
            <RepoSelector
              selectedOrgs={orgs()}
              orgEntries={entries()}
              selected={[]}
              onChange={vi.fn()}
            />
          ));

          await waitFor(() => {
            screen.getByText("alice-repo");
            screen.getByText("acme-corp-repo");
            screen.getByText("delta-inc-repo");
          });
        }
      );

      When(
        'the user\'s org access changes so that "delta-inc" is removed and "beta-org" is added and beta-org finishes loading',
        async () => {
          setSelectedOrgs(["alice", "acme-corp", "beta-org"]);
          setOrgEntries([aliceEntry, acmeEntry, betaEntry]);

          await waitFor(() => {
            screen.getByText("beta-org-repo");
          });
        }
      );

      Then('the org header order becomes "alice", "acme-corp", "beta-org"', () => {
        const order = getOrgHeaderOrder(["alice", "acme-corp", "beta-org"]);
        expect(order).toEqual(["alice", "acme-corp", "beta-org"]);
      });

      And('"delta-inc" no longer appears in the list', () => {
        expect(screen.queryByText("delta-inc")).toBeNull();
      });
    }
  );
});
