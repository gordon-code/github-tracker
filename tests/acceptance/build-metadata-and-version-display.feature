Feature: Build metadata, version.json, and version display

  Every client build is stamped with the package version and the 12-character
  git SHA. The running build is shown as "<version>+<7-character SHA>" in
  Settings > Data > About (with a "What's new" button and a "Changelog" link)
  and in the dashboard footer, both linking to the GitHub Releases page. The
  deployment serves an uncached /version.json naming the deployed build so
  open tabs can detect new deployments.

  Background:
    Given the user is authenticated with a GitHub account
    And the running build's git SHA is not "dev"

  Scenario: S1 - Settings > About shows the running version with Releases, What's new and Changelog
    Given the user is signed in and opens Settings
    When the user scrolls to the Data section
    Then an "About" row shows the running build as "<version>+<7-character SHA>" linking to https://github.com/gordon-code/github-tracker/releases in a new tab
    And the same row offers a "What's new" button and a "Changelog" link to https://github.com/gordon-code/github-tracker/blob/main/CHANGELOG.md

  Scenario: S2 - Dashboard footer shows the running version linking to Releases
    Given the user is on the dashboard
    When the user looks at the fixed footer beside the "Source", "Guide" and "Privacy" links
    Then a muted monospace "v<version>+<7-character SHA>" link is shown
    And clicking it opens https://github.com/gordon-code/github-tracker/releases in a new tab

  @manual
  Scenario: S3 - /version.json is served as uncached JSON naming the deployed build
    Given a build has just been deployed to gh.gordoncode.dev
    When the deployer requests https://gh.gordoncode.dev/version.json
    Then the response Content-Type starts with application/json, Cache-Control is no-store, and the body has exactly the keys version, sha, builtAt and schemaFp
    And the sha equals the first 12 characters of the deployed tag's commit, matching the "Verify deployed version.json" step in the deploy workflow run
