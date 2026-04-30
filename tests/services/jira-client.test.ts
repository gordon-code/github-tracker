import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  JiraClient,
  JiraProxyClient,
  JiraApiError,
  JiraRateLimitError,
} from "../../src/app/services/jira-client";
import type { JiraIssue, JiraBulkFetchResult, JiraSearchResult, JiraAccessibleResource } from "../../src/shared/jira-types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeIssue(key = "PROJ-1"): JiraIssue {
  return {
    id: "10001",
    key,
    self: `https://api.atlassian.com/ex/jira/cloud-id/rest/api/3/issue/${key}`,
    fields: {
      summary: "Test issue summary",
      status: {
        id: "1",
        name: "In Progress",
        statusCategory: { id: 4, key: "indeterminate", name: "In Progress" },
      },
      priority: { id: "2", name: "High" },
      assignee: { accountId: "abc123", displayName: "Test User" },
      project: { id: "10000", key: "PROJ", name: "My Project" },
      updated: "2026-04-24T12:00:00.000+0000",
    },
  };
}

function makeAccessibleResource(id = "cloud-abc"): JiraAccessibleResource {
  return {
    id,
    name: "My Jira Site",
    url: "https://mysite.atlassian.net",
    scopes: ["read:jira-work", "read:jira-user"],
  };
}

// ── JiraClient (OAuth / Bearer) ───────────────────────────────────────────────

