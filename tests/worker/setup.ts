import { vi } from "vitest";

vi.mock("@sentry/cloudflare", () => ({
  withSentry: (_opts: unknown, handler: { fetch: unknown }) => handler,
  captureException: vi.fn(),
  requestDataIntegration: vi.fn(() => ({})),
}));
