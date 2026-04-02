import { createMemo, For, Show } from "solid-js";

export function buildSurfacedByUsers(
  surfacedBy: string[] | undefined,
  trackedUserMap: Map<string, { login: string; avatarUrl: string }>,
): { login: string; avatarUrl: string }[] {
  return (surfacedBy ?? []).flatMap((login) => {
    const u = trackedUserMap.get(login);
    return u ? [{ login: u.login, avatarUrl: u.avatarUrl }] : [];
  });
}

interface UserAvatarBadgeProps {
  users: { login: string; avatarUrl: string }[];
  currentUserLogin: string;
}

export default function UserAvatarBadge(props: UserAvatarBadgeProps) {
  const trackedUsers = createMemo(() =>
    props.users.filter(
      (u) => u.login.toLowerCase() !== props.currentUserLogin.toLowerCase()
    )
  );

  return (
    <Show when={trackedUsers().length > 0}>
      <div
        class="flex items-center"
        aria-label={`Surfaced by: ${trackedUsers().map(u => u.login).join(", ")}`}
      >
        <For each={trackedUsers()}>
          {(u, i) => (
            <div
              class={`avatar${i() > 0 ? " -ml-1.5" : ""}`}
            >
              <div class="w-5 rounded-full ring-1 ring-base-100">
                <img
                  src={u.avatarUrl}
                  alt={u.login}
                  title={u.login}
                />
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
