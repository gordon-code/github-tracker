Feature: Exclude repos and orgs from the Dependencies tab

  Users can exclude specific repos or entire orgs from the Dependencies tab
  (dependency-bot PRs and Renovate Dashboard "Abandoned" package badges) via
  a checkbox-tree modal in Settings -> Dependencies. Exclusion is scoped to
  the Dependencies tab only -- Issues, Pull Requests, and Actions are
  unaffected, and an excluded repo's dependency-bot PRs disappear entirely
  rather than reappearing in Pull Requests. Org-level exclusion is dynamic:
  it matches on repo ownership, so repos added under an excluded org later
  are excluded automatically with no resync needed.

  Background:
    Given the user is authenticated with a GitHub account

  Scenario: S1 - Excluding a repo hides its dependency PR from the Dependencies tab
    Given the user has two tracked repos, each with one open PR authored by a dependency bot (e.g. "dependabot[bot]" on a "dependabot/npm_and_yarn/..." branch), and one of those two repos is listed under Settings -> Dependencies -> Excluded repos/orgs
    When the user opens the Dependencies tab
    Then only the non-excluded repo's dependency-bot PR is shown in the list
    And the Dependencies tab badge count reads "1"

  Scenario: S2 - Excluding a repo leaves Issues/Pull Requests/Actions untouched for that repo
    Given a repo is excluded from the Dependencies tab and has one open non-bot issue, one open non-bot pull request, and one workflow run, all visible before the exclusion was set
    When the user views the Issues, Pull Requests, and Actions tabs after excluding the repo
    Then the same issue, pull request, and workflow run are still listed exactly as before exclusion, with the same titles, same tab, and same counts

  Scenario: S3 - Excluded repo's bot PR does not leak into the Pull Requests tab
    Given a repo has an open dependency-bot PR, and that PR does not currently appear on the standard Pull Requests tab
    When the user excludes that repo from Dependencies in Settings
    Then the bot PR disappears from the Dependencies tab
    And the bot PR still does not appear on the standard Pull Requests tab

  Scenario: S4 - Excluding a repo also hides its Renovate abandoned-package badges
    Given a repo has an open "Dependency Dashboard" issue whose body lists one package under "Ignored or Blocked", rendered as an "Abandoned" badge on that repo's entry in the Dependencies tab
    When the user excludes that repo from Dependencies in Settings and returns to the Dependencies tab
    Then the "Abandoned" badge for that repo is no longer shown anywhere on the tab

  Scenario: S5 - Excluding an org via the checkbox tree hides all its repos' dependency PRs
    Given the user tracks 3 repos under one org, 2 of which have an open dependency-bot PR
    When the user opens the Manage Dependencies-Exclusions modal and checks that org's checkbox
    Then all 3 of that org's nested repo checkboxes immediately show as checked and disabled
    When the user then clicks Save
    Then neither of the org's dependency-bot PRs appears in the Dependencies tab

  Scenario: S6 - Org-level exclusion automatically covers a repo added to that org later
    Given the user has excluded an entire org from Dependencies, with no further changes made to the exclusion settings afterward
    When a repo under that same org is subsequently added to the user's tracked repos and that repo has an open dependency-bot PR
    Then that repo's dependency-bot PR does not appear in the Dependencies tab
    And the Manage modal, if reopened, shows that repo's checkbox as checked and disabled without the user having touched it directly

  Scenario: S7 - Un-excluding a repo restores its dependency PRs and abandoned-package badges
    Given a repo was excluded at the repo level, not inherited from an org exclusion, and it has an open dependency-bot PR and an "Abandoned" badge
    When the user opens the Manage modal, unchecks that repo's checkbox, and clicks Save
    Then the repo's dependency-bot PR reappears in the Dependencies tab
    And its "Abandoned" badge is shown again

  Scenario: S8 - Exclusion picker's available pool spans selected, upstream, and monitored repos
    Given the user has one repo added directly in Repository Selection, one repo reachable only via an upstream fork relationship, and one repo added via Monitor-All, each under a different org
    When the user opens Settings -> Dependencies -> Manage
    Then all three repos and their three orgs appear as unchecked, checkable options in the tree

  Scenario: S9 - Settings summary text shows "None excluded" with no exclusions configured
    Given the user has no dependency exclusions configured
    When the user views Settings -> Dependencies
    Then the "Excluded repos/orgs" row reads "None excluded"

  Scenario: S10 - Settings summary text updates to reflect a saved exclusion count
    Given the user has no dependency exclusions configured
    When the user opens the Manage modal, checks 1 org's checkbox and 2 individual repo checkboxes under different orgs, and clicks Save
    Then the "Excluded repos/orgs" row on the Settings page reads "1 org, 2 repos"

  Scenario: S11 - Canceling the exclusion modal discards unsaved changes
    Given a repo is not excluded and has an open dependency-bot PR visible on the Dependencies tab
    When the user opens the Manage modal, checks that repo's checkbox, and clicks Cancel instead of Save
    Then the repo's dependency-bot PR still appears on the Dependencies tab
    And reopening the Manage modal shows that repo's checkbox unchecked again
