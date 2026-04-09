// Cloudflare Turnstile client-side API type declarations.
// Turnstile assigns `window.turnstile` synchronously when its script executes.

interface TurnstileRenderOptions {
  sitekey: string;
  size?: "normal" | "compact" | "invisible" | "flexible";
  execution?: "render" | "execute";
  callback?: (token: string) => void;
  "error-callback"?: (errorCode: string) => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
}

interface Turnstile {
  render(container: HTMLElement | string, options: TurnstileRenderOptions): string;
  execute(widgetId: string): void;
  remove(widgetId: string): void;
  reset(widgetId: string): void;
}

interface Window {
  turnstile: Turnstile;
}