describe("JiraClient", () => {
  const cloudId = "test-cloud-id";
  const accessToken = "test-access-token";
  let client: JiraClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    client = new JiraClient(cloudId, async () => accessToken);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── getIssue ───────────────────────────────────────────────────────────────

  describe("getIssue", () => {
    it("constructs correct URL with default fields", async () => {
      const issue = makeIssue("PROJ-42");
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(issue), { status: 200 })
      );

      await client.getIssue("PROJ-42");

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/PROJ-42?fields=summary,status,priority,assignee,project,updated,issuetype,created`
      );
    });

    it("constructs correct URL with custom fields", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(makeIssue()), { status: 200 })
      );

      await client.getIssue("PROJ-1", ["summary", "status"]);

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("fields=summary,status");
    });

    it("adds Bearer Authorization header", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(makeIssue()), { status: 200 })
      );

      await client.getIssue("PROJ-1");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${accessToken}`);
    });

    it("returns null on 404", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ errorMessages: ["Issue does not exist"] }), { status: 404 })
      );

      const result = await client.getIssue("MISSING-1");
      expect(result).toBeNull();
    });

    it("returns the issue on success", async () => {
      const issue = makeIssue("PROJ-7");
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(issue), { status: 200 })
      );

      const result = await client.getIssue("PROJ-7");
      expect(result?.key).toBe("PROJ-7");
    });

    it("throws JiraApiError on non-404 HTTP error", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ errorMessages: ["Forbidden"] }), { status: 403 })
      );

      await expect(client.getIssue("PROJ-1")).rejects.toThrow(JiraApiError);
    });

    it("propagates JiraRateLimitError from request when rate-limited", async () => {
      const headers = new Headers({ "Retry-After": "30" });
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 429, headers }));

      await expect(client.getIssue("PROJ-1")).rejects.toThrow(JiraRateLimitError);
    });
  });

  // ── searchJql ─────────────────────────────────────────────────────────────

  describe("searchJql", () => {
    it("constructs correct query params", async () => {
      const result: JiraSearchResult = { issues: [], total: 0, maxResults: 50, startAt: 0 };
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }));

      await client.searchJql("assignee = currentUser()");

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(url);
      expect(parsed.pathname).toContain("/search/jql");
      expect(parsed.searchParams.get("jql")).toBe("assignee = currentUser()");
      expect(parsed.searchParams.get("maxResults")).toBe("100");
      expect(parsed.searchParams.get("startAt")).toBe("0");
      expect(parsed.searchParams.get("fields")).toContain("summary");
    });

    it("respects custom opts (maxResults, startAt, fields)", async () => {
      const result: JiraSearchResult = { issues: [], total: 0, maxResults: 10, startAt: 5 };
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }));

      await client.searchJql("project = PROJ", { maxResults: 10, startAt: 5, fields: ["summary"] });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(url);
      expect(parsed.searchParams.get("maxResults")).toBe("10");
      expect(parsed.searchParams.get("startAt")).toBe("5");
      expect(parsed.searchParams.get("fields")).toBe("summary");
    });

    it("adds Bearer header", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ issues: [], total: 0, maxResults: 100, startAt: 0 }), { status: 200 })
      );

      await client.searchJql("project = TEST");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${accessToken}`);
    });

    it("throws JiraApiError on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ errorMessages: ["Bad request"] }), { status: 400 })
      );

      await expect(client.searchJql("invalid jql")).rejects.toThrow(JiraApiError);
    });

    it("JiraApiError carries status and body", async () => {
      const body = { errorMessages: ["Some error"] };
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(body), { status: 400 })
      );

      let caught: JiraApiError | null = null;
      try {
        await client.searchJql("bad");
      } catch (e) {
        caught = e as JiraApiError;
      }

      expect(caught).toBeInstanceOf(JiraApiError);
      expect(caught?.status).toBe(400);
      expect(caught?.body).toEqual(body);
    });
  });

  // ── bulkFetch ─────────────────────────────────────────────────────────────

  describe("bulkFetch", () => {
    it("sends POST to correct endpoint with JSON body", async () => {
      const result: JiraBulkFetchResult = { issues: [makeIssue("PROJ-1"), makeIssue("PROJ-2")] };
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }));

      await client.bulkFetch(["PROJ-1", "PROJ-2"]);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/issue/bulkfetch");
      expect(init.method).toBe("POST");
      const bodyParsed = JSON.parse(init.body as string);
      expect(bodyParsed.issueIdsOrKeys).toEqual(["PROJ-1", "PROJ-2"]);
      expect(bodyParsed.fields).toContain("summary");
    });

    it("sends custom fields when provided", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ issues: [] }), { status: 200 })
      );

      await client.bulkFetch(["PROJ-1"], ["summary"]);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const bodyParsed = JSON.parse(init.body as string);
      expect(bodyParsed.fields).toEqual(["summary"]);
    });

    it("adds Bearer header", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ issues: [] }), { status: 200 })
      );

      await client.bulkFetch(["PROJ-1"]);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${accessToken}`);
    });
  });

  // ── 429 rate limit ────────────────────────────────────────────────────────

  describe("429 rate limit handling", () => {
    it("throws JiraRateLimitError with retryAfterSeconds from header", async () => {
      const headers = new Headers({ "Retry-After": "45" });
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 429, headers }));

      let caught: JiraRateLimitError | null = null;
      try {
        await client.searchJql("project = PROJ");
      } catch (e) {
        caught = e as JiraRateLimitError;
      }

      expect(caught).toBeInstanceOf(JiraRateLimitError);
      expect(caught?.retryAfterSeconds).toBe(45);
    });

    it("defaults retryAfterSeconds to 60 when Retry-After header is absent", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 }));

      let caught: JiraRateLimitError | null = null;
      try {
        await client.searchJql("project = PROJ");
      } catch (e) {
        caught = e as JiraRateLimitError;
      }

      expect(caught).toBeInstanceOf(JiraRateLimitError);
      expect(caught?.retryAfterSeconds).toBe(60);
    });

    it("defaults retryAfterSeconds to 60 when Retry-After is non-numeric", async () => {
      const headers = new Headers({ "Retry-After": "invalid" });
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 429, headers }));

      let caught: JiraRateLimitError | null = null;
      try {
        await client.getIssue("PROJ-1");
      } catch (e) {
        caught = e as JiraRateLimitError;
      }

      expect(caught).toBeInstanceOf(JiraRateLimitError);
      expect(caught?.retryAfterSeconds).toBe(60);
    });
  });

  // ── getFields ─────────────────────────────────────────────────────────────

  describe("getFields", () => {
    it("calls GET /field with Bearer Authorization header", async () => {
      const fields = [
        { id: "summary", name: "Summary", custom: false },
        { id: "customfield_10001", name: "Story Points", custom: true },
      ];
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(fields), { status: 200 }));

      await client.getFields();

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/field");
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${accessToken}`);
    });

    it("returns JiraFieldMeta[] on success", async () => {
      const fields = [
        { id: "summary", name: "Summary", custom: false },
        { id: "customfield_10001", name: "Story Points", custom: true, schema: { type: "number", custom: "com.pyxis.greenhopper.jira:gh-story-points" } },
      ];
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(fields), { status: 200 }));

      const result = await client.getFields();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: "summary", name: "Summary", custom: false });
      expect(result[1].custom).toBe(true);
      expect(result[1].schema?.type).toBe("number");
    });

    it("throws JiraApiError on 403 response", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ errorMessages: ["Forbidden"] }), { status: 403 })
      );

      await expect(client.getFields()).rejects.toThrow(JiraApiError);
    });

    it("returns cached result on second call within 30s", async () => {
      const fields = [{ id: "summary", name: "Summary", custom: false }];
      fetchMock.mockResolvedValue(new Response(JSON.stringify(fields), { status: 200 }));

      await client.getFields();
      await client.getFields();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // ── getAccessibleResources ─────────────────────────────────────────────────

  describe("getAccessibleResources", () => {
    it("calls the accessible-resources endpoint with Bearer header", async () => {
      const resources = [makeAccessibleResource("cloud-xyz")];
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(resources), { status: 200 }));

      const result = await JiraClient.getAccessibleResources("token-abc");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.atlassian.com/oauth/token/accessible-resources");
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer token-abc");
      expect(result).toEqual(resources);
    });

    it("throws JiraRateLimitError on 429", async () => {
      const headers = new Headers({ "Retry-After": "10" });
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 429, headers }));

      await expect(JiraClient.getAccessibleResources("tok")).rejects.toThrow(JiraRateLimitError);
    });

    it("throws JiraApiError on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 })
      );

      await expect(JiraClient.getAccessibleResources("bad-token")).rejects.toThrow(JiraApiError);
    });
  });
});

// ── JiraProxyClient (API token / Worker proxy) ────────────────────────────────

describe("JiraProxyClient", () => {
  const cloudId = "proxy-cloud-id";
  const email = "user@example.com";
  const sealed = "sealed-api-token-blob";
  let client: JiraProxyClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    client = new JiraProxyClient(cloudId, email, sealed);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── getIssue via bulkFetch ─────────────────────────────────────────────────

  describe("getIssue", () => {
    it("routes through /api/jira/proxy with correct body shape", async () => {
      const result: JiraBulkFetchResult = { issues: [makeIssue("PROJ-1")] };
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }));

      await client.getIssue("PROJ-1");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/jira/proxy");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.endpoint).toBe("issue");
      expect(body.cloudId).toBe(cloudId);
      expect(body.email).toBe(email);
      expect(body.sealed).toBe(sealed);
      expect(body.params.issueIdsOrKeys).toEqual(["PROJ-1"]);
    });

    it("returns the issue when bulkFetch contains the key", async () => {
      const issue = makeIssue("PROJ-5");
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ issues: [issue] }), { status: 200 })
      );

      const result = await client.getIssue("PROJ-5");
      expect(result?.key).toBe("PROJ-5");
    });

    it("returns null when issues array is empty", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ issues: [] }), { status: 200 })
      );

      const result = await client.getIssue("MISSING-1");
      expect(result).toBeNull();
    });

    it("returns null when key appears in errors array", async () => {
      const result: JiraBulkFetchResult = {
        issues: [],
        errors: [{ issueIdsOrKeys: ["MISSING-1"], status: 404 }],
      };
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }));

      const found = await client.getIssue("MISSING-1");
      expect(found).toBeNull();
    });

    it("returns null when key is in errors even if issues array has other results", async () => {
      const result: JiraBulkFetchResult = {
        issues: [makeIssue("PROJ-2")],
        errors: [{ issueIdsOrKeys: ["MISSING-1"], status: 404 }],
      };
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }));

      const found = await client.getIssue("MISSING-1");
      expect(found).toBeNull();
    });

    it("returns null when bulkFetch returns an issue with a different key", async () => {
      const result: JiraBulkFetchResult = { issues: [makeIssue("PROJ-OTHER")] };
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }));

      const found = await client.getIssue("PROJ-1");
      expect(found).toBeNull();
    });
  });

  // ── searchJql ─────────────────────────────────────────────────────────────

  describe("searchJql", () => {
    it("routes through /api/jira/proxy with endpoint=search", async () => {
      const searchResult: JiraSearchResult = { issues: [], total: 0, maxResults: 100, startAt: 0 };
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(searchResult), { status: 200 }));

      await client.searchJql("assignee = currentUser()");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/jira/proxy");
      const body = JSON.parse(init.body as string);
      expect(body.endpoint).toBe("search");
      expect(body.params.jql).toBe("assignee = currentUser()");
      expect(body.params.maxResults).toBe(100);
    });

    it("passes custom opts through params", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ issues: [], total: 0, maxResults: 10, startAt: 20 }), { status: 200 })
      );

      await client.searchJql("project = X", { maxResults: 10, startAt: 20, fields: ["summary"] });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.params.maxResults).toBe(10);
      expect(body.params.startAt).toBe(20);
      expect(body.params.fields).toEqual(["summary"]);
    });

    it("includes X-Requested-With header", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ issues: [], total: 0, maxResults: 100, startAt: 0 }), { status: 200 })
      );

      await client.searchJql("project = TEST");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Requested-With"]).toBe("fetch");
    });

    it("calls onResealed callback when response includes resealed field", async () => {
      const onResealed = vi.fn();
      const clientWithCallback = new JiraProxyClient(cloudId, email, sealed, onResealed);
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ issues: [], total: 0, maxResults: 100, startAt: 0, resealed: "new-sealed-token" }),
          { status: 200 }
        )
      );

      const result = await clientWithCallback.searchJql("project = TEST");

      expect(onResealed).toHaveBeenCalledOnce();
      expect(onResealed).toHaveBeenCalledWith("new-sealed-token");
      expect("resealed" in result).toBe(false);
    });

    it("does not call onResealed when resealed is absent", async () => {
      const onResealed = vi.fn();
      const clientWithCallback = new JiraProxyClient(cloudId, email, sealed, onResealed);
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ issues: [], total: 0, maxResults: 100, startAt: 0 }),
          { status: 200 }
        )
      );

      await clientWithCallback.searchJql("project = TEST");

      expect(onResealed).not.toHaveBeenCalled();
    });
  });

  // ── bulkFetch ─────────────────────────────────────────────────────────────

  describe("bulkFetch", () => {
    it("sends endpoint=issue with issueIdsOrKeys array", async () => {
      const bulkResult: JiraBulkFetchResult = {
        issues: [makeIssue("PROJ-1"), makeIssue("PROJ-2")],
      };
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(bulkResult), { status: 200 }));

      await client.bulkFetch(["PROJ-1", "PROJ-2"]);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.endpoint).toBe("issue");
      expect(body.params.issueIdsOrKeys).toEqual(["PROJ-1", "PROJ-2"]);
    });

    it("calls onResealed callback when response includes resealed field", async () => {
      const onResealed = vi.fn();
      const clientWithCallback = new JiraProxyClient(cloudId, email, sealed, onResealed);
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ issues: [], resealed: "new-sealed-token" }),
          { status: 200 }
        )
      );

      await clientWithCallback.bulkFetch(["PROJ-1"]);

      expect(onResealed).toHaveBeenCalledOnce();
      expect(onResealed).toHaveBeenCalledWith("new-sealed-token");
    });

    it("does not call onResealed when resealed is absent", async () => {
      const onResealed = vi.fn();
      const clientWithCallback = new JiraProxyClient(cloudId, email, sealed, onResealed);
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ issues: [] }),
          { status: 200 }
        )
      );

      await clientWithCallback.bulkFetch(["PROJ-1"]);

      expect(onResealed).not.toHaveBeenCalled();
    });
  });

  // ── getFields ─────────────────────────────────────────────────────────────

  describe("getFields", () => {
    it("sends endpoint=fields with empty params to proxy", async () => {
      const fields = [
        { id: "summary", name: "Summary", custom: false },
        { id: "customfield_10001", name: "Story Points", custom: true },
      ];
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(fields), { status: 200 }));

      await client.getFields();

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/jira/proxy");
      const body = JSON.parse(init.body as string);
      expect(body.endpoint).toBe("fields");
      expect(body.cloudId).toBe(cloudId);
      expect(body.email).toBe(email);
      expect(body.sealed).toBe(sealed);
    });

    it("returns JiraFieldMeta[] from proxy response", async () => {
      const fields = [
        { id: "summary", name: "Summary", custom: false },
        { id: "customfield_10001", name: "Story Points", custom: true, schema: { type: "number" } },
      ];
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(fields), { status: 200 }));

      const result = await client.getFields();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("summary");
      expect(result[1].id).toBe("customfield_10001");
      expect(result[1].custom).toBe(true);
    });

    it("throws JiraApiError on 403 response", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
      );

      await expect(client.getFields()).rejects.toThrow(JiraApiError);
    });
  });

  // ── 429 via proxy ─────────────────────────────────────────────────────────

  describe("429 handling via proxy", () => {
    it("throws JiraRateLimitError with retryAfterSeconds", async () => {
      const headers = new Headers({ "Retry-After": "20" });
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 429, headers }));

      let caught: JiraRateLimitError | null = null;
      try {
        await client.searchJql("assignee = me");
      } catch (e) {
        caught = e as JiraRateLimitError;
      }

      expect(caught).toBeInstanceOf(JiraRateLimitError);
      expect(caught?.retryAfterSeconds).toBe(20);
    });

    it("throws JiraApiError on non-ok proxy response", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "bad_request" }), { status: 400 })
      );

      await expect(client.searchJql("bad jql")).rejects.toThrow(JiraApiError);
    });

    it("JiraApiError carries status and body from proxy response", async () => {
      const body = { error: "unauthorized", message: "Invalid credentials" };
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(body), { status: 401 })
      );

      let caught: JiraApiError | null = null;
      try {
        await client.searchJql("project = X");
      } catch (e) {
        caught = e as JiraApiError;
      }

      expect(caught).toBeInstanceOf(JiraApiError);
      expect(caught?.status).toBe(401);
      expect(caught?.body).toEqual(body);
    });
  });
});
