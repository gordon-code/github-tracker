import { createSignal, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { user, clearAuth } from "../../stores/auth";
import { getCoreRateLimit, getSearchRateLimit } from "../../services/github";
import { getUnreadCount, markAllAsRead } from "../../lib/errors";
import NotificationDrawer from "../shared/NotificationDrawer";
import ToastContainer from "../shared/ToastContainer";

export default function Header() {
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = createSignal(false);

  function handleLogout() {
    clearAuth();
    navigate("/login");
  }

  function handleBellClick() {
    if (!drawerOpen()) {
      setDrawerOpen(true);
      markAllAsRead();
    } else {
      setDrawerOpen(false);
    }
  }

  const unreadCount = () => getUnreadCount();

  const coreRL = () => getCoreRateLimit();
  const searchRL = () => getSearchRateLimit();

  function formatLimit(remaining: number, limit: number, unit: string): string {
    const k = limit >= 1000 ? `${limit / 1000}k` : String(limit);
    return `${remaining}/${k}/${unit}`;
  }

  return (
    <>
      <header class="fixed top-0 left-0 right-0 z-50 h-14 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 flex items-center px-4 gap-4">
        <span class="font-semibold text-gray-900 dark:text-gray-100 text-lg shrink-0">
          GitHub Tracker
        </span>

        <div class="flex-1" />

        <Show when={coreRL() || searchRL()}>
          <div class="flex items-center gap-2 shrink-0">
            <span class="text-xs font-medium text-gray-400 dark:text-gray-500">Rate Limits</span>
            <div class="flex flex-col items-end text-xs tabular-nums leading-tight gap-0.5">
              <Show when={coreRL()}>
                {(rl) => (
                  <span
                    class={rl().remaining < 500 ? "text-amber-600 dark:text-amber-400" : "text-gray-500 dark:text-gray-400"}
                    title={`Core rate limit resets at ${rl().resetAt.toLocaleTimeString()}`}
                  >
                    {formatLimit(rl().remaining, 5000, "hr")}
                  </span>
                )}
              </Show>
              <Show when={searchRL()}>
                {(rl) => (
                  <span
                    class={rl().remaining < 5 ? "text-amber-600 dark:text-amber-400" : "text-gray-500 dark:text-gray-400"}
                    title={`Search rate limit resets at ${rl().resetAt.toLocaleTimeString()}`}
                  >
                    {formatLimit(rl().remaining, 30, "min")}
                  </span>
                )}
              </Show>
            </div>
          </div>
        </Show>

        <Show when={user()}>
          {(u) => (
            <div class="flex items-center gap-2 shrink-0">
              <img
                src={u().avatar_url}
                alt={u().login}
                class="h-7 w-7 rounded-full"
              />
              <span class="text-sm text-gray-700 dark:text-gray-300 hidden sm:inline">
                {u().name ?? u().login}
              </span>
            </div>
          )}
        </Show>

        <a
          href="/settings"
          class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 shrink-0"
          aria-label="Settings"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-5 w-5"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fill-rule="evenodd"
              d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
              clip-rule="evenodd"
            />
          </svg>
        </a>

        {/* Bell icon with unread badge */}
        <button
          type="button"
          onClick={handleBellClick}
          class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 shrink-0 relative"
          aria-label={unreadCount() > 0 ? `Notifications, ${unreadCount()} unread` : "Notifications"}
          aria-expanded={drawerOpen()}
          aria-haspopup="dialog"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-5 w-5"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
          </svg>
          <Show when={unreadCount() > 0}>
            <span class="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
              {unreadCount() > 9 ? "9+" : unreadCount()}
            </span>
          </Show>
        </button>

        <button
          onClick={handleLogout}
          class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 shrink-0"
          aria-label="Sign out"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-5 w-5"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fill-rule="evenodd"
              d="M3 3a1 1 0 00-1 1v12a1 1 0 102 0V4a1 1 0 00-1-1zm10.293 9.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L14.586 9H7a1 1 0 100 2h7.586l-1.293 1.293z"
              clip-rule="evenodd"
            />
          </svg>
        </button>
      </header>
      <NotificationDrawer open={drawerOpen()} onClose={() => setDrawerOpen(false)} />
      <ToastContainer />
    </>
  );
}
