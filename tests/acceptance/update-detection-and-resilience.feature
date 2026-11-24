Feature: New-version detection, update banner, reload-on-navigate, and stale-chunk backstop

  The app fetches /version.json in the background (30 seconds after load, on
  tab return, and throttled to once a minute from full polls). When the
  deployed SHA differs from the running build, a bottom banner offers Reload
  and Changelog and a silent drawer entry is added; the next in-app navigation
  performs a full reload into the new build (once per target SHA) after
  flushing this tab's pending config and view-state writes. A rollback clears
  the banner. Failed lazy chunk loads reload once when an update is known,
  check first otherwise, and never reload offline. When the deployed build's
  storage-schema fingerprint differs, the older tab becomes read-only. Config
  and view state sync live across tabs; sign-out and token replacement in
  another tab are handled without writing over the other account's data.

  Background:
    Given the user has a GitHub account and is signed in unless the scenario says otherwise
    And the running build's git SHA is not "dev"

  Scenario: S4 - Update banner appears when a newer build is deployed, with a drawer entry and no toast
    Given the dashboard is open and the deployed build's SHA differs from the running build's SHA
    When the user switches away from the tab and back (or waits 30 seconds after load)
    Then a bottom-centre banner appears reading "A new version is available." with a "Reload" button and a "Changelog" link
    And the Notification Drawer gains one info entry "A new version of GitHub Tracker is available — reload to update." without a pop-up toast

  Scenario: S5 - No banner and client-side navigation when the deployed build matches
    Given the deployed build's SHA matches the running build
    When the user returns to the tab and then clicks the header "Settings" link
    Then no update banner is shown and no drawer entry is added
    And the Settings page opens as a client-side route change without a full document reload

  @e2e
  Scenario: S6 - Reload button saves a just-changed setting before reloading
    Given the update banner is visible on the Settings page
    When the user changes a setting (for example picks a different theme) and immediately clicks "Reload" in the banner
    Then the page performs a full reload
    And after the reload the changed setting is still applied

  @e2e
  Scenario: S7 - Navigating with an update waiting fully reloads into the new build and keeps pending view state
    Given an update is waiting and the dashboard shows the banner
    When the user expands a collapsed repo group and then clicks the header "Settings" link
    Then the browser performs a full document load of /settings instead of a client-side route change
    And after returning to the dashboard the repo group is still expanded

  @e2e
  Scenario: S8 - Only one automatic reload per target build during a gradual rollout
    Given the tab has already reloaded once for the target build and /version.json still reports that same target SHA
    When the check runs again, the banner reappears, and the user navigates from Settings back to the Dashboard
    Then the navigation is a client-side route change with no further automatic reload
    And the banner remains with its "Reload" button available for a manual reload

  Scenario: S9 - Banner and drawer entry clear after a rollback
    Given the update banner is visible and the drawer holds the update entry
    When a later check reports the running build's SHA again
    Then the banner disappears
    And the update entry is removed from the Notification Drawer

  @manual
  Scenario: S10 - Update checks run 30 seconds after load, on tab return, and at most once a minute from polls
    Given the dashboard has just loaded with automatic polling set to its longest interval
    When the user watches the Network tab for 30 seconds, then returns to the tab after 60 seconds away, then clicks the filter bar's "Refresh data" button twice 10 seconds apart after another 60 seconds have passed
    Then no version.json request happens while the dashboard boots, one fires at about 30 seconds, and one fires on the tab return
    And the two "Refresh data" clicks produce exactly one version.json request

  @manual
  Scenario: S11 - Toasts lift above the update banner
    Given the update banner is visible on a narrow viewport
    When a toast notification appears (for example a poll error produced by blocking api.github.com and clicking "Refresh data")
    Then the toast stack sits above the banner without overlapping it
    And once the banner clears the toast stack returns to the bottom edge

  Scenario: S12 - HTML, failed or malformed /version.json responses are ignored silently
    Given /version.json returns the SPA's HTML fallback, fails to load, or returns JSON missing required fields
    When the update check runs
    Then no banner appears, no toast appears, and nothing is added to the Notification Drawer
    And a later valid response with a different SHA still shows the banner

  @e2e
  Scenario: S13 - Failed lazy chunk with a known update reloads once
    Given an update is already known and the custom-tab dialog's chunk is blocked
    When the user clicks "Add custom tab" in the tab bar
    Then the page reloads once immediately
    And a second failure within 10 seconds of that reload shows the "Failed to load page" card instead of reloading again

  @e2e
  Scenario: S14 - Failed route chunk with no known update reloads once on its own, then shows the load-failure card
    Given no newer build is known and the Settings page chunk is blocked
    When the user clicks the header "Settings" link
    Then the page reloads once on its own
    And when the chunk still fails after the reload, a "Failed to load page" card with a "Reload page" button is shown instead of another reload

  @e2e
  Scenario: S15 - Offline route chunk failure never reloads
    Given the browser reports being offline
    When the user clicks the header "Settings" link before the Settings code has been loaded
    Then no automatic reload happens
    And the "Failed to load page" card with "Reload page" is shown, and clicking it after going back online fully reloads into Settings

  Scenario: S16 - Older-build tab becomes read-only when the deployed storage schema differs
    Given the deployed build reports a schema fingerprint different from this tab's build
    When the update check runs
    Then the banner reads "A new version is available. This tab can't save changes, and Settings are read-only, until you reload."
    And the Settings content is a disabled inert region, so Sign out, Export, the dropdowns and the theme options are disabled and a forced click on a theme option changes nothing

  Scenario: S17 - Older-build tab refuses to finish onboarding
    Given the tab is read-only because of a schema mismatch and the user has selected repos in the onboarding wizard
    When the user clicks "Finish Setup (N repos)"
    Then the wizard stays on /onboarding and replaces the selector with the alert "This tab is on an older version and can't save your choices. Reload this page, then finish setup." and a "Retry" button
    And no repo selection is written to storage

  @manual
  Scenario: S18 - Older-build tab refuses PAT sign-in and backup import on the login page
    Given the user is signed out on the login page, which is read-only because of a schema mismatch
    When the user expands the personal access token form, enters any token text and submits
    Then the form shows "This tab is on an older version. Reload this page, then sign in." and the user stays signed out
    When the user instead opens "Import from backup", chooses a backup file, enters its one-time code (and clicks "Continue" if an identity confirmation appears)
    Then the import shows "This tab is on an older version and can't import settings. Reload this page, then try again." and nothing is imported

  @e2e
  Scenario: S19 - Dashboard changes made in an older-build tab are not saved
    Given Tab A is read-only because of a schema mismatch and Tab B is normal
    When the user sets the Issues Role filter to "Assignee" and expands a repo group in Tab A, staying on the dashboard
    Then Tab B keeps its previous filter and collapsed group, and Tab A does not adopt a theme changed in Tab B meanwhile
    And after Tab A reloads without the override, its filter is back to the previous value and the group is collapsed again

  @e2e
  Scenario: S20 - Settings and view changes sync live to other tabs
    Given Tab A is on Settings and Tab B is on the dashboard
    When the user changes the theme in Tab A, then changes the Pull Requests sort order and expands a repo group in Tab B
    Then Tab B switches to the new theme within a second without reloading
    And Tab A, when it returns to the dashboard, shows the new sort order and the expanded group

  @e2e
  Scenario: S21 - Pre-reload flush writes only this tab's changed keys
    Given Tab A has just changed the theme and Tab B has an update waiting
    When the user changes the refresh interval in Tab B to 10 minutes and immediately clicks "Back to dashboard", triggering Tab B's automatic reload
    Then after Tab B reloads it shows Tab A's theme and a 10-minute refresh interval
    And Tab A also shows the 10-minute refresh interval with its theme intact

  @e2e
  Scenario: S22 - Sign-out in another tab signs this tab out too
    Given Tab A is on the dashboard and Tab B is on Settings
    When the user clicks Sign out in Tab B
    Then Tab A performs a full navigation to the sign-in page with no error toast
    And the auth token is gone from localStorage and the config and view-state entries hold only defaults (no repos, tracked users or filters), so Tab A wrote nothing back over the cleared account

  @e2e
  Scenario: S23 - Same-user token replaced in another tab keeps this tab signed in and saving
    Given Tab B replaces the stored token with a second PAT for the same GitHub user via Settings > Data > Authentication > "Replace"
    When Tab A receives the new token and confirms the user
    Then within 10 seconds Tab A shows no warning toast or drawer entry and still shows the same signed-in user
    And a theme changed in Tab A afterwards is saved and appears in Tab B

  @e2e
  Scenario: S24 - Token replaced in another tab and user cannot be confirmed: warning asks to reload
    Given Tab A cannot reach the GitHub user endpoint
    When Tab B replaces the stored token via Settings > Data > Authentication > "Replace"
    Then Tab A promptly shows the warning "Another tab changed the signed-in account and this tab couldn't confirm which one. Changes here aren't being saved — reload this tab to continue."
    And a theme changed in Tab A is not saved until the tab is reloaded

  @manual
  Scenario: S25 - Repos added in another tab do not flood this tab with notifications
    Given Tab A is polling the dashboard with desktop notifications enabled
    When the user adds a repo with 10 or more existing open items under Settings > Orgs & Repos in Tab B
    Then after clicking "Refresh data" in Tab A the repo's items render and no desktop notification is shown for them
    And an issue the tester opens in that repo afterwards produces exactly one desktop notification after the next "Refresh data"

  @e2e
  Scenario: S33 - Settings import in one tab replaces the stored config wholesale and other tabs adopt it
    Given Tab B changed the theme a few seconds ago and that change has been saved
    When the user imports the edited settings file in Tab A via Settings > Data > Import settings and confirms with "Yes, import"
    Then the stored config equals the imported file, so Tab B's earlier theme is replaced rather than merged
    And Tab B switches to the imported theme and shows the imported repo list without a reload

  @e2e
  Scenario: S34 - Failed on-demand module with no known update checks first and reloads once when the check finds a newer build
    Given no newer build is known and the changelog chunk is blocked, so the header's idle load already failed without a reload
    When the deployed /version.json starts reporting a different SHA, with no check having run since, and the user opens What's New
    Then the failed import triggers an update check, the check finds the newer build, and the page reloads exactly once
    And after the reload the header's repeated import failure inside the 10-second window causes no second reload, and the update banner appears on the next check
