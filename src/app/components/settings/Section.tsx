import { JSX } from "solid-js";

export default function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="card bg-base-100 border border-base-300">
      <div class="bg-base-200 px-4 py-2 rounded-t-lg border-b border-base-300">
        <h2 class="text-sm font-semibold text-base-content">{props.title}</h2>
      </div>
      <div class="card-body p-0">{props.children}</div>
    </div>
  );
}
