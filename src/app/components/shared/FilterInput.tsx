import { createSignal, onCleanup } from "solid-js";

interface FilterInputProps {
  placeholder?: string;
  onFilter: (value: string) => void;
  debounceMs?: number;
}

export default function FilterInput(props: FilterInputProps) {
  const [value, setValue] = createSignal("");
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
  });

  function handleInput(e: InputEvent) {
    const newValue = (e.currentTarget as HTMLInputElement).value;
    setValue(newValue);
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      props.onFilter(newValue);
    }, props.debounceMs ?? 150);
  }

  function handleClear() {
    setValue("");
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    props.onFilter("");
  }

  return (
    <div class="relative">
      <input
        type="text"
        value={value()}
        onInput={handleInput}
        placeholder={props.placeholder ?? "Filter..."}
        class="w-full rounded-md border border-gray-300 bg-white px-3 py-2 pr-8 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500 dark:focus:border-blue-400 dark:focus:ring-blue-400"
      />
      {value() && (
        <button
          type="button"
          onClick={handleClear}
          aria-label="Clear filter"
          class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
        >
          <svg
            class="h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      )}
    </div>
  );
}
