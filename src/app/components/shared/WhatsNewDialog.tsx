import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Dialog } from "@kobalte/core/dialog";
import {
  CHANGELOG_MAX_ITEM_TEXT_LENGTH,
  COMMIT_SHA_RE,
  type ChangelogEntry,
} from "../../../shared/changelog-schema";
import { isStrictSemver, loadChangelog } from "../../lib/changelog";
import { CHANGELOG_URL, REPO_URL } from "../../lib/repo-links";
import { isSafeGitHubUrl } from "../../lib/url";
import { getAppVersion } from "../../lib/version";
import { config, updateConfig } from "../../stores/config";

// Entries arrive schema-validated, but the `entries` prop is public, so every link
// derived from entry data is re-checked here before it reaches an href.
function buildPrLink(pr: number | undefined): { href: string; label: string } | undefined {
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0) return undefined;
  const href = `${REPO_URL}/pull/${pr}`;
  return isSafeGitHubUrl(href) ? { href, label: `#${pr}` } : undefined;
}

function buildCommitLink(sha: string | undefined): { href: string; label: string } | undefined {
  if (typeof sha !== "string" || !COMMIT_SHA_RE.test(sha)) return undefined;
  const href = `${REPO_URL}/commit/${sha}`;
  return isSafeGitHubUrl(href) ? { href, label: `(${sha.slice(0, 7)})` } : undefined;
}

interface WhatsNewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries?: readonly ChangelogEntry[];
}

export default function WhatsNewDialog(props: WhatsNewDialogProps) {
  const [loadedEntries, setLoadedEntries] = createSignal<readonly ChangelogEntry[]>([]);

  createEffect(() => {
    if (!props.open) return;
    const appVersion = getAppVersion();
    if (isStrictSemver(appVersion) && untrack(() => config.lastSeenVersion) !== appVersion) {
      updateConfig({ lastSeenVersion: appVersion });
    }
    if (props.entries === undefined) {
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });
      void (async () => {
        const data = await loadChangelog();
        if (!cancelled) setLoadedEntries(data);
      })();
    }
  });

  const entries = () => props.entries ?? loadedEntries();

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 bg-black/50 z-[70]" />
        <Dialog.Content class="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg bg-base-100 rounded-xl shadow-xl z-[71] flex flex-col max-h-[85vh]">
          <Dialog.Description class="sr-only">
            Recent release notes and changelog entries for GitHub Tracker
          </Dialog.Description>

          {/* Header */}
          <div class="flex items-center gap-2 px-5 py-4 border-b border-base-300 shrink-0">
            <Dialog.Title class="text-lg font-semibold text-base-content flex-1">
              What's New
            </Dialog.Title>
            <Dialog.CloseButton
              class="btn btn-ghost btn-sm btn-circle"
              aria-label="Close what's new"
            >
              <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path
                  fill-rule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clip-rule="evenodd"
                />
              </svg>
            </Dialog.CloseButton>
          </div>

          {/* Body */}
          <div class="overflow-y-auto flex-1 px-5 py-4 space-y-6">
            <Show
              when={entries().length > 0}
              fallback={
                <p class="text-sm text-base-content/50 text-center py-6">
                  No release notes available.
                </p>
              }
            >
              <For each={entries()}>
                {(entry) => (
                  <section class="space-y-2.5">
                    <div class="flex items-baseline justify-between border-b border-base-200 pb-1.5">
                      <h3 class="text-base font-semibold font-mono text-base-content">
                        v{entry.version}
                      </h3>
                      <span class="text-xs text-base-content/50 font-mono">
                        {entry.date}
                      </span>
                    </div>
                    <For each={entry.sections}>
                      {(section) => (
                        <div class="space-y-1.5">
                          <h4 class="text-xs font-semibold uppercase tracking-wide text-base-content/60">
                            {section.title}
                          </h4>
                          <ul class="list-disc list-inside space-y-1 text-sm text-base-content">
                            <For each={section.items}>
                              {(item) => {
                                const prLink = () => buildPrLink(item.pr);
                                const commitLink = () => buildCommitLink(item.sha);
                                return (
                                  <li class="leading-relaxed">
                                    <span>{item.text.slice(0, CHANGELOG_MAX_ITEM_TEXT_LENGTH)}</span>
                                    <Show when={prLink()}>
                                      {(link) => (
                                        <>
                                          {" "}
                                          <a
                                            href={link().href}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            class="link link-primary font-mono text-xs"
                                          >
                                            {link().label}
                                          </a>
                                        </>
                                      )}
                                    </Show>
                                    <Show when={commitLink()}>
                                      {(link) => (
                                        <>
                                          {" "}
                                          <a
                                            href={link().href}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            class="link link-hover font-mono text-xs text-base-content/50"
                                          >
                                            {link().label}
                                          </a>
                                        </>
                                      )}
                                    </Show>
                                  </li>
                                );
                              }}
                            </For>
                          </ul>
                        </div>
                      )}
                    </For>
                  </section>
                )}
              </For>
            </Show>
          </div>

          {/* Footer */}
          <div class="px-5 py-3 border-t border-base-300 shrink-0 flex items-center justify-between text-xs">
            <a
              href={isSafeGitHubUrl(CHANGELOG_URL) ? CHANGELOG_URL : undefined}
              target="_blank"
              rel="noopener noreferrer"
              class="link link-primary font-medium"
            >
              Full changelog on GitHub
            </a>
            <Dialog.CloseButton class="btn btn-sm btn-ghost">
              Close
            </Dialog.CloseButton>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
