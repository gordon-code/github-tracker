import { createSignal, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { user, clearAuth } from "../../stores/auth";
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

  return (
    <>
      <header class="navbar fixed top-0 left-0 right-0 z-50 bg-base-100 border-b border-base-300 shadow-sm min-h-14">
        <div class="max-w-6xl mx-auto w-full flex items-center gap-4 px-4">
        <span class="font-semibold text-base-content text-lg shrink-0 inline-flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <defs><clipPath id="nav-lens"><circle cx="6.5" cy="6.5" r="5"/></clipPath></defs>
            <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0"/>
            <g clip-path="url(#nav-lens)"><g transform="translate(3.05,2.66) scale(0.32)"><path d="M15 13.25a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0Zm-12.5 6a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0Zm0-14.5a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0ZM5.75 6.5a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 5.75 6.5Zm0 14.5a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 5.75 21Zm12.5-6a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 18.25 15Z"/><path d="M6.5 7.25c0 2.9 2.35 5.25 5.25 5.25h4.5V14h-4.5A6.75 6.75 0 0 1 5 7.25Z"/><path d="M5.75 16.75A.75.75 0 0 1 5 16V8a.75.75 0 0 1 1.5 0v8a.75.75 0 0 1-.75.75Z"/></g></g>
          </svg>
          GitHub Tracker
        </span>

        <div class="flex-1" />

        <Show when={user()}>
          {(u) => (
            <div class="flex items-center gap-2 shrink-0">
              <img
                src={u().avatar_url}
                alt={u().login}
                class="h-7 w-7 rounded-full"
              />
              <span class="text-sm text-base-content hidden sm:inline">
                {u().name ?? u().login}
              </span>
            </div>
          )}
        </Show>

        <a
          href="/settings"
          class="btn btn-ghost btn-sm shrink-0"
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
          class="btn btn-ghost btn-sm shrink-0 relative"
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
            <span class="badge badge-error badge-xs absolute -top-1 -right-1 flex items-center justify-center text-[10px] font-bold">
              {unreadCount() > 9 ? "9+" : unreadCount()}
            </span>
          </Show>
        </button>

        <button
          type="button"
          onClick={handleLogout}
          class="btn btn-ghost btn-sm shrink-0"
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
        </div>
      </header>
      <NotificationDrawer open={drawerOpen()} onClose={() => setDrawerOpen(false)} />
      <ToastContainer />
    </>
  );
}
