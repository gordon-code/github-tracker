import { createEffect, Show } from "solid-js";
import { schemaStale, updateAvailable } from "../../lib/version";
import { dismissNotificationBySource, pushNotification } from "../../lib/errors";
import { flushPersistedState } from "../../lib/flush-persistence";
import { CHANGELOG_URL } from "../../lib/repo-links";
import { isSafeGitHubUrl } from "../../lib/url";

const UPDATE_NOTIFICATION_SOURCE = "app-update";

export default function UpdateBanner() {
  let notified = false;

  createEffect(() => {
    const info = updateAvailable();
    if (info && !notified) {
      notified = true;
      // The banner already announces the update; record it in the drawer without a toast.
      pushNotification(
        UPDATE_NOTIFICATION_SOURCE,
        "A new version of GitHub Tracker is available — reload to update.",
        "info",
        false,
        undefined,
        { silentToast: true },
      );
    } else if (!info && notified) {
      notified = false;
      dismissNotificationBySource(UPDATE_NOTIFICATION_SOURCE);
    }
  });

  const handleReload = () => {
    flushPersistedState();
    window.location.reload();
  };

  return (
    <Show when={updateAvailable()}>
      <div
        role="status"
        aria-live="polite"
        class="alert alert-info fixed bottom-4 inset-x-4 z-[60] max-w-xl mx-auto shadow-lg flex items-center justify-between gap-3 py-2.5 px-4"
      >
        <span class="text-sm font-medium">
          A new version is available.
          <Show when={schemaStale()}>
            {" "}This tab can't save changes, and Settings are read-only, until you reload.
          </Show>
        </span>
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
