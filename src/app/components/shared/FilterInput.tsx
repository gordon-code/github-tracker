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
        class="input input-sm w-full pr-8"
      />
      {value() && (
        <button
          type="button"
          onClick={handleClear}
          aria-label="Clear filter"
          class="btn btn-ghost btn-xs btn-circle absolute right-1 top-1/2 -translate-y-1/2"
        >
          <svg
            class="h-3 w-3"
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
