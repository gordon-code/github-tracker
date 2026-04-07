import { JSX, Show } from "solid-js";

export default function SettingRow(props: {
  label: string;
  labelSuffix?: JSX.Element;
  description?: string;
  children: JSX.Element;
}) {
  return (
    <div class="flex items-center justify-between px-4 py-3 border-b border-base-300 last:border-b-0">
      <div>
        <div class="flex items-center gap-1.5 text-sm font-medium text-base-content">
          {props.label}
          {props.labelSuffix}
        </div>
        <Show when={props.description}>
          <div class="text-xs text-base-content/60">{props.description}</div>
        </Show>
      </div>
      <div>{props.children}</div>
    </div>
  );
}
