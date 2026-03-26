import { For, Show } from "solid-js";
import { config, setConfig, THEME_OPTIONS, DARK_THEMES } from "../../stores/config";
import type { ThemeId } from "../../stores/config";

const CONCRETE_THEMES = THEME_OPTIONS.filter((t): t is Exclude<ThemeId, "auto"> => t !== "auto");
const LIGHT_THEMES = CONCRETE_THEMES.filter((t) => !DARK_THEMES.has(t));
const DARK_THEME_LIST = CONCRETE_THEMES.filter((t) => DARK_THEMES.has(t));

export default function ThemePicker() {
  return (
    <div class="px-4 py-3 space-y-3">
      {/* Auto mode banner */}
      <div
        class={`flex items-center justify-between rounded-lg border-2 p-3 cursor-pointer transition-colors ${config.theme === "auto" ? "border-primary ring-2 ring-primary/30 bg-base-200" : "border-base-300"}`}
        onClick={() => setConfig("theme", "auto")}
        role="button"
        aria-pressed={config.theme === "auto"}
        aria-label="Theme: auto (follows system)"
      >
        <div class="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-base-content/60" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" />
          </svg>
          <span class="text-sm text-base-content font-medium">Auto</span>
          <span class="text-xs text-base-content/50">follows system</span>
        </div>
        <Show when={config.theme !== "auto"}>
          <span class="text-xs text-primary cursor-pointer hover:underline">reset</span>
        </Show>
      </div>

      {/* Light themes */}
      <div>
        <span class="text-xs font-medium text-base-content/50 uppercase tracking-wider px-1">Light</span>
        <div class="grid grid-cols-4 gap-2 mt-1">
          <For each={LIGHT_THEMES}>
            {(theme) => <ThemeSwatch theme={theme} />}
          </For>
        </div>
      </div>

      {/* Dark themes */}
      <div>
        <span class="text-xs font-medium text-base-content/50 uppercase tracking-wider px-1">Dark</span>
        <div class="grid grid-cols-4 gap-2 mt-1">
          <For each={DARK_THEME_LIST}>
            {(theme) => <ThemeSwatch theme={theme} />}
          </For>
        </div>
      </div>
    </div>
  );
}

function ThemeSwatch(props: { theme: Exclude<ThemeId, "auto"> }) {
  const isActive = () => config.theme === props.theme;
  return (
    <button
      data-theme={props.theme}
      class={`rounded-lg border-2 p-2 cursor-pointer transition-colors ${isActive() ? "border-primary ring-2 ring-primary/30" : "border-base-300"}`}
      onClick={() => setConfig("theme", props.theme)}
      aria-label={`Theme: ${props.theme}`}
      aria-pressed={isActive()}
    >
      <div class="flex gap-1 mb-1">
        <div class="rounded-full w-3 h-3 bg-primary" />
        <div class="rounded-full w-3 h-3 bg-secondary" />
        <div class="rounded-full w-3 h-3 bg-accent" />
      </div>
      <div class="bg-base-100 rounded px-1">
        <span class="text-xs text-base-content capitalize">{props.theme}</span>
      </div>
    </button>
  );
}
