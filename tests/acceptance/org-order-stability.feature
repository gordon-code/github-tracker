Feature: Freeze org display order in RepoSelector after initial sort

  The RepoSelector component sorts organizations (personal first, then
  alphabetical) when all orgs finish loading. After the initial sort, the
  order is frozen to prevent visual re-ordering on reactive updates like
  repo retries or checkbox toggles. The frozen order is invalidated when
  the set of selected organizations changes (e.g., granting access to a
  new org or revoking access), triggering a fresh sort. Invalidation uses
  a serialized sorted Set comparison, not length, to detect membership
  changes even when the org count stays the same.

  Background:
    Given the user is authenticated with a GitHub account

  Scenario: S1 - Org order remains stable after repo retry
    Given the RepoSelector displays 3 orgs sorted as "alice", "acme-corp", "beta-org" with beta-org showing a Retry button
    When the user clicks the Retry button on "beta-org" and the repos load successfully
    Then the org header order remains "alice", "acme-corp", "beta-org"

  Scenario: S2 - Org order remains stable when toggling a repo checkbox
    Given the RepoSelector displays 3 orgs sorted as "alice", "acme-corp", "beta-org" with all repos loaded
    When the user toggles a repo checkbox under "acme-corp"
    Then the org header order remains "alice", "acme-corp", "beta-org"

  Scenario: S3 - Frozen order invalidated when a new org is granted
    Given the RepoSelector displays 2 orgs sorted as "alice", "delta-inc" with order frozen
    When the user grants access to a new org "acme-corp" and it finishes loading
    Then the org header order becomes "alice", "acme-corp", "delta-inc"

  Scenario: S4 - Initial sort applies personal org first
    Given the RepoSelector is displayed with 4 orgs "charlie", "acme-corp", "beta-org", "delta-inc" where "charlie" is the personal org
    When all orgs finish loading
    Then the org header order is "charlie", "acme-corp", "beta-org", "delta-inc"

  Scenario: S5 - Org order stable in accordion layout after retry
    Given the RepoSelector displays 7 orgs in accordion layout with "alice" first and "echo-labs" showing a Retry button
    When the user clicks Retry on "echo-labs" and its repos load successfully
    Then the org header order remains "alice", "acme-corp", "beta-org", "charlie-co", "delta-inc", "echo-labs", "foxtrot-io"
    And the currently expanded accordion panel remains expanded

  Scenario: S6 - New org appears in correct sorted position with 6+ orgs
    Given the RepoSelector displays 6 orgs all loaded and sorted with "alice" as the personal org
    When the user grants access to a new org "beta-org" and it finishes loading
    Then the org header order becomes "alice", "acme-corp", "beta-org", "charlie-co", "delta-inc", "echo-labs", "foxtrot-io"

  Scenario: S7 - Frozen order invalidated on simultaneous add and remove
    Given the RepoSelector displays 3 orgs sorted as "alice", "acme-corp", "delta-inc" with order frozen
    When the user's org access changes so that "delta-inc" is removed and "aaa-org" is added and aaa-org finishes loading
    Then the org header order becomes "alice", "aaa-org", "acme-corp"
    And "delta-inc" no longer appears in the list
