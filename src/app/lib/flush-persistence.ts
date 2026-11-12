import { flushConfigPersistence } from "../stores/config";
import { flushViewPersistence } from "../stores/view";

/**
 * Synchronously commits any debounced config/view-state writes. Call immediately
 * before unloading the page (reload or full navigation), where the debounce
 * timers would otherwise be discarded.
 */
export function flushPersistedState(): void {
  flushConfigPersistence();
  flushViewPersistence();
}
