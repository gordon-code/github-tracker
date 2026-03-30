import { For, Show } from "solid-js";

interface UserAvatarBadgeProps {
  users: { login: string; avatarUrl: string }[];
  currentUserLogin: string;
}

export default function UserAvatarBadge(props: UserAvatarBadgeProps) {
  const trackedUsers = () =>
    props.users.filter(
      (u) => u.login.toLowerCase() !== props.currentUserLogin.toLowerCase()
    );

  return (
    <Show when={trackedUsers().length > 0}>
      <div class="flex items-center">
        <For each={trackedUsers()}>
          {(u, i) => (
            <div
              class="avatar"
              style={i() > 0 ? { "margin-left": "-6px" } : {}}
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
