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
  const id = `err-${++errorCounter}-${Date.now()}`;
  setErrors((prev) => [...prev, { id, source, message, timestamp: Date.now(), retryable }]);
}

export function dismissError(id: string): void {
  setErrors((prev) => prev.filter((e) => e.id !== id));
}

export function clearErrors(): void {
  setErrors([]);
}
