import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { Tooltip } from "./Tooltip";

export interface DraftBadgeProps {
  draft: boolean;
  compact?: boolean;
  prNumber?: number;
  prTitle?: string;
  /** Defined only when canMarkPRReady(pr, userLogin) is true */
  onMarkReady?: () => void;
  /** True while markPullRequestReady mutation is in flight for this PR */
  isMarkingReady?: boolean;
}

const READY_CONFIRM_TIMEOUT_MS = 4_000;

export default function DraftBadge(props: DraftBadgeProps) {
  const [confirming, setConfirming] = createSignal(false);
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer() {
    if (confirmTimer !== undefined) {
      clearTimeout(confirmTimer);
      confirmTimer = undefined;
    }
  }

  function resetConfirm() {
    clearTimer();
    setConfirming(false);
  }

  const isMarkingReady = createMemo(() => Boolean(props.isMarkingReady));

  createEffect(
    on(
      [() => props.draft, () => props.onMarkReady, isMarkingReady],
      (curr, prev) => {
        if (!prev || curr.some((v, i) => v !== prev[i])) {
          resetConfirm();
        }
      },
      { defer: true },
    ),
  );

  onCleanup(clearTimer);

  function handleClick(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (props.isMarkingReady || !props.onMarkReady) return;
    if (!confirming()) {
      setConfirming(true);
      clearTimer();
      confirmTimer = setTimeout(() => {
        confirmTimer = undefined;
        setConfirming(false);
      }, READY_CONFIRM_TIMEOUT_MS);
      return;
    }
    resetConfirm();
    props.onMarkReady();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && confirming()) {
      e.stopPropagation();
      e.preventDefault();
      resetConfirm();
    }
  }

  const meta = createMemo(() => {
    const target = [props.prNumber != null ? `#${props.prNumber}` : "", props.prTitle ?? ""]
      .filter(Boolean)
      .join(" ");
    const labelTarget = target ? ` ${target}` : "";
    const sizeClass = props.compact ? "badge-xs" : "badge-sm";

    if (props.isMarkingReady) {
      return {
        tooltip: "Marking ready for review...",
        ariaLabel: `Marking${labelTarget} ready for review`,
        buttonClass: `badge badge-ghost ${sizeClass}`,
      };
    }

    if (confirming()) {
      return {
        tooltip: "Click again to mark ready for review",
        ariaLabel: `Confirm mark${labelTarget} ready for review`,
        buttonClass: `badge badge-warning cursor-pointer font-medium ${sizeClass}`,
      };
    }

    return {
      tooltip: "Click to mark ready for review",
      ariaLabel: `Mark${labelTarget} ready for review`,
      buttonClass: `badge badge-ghost italic text-base-content/70 hover:badge-info hover:not-italic hover:text-info-content cursor-pointer transition-colors ${sizeClass}`,
    };
  });

  return (
    <Show when={props.draft}>
      <Show
        when={props.onMarkReady !== undefined}
        fallback={
          <span
            data-testid="draft-badge"
            class={
              props.compact
                ? "badge badge-ghost badge-xs italic text-base-content/50"
                : "badge badge-ghost badge-sm italic text-base-content/50"
            }
          >
            {props.compact ? "D" : "Draft"}
          </span>
        }
      >
        <Tooltip content={meta().tooltip} class="relative z-10 inline-flex">
          <button
            type="button"
            data-testid="draft-badge"
            data-draft-ready-btn
            disabled={props.isMarkingReady}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            onBlur={resetConfirm}
            aria-label={meta().ariaLabel}
            class={meta().buttonClass}
          >
            <Show
              when={!props.isMarkingReady}
              fallback={<span class="loading loading-spinner loading-xs" aria-hidden="true" />}
            >
              <Show when={confirming()} fallback={props.compact ? "D" : "Draft"}>
                Ready?
              </Show>
            </Show>
          </button>
        </Tooltip>
      </Show>
    </Show>
  );
}
