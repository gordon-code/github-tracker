import { createEffect, on } from "solid-js";
import { useLocation } from "@solidjs/router";
import { updateAvailable, reloadOncePerTarget } from "../../lib/version";
import { flushPersistedState } from "../../lib/flush-persistence";
import { isSafeInternalHref } from "../../lib/errors";

/**
 * Mounted in the Router root; renders nothing. While an update is waiting, the next
 * pathname change performs a full-page navigation (once per target build) so the
 * destination route loads from the new deployment.
 */
export default function UpdateNavigator() {
  const location = useLocation();
  createEffect(
    on(
      () => location.pathname,
      (path, prev) => {
        if (prev === undefined || path === prev) return;
        // A pathname starting with `//` or `/\` would make the assigned URL
        // protocol-relative (another origin), so only same-origin paths reload.
        if (!isSafeInternalHref(path)) return;
        const info = updateAvailable();
        if (info && reloadOncePerTarget(info.sha)) {
          flushPersistedState();
          window.location.assign(path + location.search + location.hash);
        }
      },
    ),
  );
  return null;
}
