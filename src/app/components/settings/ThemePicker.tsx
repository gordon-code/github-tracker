import { For } from "solid-js";
import { config, setConfig, THEME_OPTIONS } from "../../stores/config";
import type { ThemeId } from "../../stores/config";

export default function ThemePicker() {
  return (
    <div class="grid grid-cols-3 sm:grid-cols-5 gap-2 px-4 py-3">
      <For each={[...THEME_OPTIONS]}>
        {(theme: ThemeId) => (
          <button
            data-theme={theme}
            class={`rounded-lg border-2 p-2 cursor-pointer transition-colors ${config.theme === theme ? "border-primary ring-2 ring-primary/30" : "border-base-300"}`}
            onClick={() => setConfig("theme", theme)}
            aria-label={`Theme: ${theme}`}
            aria-pressed={config.theme === theme}
          >
            <div class="flex gap-1 mb-1">
              <div class="rounded-full w-3 h-3 bg-primary" />
              <div class="rounded-full w-3 h-3 bg-secondary" />
              <div class="rounded-full w-3 h-3 bg-accent" />
            </div>
            <div class="bg-base-100 rounded px-1">
              <span class="text-xs text-base-content capitalize">{theme}</span>
            </div>
          </button>
        )}
      </For>
    </div>
  );
}
