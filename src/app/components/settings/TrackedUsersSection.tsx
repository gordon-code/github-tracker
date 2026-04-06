import { createSignal, For, Show } from "solid-js";
import type { TrackedUser } from "../../stores/config";
import { user } from "../../stores/auth";
import { validateGitHubUser } from "../../services/api";
import { getClient } from "../../services/github";
import { Tooltip } from "../shared/Tooltip";

interface TrackedUsersSectionProps {
  users: TrackedUser[];
  onSave: (users: TrackedUser[]) => void;
}

export default function TrackedUsersSection(props: TrackedUsersSectionProps) {
  const [inputLogin, setInputLogin] = createSignal("");
  const [validating, setValidating] = createSignal(false);
  const [validationError, setValidationError] = createSignal<string | null>(null);

  async function handleAdd() {
    const raw = inputLogin().trim().toLowerCase();
    if (!raw) return;

    // Check duplicate (case-insensitive — already lowercased)
    const isDuplicate = props.users.some((u) => u.login.toLowerCase() === raw);
    if (isDuplicate) {
      setValidationError("Already tracking this user");
      return;
    }

    // Check self-tracking
    const currentLogin = user()?.login?.toLowerCase();
    if (currentLogin && raw === currentLogin) {
      setValidationError("Your activity is already included in your dashboard");
      return;
    }

    // Soft cap
    if (props.users.length >= 10) {
      setValidationError("Maximum of 10 tracked users");
      return;
    }

    const client = getClient();
    if (!client) {
      setValidationError("Not connected — try again");
      return;
    }

    setValidating(true);
    setValidationError(null);
    try {
      const validated = await validateGitHubUser(client, raw);
      if (!validated) {
        setValidationError("User not found");
        return;
      }
      props.onSave([...props.users, validated]);
      setInputLogin("");
    } catch {
      setValidationError("Validation failed — try again");
    } finally {
      setValidating(false);
    }
  }

  function handleRemove(login: string) {
    props.onSave(props.users.filter((u) => u.login !== login));
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      void handleAdd();
    }
  }

  return (
    <div class="flex flex-col gap-3">
      {/* Add input row */}
      <div class="flex items-center gap-2">
        <input
          type="text"
          placeholder="GitHub username"
          value={inputLogin()}
          onInput={(e) => {
            setInputLogin(e.currentTarget.value);
            setValidationError(null);
          }}
          onKeyDown={handleKeyDown}
          disabled={validating()}
          class="input input-sm flex-1"
          aria-label="GitHub username"
        />
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={validating() || props.users.length >= 10}
          class="btn btn-sm btn-primary"
        >
          {validating() ? "Adding..." : "Add"}
        </button>
      </div>

      {/* Validation error */}
      <Show when={validationError()}>
        <div role="alert" class="alert alert-error text-xs py-2">
          {validationError()}
        </div>
      </Show>

      {/* User list */}
      <For each={props.users}>
        {(trackedUser) => (
          <div class="flex items-center gap-3">
            <div class="avatar">
              <div class="w-6 rounded-full">
                <img src={trackedUser.avatarUrl} alt={trackedUser.login} />
              </div>
            </div>
            <div class="flex flex-col flex-1 min-w-0">
              <span class="text-sm font-medium truncate">
                {trackedUser.name ?? trackedUser.login}
              </span>
              <div class="flex items-center gap-1">
                <Show when={trackedUser.name}>
                  <span class="text-xs text-base-content/60 truncate">
                    {trackedUser.login}
                  </span>
                </Show>
                <Show when={trackedUser.type === "bot"}>
                  <span class="badge badge-xs badge-outline" aria-label={`${trackedUser.login} is a bot account`}>bot</span>
                </Show>
              </div>
            </div>
            <Tooltip content={`Remove ${trackedUser.login}`}>
              <button
                type="button"
                onClick={() => handleRemove(trackedUser.login)}
                class="btn btn-sm btn-ghost btn-circle"
                aria-label={`Remove ${trackedUser.login}`}
              >
                <svg
                  class="h-4 w-4"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fill-rule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clip-rule="evenodd"
                  />
                </svg>
              </button>
            </Tooltip>
          </div>
        )}
      </For>

      {/* API usage warning at 3+ users */}
      <Show when={props.users.length >= 3}>
        <div role="alert" class="alert alert-warning text-xs py-2">
          Each tracked user increases API usage by ~30 points per refresh. Adding many users may
          cause GitHub rate limiting.
        </div>
      </Show>

      {/* Cap reached message */}
      <Show when={props.users.length >= 10}>
        <div role="alert" class="alert alert-info text-xs py-2">
          Maximum of 10 tracked users
        </div>
      </Show>
    </div>
  );
}
