import { createEffect, Show } from "solid-js";
import { updateAvailable } from "../../lib/version";
import { pushNotification } from "../../lib/errors";
import { isSafeGitHubUrl } from "../../lib/url";
import { flushConfigPersistence } from "../../stores/config";
import { flushViewPersistence } from "../../stores/view";

export const CHANGELOG_URL = "https://github.com/gordon-code/github-tracker/blob/main/CHANGELOG.md";

export default function UpdateBanner() {
  let notified = false;

  createEffect(() => {
    const info = updateAvailable();
    if (info && !notified) {
      notified = true;
      pushNotification(
        "app-update",
        "A new version of GitHub Tracker is available — reload to update.",
        "info",
      );
    }
  });

  const handleReload = () => {
    flushConfigPersistence();
    flushViewPersistence();
    window.location.reload();
  };

  return (
    <Show when={updateAvailable()}>
      <div
        role="status"
        aria-live="polite"
        class="alert alert-info fixed bottom-4 inset-x-4 z-[60] max-w-xl mx-auto shadow-lg flex items-center justify-between gap-3 py-2.5 px-4"
      >
        <span class="text-sm font-medium">A new version is available.</span>
        <div class="flex items-center gap-3 shrink-0">
          <Show when={isSafeGitHubUrl(CHANGELOG_URL)}>
            <a
              href={CHANGELOG_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="link link-hover text-sm font-medium"
            >
              Changelog
            </a>
          </Show>
          <button
            type="button"
            class="btn btn-sm btn-primary"
            onClick={handleReload}
          >
            Reload
          </button>
        </div>
      </div>
    </Show>
  );
}
