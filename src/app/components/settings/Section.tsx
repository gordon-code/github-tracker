import { JSX, Show } from "solid-js";

export default function Section(props: { title: string; description?: string; children: JSX.Element }) {
  return (
    <div class="card bg-base-100 border border-base-300">
      <div class="bg-base-200 px-4 py-2 rounded-t-lg border-b border-base-300">
        <h2 class="text-sm font-semibold text-base-content">{props.title}</h2>
        <Show when={props.description}>
          <p class="text-xs text-base-content/60 mt-0.5">{props.description}</p>
        </Show>
      </div>
      <div class="card-body p-0">{props.children}</div>
    </div>
  );
}
