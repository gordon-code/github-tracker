export function isUnauthorizedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; response?: { status?: unknown } };
  return e.status === 401 || e.response?.status === 401;
}
