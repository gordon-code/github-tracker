import { createEffect, createSignal, For, Show, untrack } from "solid-js";
import { Dialog } from "@kobalte/core/dialog";
import type { ChangelogEntry } from "../../../shared/changelog-schema";
import { isStrictSemver, loadChangelog } from "../../lib/changelog";
import { isSafeGitHubUrl } from "../../lib/url";
import { APP_VERSION } from "../../lib/version";
import { config, updateConfig } from "../../stores/config";

const REPO_BASE_URL = "https://github.com/gordon-code/github-tracker";
const CHANGELOG_URL = `${REPO_BASE_URL}/blob/main/CHANGELOG.md`;
const HEX_SHA_RE = /^[0-9a-f]{7,40}$/;

function buildPrUrl(pr: number | undefined): string | undefined {
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0) return undefined;
  const url = `${REPO_BASE_URL}/pull/${pr}`;
  return isSafeGitHubUrl(url) ? url : undefined;
}

function buildCommitUrl(sha: string | undefined): string | undefined {
  if (typeof sha !== "string" || !HEX_SHA_RE.test(sha)) return undefined;
  const url = `${REPO_BASE_URL}/commit/${sha}`;
  return isSafeGitHubUrl(url) ? url : undefined;
}

export interface WhatsNewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries?: readonly ChangelogEntry[];
}

export default function WhatsNewDialog(props: WhatsNewDialogProps) {
  const [loadedEntries, setLoadedEntries] = createSignal<readonly ChangelogEntry[]>([]);

  createEffect(() => {
    if (!props.open) return;
    if (isStrictSemver(APP_VERSION) && untrack(() => config.lastSeenVersion) !== APP_VERSION) {
      updateConfig({ lastSeenVersion: APP_VERSION });
    }
    if (props.entries === undefined) {
      void (async () => {
        const data = await loadChangelog();
        setLoadedEntries(data);
      })();
    }
  });

  const entries = () => props.entries ?? loadedEntries();
  const fullChangelogHref = () => (isSafeGitHubUrl(CHANGELOG_URL) ? CHANGELOG_URL : undefined);

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
                                const prHref = () => buildPrUrl(item.pr);
                                const shaHref = () => buildCommitUrl(item.sha);
                                return (
                                  <li class="leading-relaxed">
                                    <span>{item.text.slice(0, 300)}</span>
                                    <Show when={prHref()}>
                                      {(href) => (
                                        <>
                                          {" "}
                                          <a
                                            href={href()}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            class="link link-primary font-mono text-xs"
                                          >
                                            #{item.pr}
                                          </a>
                                        </>
                                      )}
                                    </Show>
                                    <Show when={shaHref()}>
                                      {(href) => (
                                        <>
                                          {" "}
                                          <a
                                            href={href()}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            class="link link-hover font-mono text-xs text-base-content/50"
                                          >
                                            ({item.sha!.slice(0, 7)})
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
          <Show when={fullChangelogHref()}>
            {(href) => (
              <div class="px-5 py-3 border-t border-base-300 shrink-0 flex items-center justify-between text-xs">
                <a
                  href={href()}
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
            )}
          </Show>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
