import { vi } from "vitest";

export const ALLOWED_ORIGIN = "https://gh.gordoncode.dev";

/** Parse all structured log calls from a console spy, returning {level, entry} tuples. */
export function collectLogs(spies: {
  info: ReturnType<typeof vi.spyOn>;
  warn: ReturnType<typeof vi.spyOn>;
  error: ReturnType<typeof vi.spyOn>;
}): Array<{ level: string; entry: Record<string, unknown> }> {
  const logs: Array<{ level: string; entry: Record<string, unknown> }> = [];
  for (const [level, spy] of Object.entries(spies)) {
    for (const call of spy.mock.calls) {
      try {
        logs.push({ level, entry: JSON.parse(call[0] as string) });
      } catch {
        // non-JSON console output — ignore
      }
    }
  }
  return logs;
}

/** Find the first log entry matching a given event name. */
export function findLog(
  logs: Array<{ level: string; entry: Record<string, unknown> }>,
  event: string
): { level: string; entry: Record<string, unknown> } | undefined {
  return logs.find((l) => l.entry.event === event);
}
