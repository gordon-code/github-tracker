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
      <div class="flex items-center justify-between px-4 py-2 border-t border-base-300 bg-base-100 text-sm text-base-content/60">
        <span>
          Page {Math.min(props.page, props.pageCount - 1) + 1} of {props.pageCount}
          {" · "}
          {props.totalItems} {props.itemLabel}{props.totalItems !== 1 ? "s" : ""}
        </span>
        <div class="join">
          <button
            onClick={props.onPrev}
            disabled={props.page === 0}
            class="join-item btn btn-sm"
            aria-label="Previous page"
          >
            Prev
          </button>
          <button
            onClick={props.onNext}
            disabled={props.page >= props.pageCount - 1}
            class="join-item btn btn-sm"
            aria-label="Next page"
          >
            Next
          </button>
        </div>
      </div>
    </Show>
  );
}
