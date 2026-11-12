Feature: In-app "What's new" dialog from build-time changelog

  CHANGELOG.md is parsed at build time into a lazy virtual module. The
  dashboard header shows a star button with an unread dot when a release
  newer than the stored lastSeenVersion exists (a first-time user sees a
  single dot). Opening the dialog, from the header or from Settings > Data >
  About, lists releases newest-first as plain text with PR and commit links
  scoped to the project repository and moves lastSeenVersion forward only.
  A failed changelog load shows an empty state and retries on the next open.

  Background:
    Given the user is authenticated with a GitHub account
    And the running build's version is a strict x.y.z semver

  Scenario: S26 - Header What's new star shows an unread dot and accessible label when a newer release exists
    Given a release newer than the user's last-seen version is in the changelog
    When the dashboard header has finished its idle-time changelog load
    Then the star icon button (directly after the notifications bell) shows a small dot and its accessible name is "What's new, unread release notes"
    And hovering the button shows the "What's new" tooltip

  @manual
  Scenario: S27 - Opening What's New lists releases newest-first with GitHub links and clears the dot
    Given the unread dot is showing
    When the user clicks the star button
    Then a "What's New" dialog lists releases newest-first, each with "v<version>" and its date, section headings such as "BUG FIXES", and items whose "#<PR>" and "(<7-character SHA>)" links point to https://github.com/gordon-code/github-tracker/pull/… and /commit/…
    And the dot clears as soon as the dialog opens and stays gone after a reload

  @manual
  Scenario: S28 - First-time user sees a single unread indicator
    Given the user has never opened What's New (no last-seen version stored)
    When the dashboard header has finished its idle-time changelog load
    Then the star shows one persistent unread dot
    And opening the dialog clears it, and it stays cleared across reloads until the stored last-seen version is older than the top release

  Scenario: S29 - Older-build tab opening What's New never rolls lastSeenVersion back
    Given the stored last-seen version is newer than this tab's build version
    When the user opens and closes What's New in this tab
    Then the stored last-seen version is unchanged
    And no unread dot is shown before or after

  Scenario: S30 - Settings > About "What's new" button opens the same dialog
    Given the user is on Settings
    When the user clicks "What's new" in the About row and waits for the notes to load
    Then the "What's New" dialog shows the same first entry (version and date) as the header dialog, with the same links and footer
    And after closing it and returning to the dashboard the header dot is gone

  Scenario: S31 - Blocked or empty changelog shows "No release notes available." and retries on next open without reloading
    Given the changelog chunk cannot be loaded
    When the user opens What's New
    Then the dialog shows "No release notes available.", no error toast appears, and the page does not reload
    When the block is still active and the user opens it again, and then removes the block and opens it once more
    Then the second open is still empty and the third open renders the entries within a few seconds without closing the dialog

  @manual
  Scenario: S32 - lastSeenVersion rides settings export and import
    Given the user has opened What's New on the current build
    When the user exports settings and imports the file via Settings > Data > Import settings in the fresh profile
    Then the exported JSON contains lastSeenVersion equal to the version shown in Settings > About
    And the importing profile's header dot, visible before the import, is gone after it
