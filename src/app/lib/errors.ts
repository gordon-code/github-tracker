import { createSignal } from "solid-js";

export interface AppError {
  id: string;
  source: string;
  message: string;
  timestamp: number;
  retryable: boolean;
}

const [errors, setErrors] = createSignal<AppError[]>([]);

let errorCounter = 0;

export function getErrors(): AppError[] {
  return errors();
}

export function pushError(source: string, message: string, retryable = false): void {
  // Intentional design: deduplicate by source to prevent banner spam from repeated
  // rate limit retries or polling cycles. Trade-off: if two different errors share
  // a source (e.g., "search" for both "incomplete" and "capped"), only the latest
  // message survives. This is acceptable because the latest error is the most actionable.
  setErrors((prev) => {
    const existing = prev.find((e) => e.source === source);
    if (existing) {
      return prev.map((e) =>
        e.source === source
          ? { ...e, message, timestamp: Date.now(), retryable }
          : e
      );
    }
    const id = `err-${++errorCounter}-${Date.now()}`;
    return [...prev, { id, source, message, timestamp: Date.now(), retryable }];
  });
}

export function dismissError(id: string): void {
  setErrors((prev) => prev.filter((e) => e.id !== id));
}

export function clearErrors(): void {
  setErrors([]);
}
