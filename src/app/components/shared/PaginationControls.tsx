import { Show } from "solid-js";

interface PaginationControlsProps {
  page: number;
  pageCount: number;
  totalItems: number;
  itemLabel: string;
  onPrev: () => void;
  onNext: () => void;
}

export default function PaginationControls(props: PaginationControlsProps) {
  return (
    <Show when={props.pageCount > 1}>
      <div class="flex items-center justify-between px-4 py-2 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-600 dark:text-gray-400">
        <span>
          Page {Math.min(props.page, props.pageCount - 1) + 1} of {props.pageCount}
          {" · "}
          {props.totalItems} {props.itemLabel}{props.totalItems !== 1 ? "s" : ""}
        </span>
        <div class="flex gap-2">
          <button
            onClick={props.onPrev}
            disabled={props.page === 0}
            class="px-3 py-1 rounded-md border border-gray-300 dark:border-gray-600
              bg-white dark:bg-gray-800
              hover:bg-gray-50 dark:hover:bg-gray-700
              disabled:opacity-40 disabled:cursor-not-allowed
              transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label="Previous page"
          >
            Prev
          </button>
          <button
            onClick={props.onNext}
            disabled={props.page >= props.pageCount - 1}
            class="px-3 py-1 rounded-md border border-gray-300 dark:border-gray-600
              bg-white dark:bg-gray-800
              hover:bg-gray-50 dark:hover:bg-gray-700
              disabled:opacity-40 disabled:cursor-not-allowed
              transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label="Next page"
          >
            Next
          </button>
        </div>
      </div>
    </Show>
  );
}
