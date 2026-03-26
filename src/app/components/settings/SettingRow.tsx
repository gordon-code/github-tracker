import { JSX, Show } from "solid-js";

export default function SettingRow(props: {
  label: string;
  description?: string;
  children: JSX.Element;
}) {
  return (
    <div class="flex items-center justify-between px-4 py-3 border-b border-base-300 last:border-b-0">
      <div>
        <div class="text-sm font-medium text-base-content">{props.label}</div>
        <Show when={props.description}>
          <div class="text-xs text-base-content/60">{props.description}</div>
        </Show>
      </div>
      <div>{props.children}</div>
    </div>
  );
}
