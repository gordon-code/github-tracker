import { Tooltip } from "./Tooltip";

export interface ExpandCollapseButtonsProps {
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

export default function ExpandCollapseButtons(props: ExpandCollapseButtonsProps) {
  return (
    <div class="flex items-center gap-1">
      <Tooltip content="Expand all">
        <button
          class="btn btn-ghost btn-xs"
          aria-label="Expand all"
          onClick={props.onExpandAll}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width={1.5}
            stroke="currentColor"
            class="h-4 w-4"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="m4.5 5.25 7.5 7.5 7.5-7.5m-15 6 7.5 7.5 7.5-7.5"
            />
          </svg>
        </button>
      </Tooltip>
      <Tooltip content="Collapse all">
        <button
          class="btn btn-ghost btn-xs"
          aria-label="Collapse all"
          onClick={props.onCollapseAll}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width={1.5}
            stroke="currentColor"
            class="h-4 w-4"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="m4.5 18.75 7.5-7.5 7.5 7.5m-15-6 7.5-7.5 7.5 7.5"
            />
          </svg>
        </button>
      </Tooltip>
    </div>
  );
}
