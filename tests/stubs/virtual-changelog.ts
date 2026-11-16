import type { ChangelogEntry } from "../../src/shared/changelog-schema";

const entries: ChangelogEntry[] = [
  {
    version: "0.1.0",
    date: "2026-11-06",
    sections: [
      {
        title: "Features",
        items: [
          {
            text: "version: add in-app What's New dialog generated from CHANGELOG",
            pr: 188,
            sha: "abcdef1",
          },
        ],
      },
    ],
  },
  {
    version: "0.0.9",
    date: "2026-11-01",
    sections: [
      {
        title: "Bug Fixes",
        items: [
          {
            text: "release: sync MCP version and automate release-please flow",
            pr: 183,
            sha: "97050e3",
          },
        ],
      },
    ],
  },
];

export default entries;
