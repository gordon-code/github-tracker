import { describe, it, expect } from "vitest";
import { isIssueVisible, isPrVisible, isRunVisible } from "../../src/app/lib/filters";
import { makeIssue, makePullRequest, makeWorkflowRun } from "../helpers/index";

// All three predicates are pure functions — no reactive root or store setup needed.

describe("isIssueVisible", () => {
  describe("ignoredIds", () => {
    it("returns true when issue id is not in ignoredIds", () => {
      const issue = makeIssue({ id: 1 });
      expect(isIssueVisible(issue, { ignoredIds: new Set() })).toBe(true);
    });

    it("returns false when issue id is in ignoredIds", () => {
      const issue = makeIssue({ id: 42 });
      expect(isIssueVisible(issue, { ignoredIds: new Set([42]) })).toBe(false);
    });

    it("does not reject when a different id is ignored", () => {
      const issue = makeIssue({ id: 1 });
      expect(isIssueVisible(issue, { ignoredIds: new Set([99]) })).toBe(true);
    });
  });

  describe("hideDepDashboard", () => {
    it("hides issue titled 'Dependency Dashboard' when hideDepDashboard is true", () => {
      const issue = makeIssue({ title: "Dependency Dashboard" });
      expect(isIssueVisible(issue, { ignoredIds: new Set(), hideDepDashboard: true })).toBe(false);
    });

    it("shows issue titled 'Dependency Dashboard' when hideDepDashboard is false", () => {
      const issue = makeIssue({ title: "Dependency Dashboard" });
      expect(isIssueVisible(issue, { ignoredIds: new Set(), hideDepDashboard: false })).toBe(true);
    });

    it("shows issue titled 'Dependency Dashboard' when hideDepDashboard is undefined", () => {
      const issue = makeIssue({ title: "Dependency Dashboard" });
      expect(isIssueVisible(issue, { ignoredIds: new Set() })).toBe(true);
    });

    it("does not hide non-Dependency-Dashboard issues when hideDepDashboard is true", () => {
      const issue = makeIssue({ title: "Regular bug" });
      expect(isIssueVisible(issue, { ignoredIds: new Set(), hideDepDashboard: true })).toBe(true);
    });
  });

  describe("globalFilter — org", () => {
    it("shows issue when org matches", () => {
      const issue = makeIssue({ repoFullName: "myorg/repo" });
      expect(isIssueVisible(issue, { ignoredIds: new Set(), globalFilter: { org: "myorg", repo: null } })).toBe(true);
    });

    it("hides issue when org does not match", () => {
      const issue = makeIssue({ repoFullName: "otherorg/repo" });
      expect(isIssueVisible(issue, { ignoredIds: new Set(), globalFilter: { org: "myorg", repo: null } })).toBe(false);
    });

    it("does not match org as a prefix of a longer org name", () => {
      // "my" should not match "myorg/repo"
      const issue = makeIssue({ repoFullName: "myorg/repo" });
      expect(isIssueVisible(issue, { ignoredIds: new Set(), globalFilter: { org: "my", repo: null } })).toBe(false);
    });
  });

  describe("globalFilter — repo", () => {
    it("shows issue when repo matches exactly", () => {
      const issue = makeIssue({ repoFullName: "owner/repo" });
      expect(isIssueVisible(issue, { ignoredIds: new Set(), globalFilter: { org: null, repo: "owner/repo" } })).toBe(true);
    });

    it("hides issue when repo does not match", () => {
      const issue = makeIssue({ repoFullName: "owner/other" });
      expect(isIssueVisible(issue, { ignoredIds: new Set(), globalFilter: { org: null, repo: "owner/repo" } })).toBe(false);
    });
  });

  describe("globalFilter — null (bypass)", () => {
    it("passes all issues when globalFilter is null", () => {
      const issue = makeIssue({ repoFullName: "any/repo" });
      expect(isIssueVisible(issue, { ignoredIds: new Set(), globalFilter: null })).toBe(true);
    });

    it("passes all issues when globalFilter is undefined", () => {
      const issue = makeIssue({ repoFullName: "any/repo" });
      expect(isIssueVisible(issue, { ignoredIds: new Set() })).toBe(true);
    });

    it("passes all issues when both org and repo are null", () => {
      const issue = makeIssue({ repoFullName: "any/repo" });
      expect(isIssueVisible(issue, { ignoredIds: new Set(), globalFilter: { org: null, repo: null } })).toBe(true);
    });
  });
});

