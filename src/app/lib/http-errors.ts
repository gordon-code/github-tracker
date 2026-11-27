export function isUnauthorizedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; response?: { status?: unknown } };
  return e.status === 401 || e.response?.status === 401;
}

/** Releases an unconsumed response body so the connection can be reused. */
export function discardResponseBody(resp: Response): void {
  void Promise.resolve(resp.body?.cancel()).catch(() => {});
}

/** Throws the reason of the first rejected result that is a 401; other results are ignored. */
export function rethrowIfUnauthorized(settled: readonly PromiseSettledResult<unknown>[]): void {
  for (const s of settled) {
    if (s.status === "rejected" && isUnauthorizedError(s.reason)) {
      throw s.reason;
    }
  }
}