describe("isPrVisible", () => {
  describe("ignoredIds", () => {
    it("returns true when PR id is not in ignoredIds", () => {
      const pr = makePullRequest({ id: 1 });
      expect(isPrVisible(pr, { ignoredIds: new Set() })).toBe(true);
    });

    it("returns false when PR id is in ignoredIds", () => {
      const pr = makePullRequest({ id: 55 });
      expect(isPrVisible(pr, { ignoredIds: new Set([55]) })).toBe(false);
    });

    it("does not reject when a different id is ignored", () => {
      const pr = makePullRequest({ id: 1 });
      expect(isPrVisible(pr, { ignoredIds: new Set([99]) })).toBe(true);
    });
  });

  describe("globalFilter — org", () => {
    it("shows PR when org matches", () => {
      const pr = makePullRequest({ repoFullName: "myorg/repo" });
      expect(isPrVisible(pr, { ignoredIds: new Set(), globalFilter: { org: "myorg", repo: null } })).toBe(true);
    });

    it("hides PR when org does not match", () => {
      const pr = makePullRequest({ repoFullName: "otherorg/repo" });
      expect(isPrVisible(pr, { ignoredIds: new Set(), globalFilter: { org: "myorg", repo: null } })).toBe(false);
    });
  });

  describe("globalFilter — repo", () => {
    it("shows PR when repo matches exactly", () => {
      const pr = makePullRequest({ repoFullName: "owner/repo" });
      expect(isPrVisible(pr, { ignoredIds: new Set(), globalFilter: { org: null, repo: "owner/repo" } })).toBe(true);
    });

    it("hides PR when repo does not match", () => {
      const pr = makePullRequest({ repoFullName: "owner/other" });
      expect(isPrVisible(pr, { ignoredIds: new Set(), globalFilter: { org: null, repo: "owner/repo" } })).toBe(false);
    });
  });

  describe("globalFilter — null (bypass)", () => {
    it("passes all PRs when globalFilter is null", () => {
      const pr = makePullRequest({ repoFullName: "any/repo" });
      expect(isPrVisible(pr, { ignoredIds: new Set(), globalFilter: null })).toBe(true);
    });

    it("passes all PRs when globalFilter is undefined", () => {
      const pr = makePullRequest({ repoFullName: "any/repo" });
      expect(isPrVisible(pr, { ignoredIds: new Set() })).toBe(true);
    });

    it("passes all PRs when both org and repo are null", () => {
      const pr = makePullRequest({ repoFullName: "any/repo" });
      expect(isPrVisible(pr, { ignoredIds: new Set(), globalFilter: { org: null, repo: null } })).toBe(true);
    });
  });
});

describe("isRunVisible", () => {
  describe("ignoredIds", () => {
    it("returns true when run id is not in ignoredIds", () => {
      const run = makeWorkflowRun({ id: 1 });
      expect(isRunVisible(run, { ignoredIds: new Set() })).toBe(true);
    });

    it("returns false when run id is in ignoredIds", () => {
      const run = makeWorkflowRun({ id: 77 });
      expect(isRunVisible(run, { ignoredIds: new Set([77]) })).toBe(false);
    });

    it("does not reject when a different id is ignored", () => {
      const run = makeWorkflowRun({ id: 1 });
      expect(isRunVisible(run, { ignoredIds: new Set([99]) })).toBe(true);
    });
  });

  describe("showPrRuns", () => {
    it("hides PR runs when showPrRuns is false", () => {
      const run = makeWorkflowRun({ isPrRun: true });
      expect(isRunVisible(run, { ignoredIds: new Set(), showPrRuns: false })).toBe(false);
    });

    it("shows PR runs when showPrRuns is true", () => {
      const run = makeWorkflowRun({ isPrRun: true });
      expect(isRunVisible(run, { ignoredIds: new Set(), showPrRuns: true })).toBe(true);
    });

    it("shows non-PR runs regardless of showPrRuns", () => {
      const run = makeWorkflowRun({ isPrRun: false });
      expect(isRunVisible(run, { ignoredIds: new Set(), showPrRuns: false })).toBe(true);
      expect(isRunVisible(run, { ignoredIds: new Set(), showPrRuns: true })).toBe(true);
    });

    it("shows PR runs when showPrRuns is undefined", () => {
      const run = makeWorkflowRun({ isPrRun: true });
      expect(isRunVisible(run, { ignoredIds: new Set() })).toBe(true);
    });
  });

  describe("globalFilter — org", () => {
    it("shows run when org matches", () => {
      const run = makeWorkflowRun({ repoFullName: "myorg/repo" });
      expect(isRunVisible(run, { ignoredIds: new Set(), globalFilter: { org: "myorg", repo: null } })).toBe(true);
    });

    it("hides run when org does not match", () => {
      const run = makeWorkflowRun({ repoFullName: "otherorg/repo" });
      expect(isRunVisible(run, { ignoredIds: new Set(), globalFilter: { org: "myorg", repo: null } })).toBe(false);
    });
  });

  describe("globalFilter — repo", () => {
    it("shows run when repo matches exactly", () => {
      const run = makeWorkflowRun({ repoFullName: "owner/repo" });
      expect(isRunVisible(run, { ignoredIds: new Set(), globalFilter: { org: null, repo: "owner/repo" } })).toBe(true);
    });

    it("hides run when repo does not match", () => {
      const run = makeWorkflowRun({ repoFullName: "owner/other" });
      expect(isRunVisible(run, { ignoredIds: new Set(), globalFilter: { org: null, repo: "owner/repo" } })).toBe(false);
    });
  });

  describe("globalFilter — null (bypass)", () => {
    it("passes all runs when globalFilter is null", () => {
      const run = makeWorkflowRun({ repoFullName: "any/repo" });
      expect(isRunVisible(run, { ignoredIds: new Set(), globalFilter: null })).toBe(true);
    });

    it("passes all runs when globalFilter is undefined", () => {
      const run = makeWorkflowRun({ repoFullName: "any/repo" });
      expect(isRunVisible(run, { ignoredIds: new Set() })).toBe(true);
    });

    it("passes all runs when both org and repo are null", () => {
      const run = makeWorkflowRun({ repoFullName: "any/repo" });
      expect(isRunVisible(run, { ignoredIds: new Set(), globalFilter: { org: null, repo: null } })).toBe(true);
    });
  });
});
