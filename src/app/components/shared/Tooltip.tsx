import { createMemo, createSignal, onCleanup } from "solid-js";
import { Tooltip as KobalteTooltip } from "@kobalte/core/tooltip";
import type { JSX } from "solid-js";

// content is plain string — JSX children are intentionally not supported to avoid needing sanitization

const TOOLTIP_CONTENT_CLASS = "z-50 max-w-xs rounded bg-neutral px-2 py-1 text-xs text-neutral-content shadow-lg";

interface TooltipProps {
  content: string;
  placement?: "top" | "bottom" | "left" | "right";
  focusable?: boolean;
  class?: string;
  children: JSX.Element;
}

export function Tooltip(props: TooltipProps) {
  const [isHovered, setIsHovered] = createSignal(false);
  const [isFocused, setIsFocused] = createSignal(false);
  const open = createMemo(() => isHovered() || isFocused());

  // openDelay is ignored in controlled mode; implement the delay manually
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(hoverTimer);
    clearTimeout(closeTimer);
  });

  return (
    <KobalteTooltip
      open={open()}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          clearTimeout(hoverTimer);
          clearTimeout(closeTimer);
          setIsHovered(false);
          setIsFocused(false);
        }
      }}
      placement={props.placement ?? "top"}
      gutter={4}
    >
      <KobalteTooltip.Trigger
        as="span"
        class={`inline-flex items-center${props.class ? ` ${props.class}` : ""}`}
        tabindex={props.focusable ? "0" : undefined}
        onPointerEnter={() => {
          clearTimeout(hoverTimer);
          clearTimeout(closeTimer);
          hoverTimer = setTimeout(() => setIsHovered(true), 300);
        }}
        onPointerLeave={() => {
          clearTimeout(hoverTimer);
          closeTimer = setTimeout(() => setIsHovered(false), 100);
        }}
        onFocusIn={() => setIsFocused(true)}
        onFocusOut={() => setIsFocused(false)}
      >
        {props.children}
      </KobalteTooltip.Trigger>
      <KobalteTooltip.Portal>
        <KobalteTooltip.Content class={TOOLTIP_CONTENT_CLASS}>
          <KobalteTooltip.Arrow />
          {props.content}
        </KobalteTooltip.Content>
      </KobalteTooltip.Portal>
    </KobalteTooltip>
  );
}

interface InfoTooltipProps {
  content: string;
  placement?: "top" | "bottom" | "left" | "right";
}

export function InfoTooltip(props: InfoTooltipProps) {
  return (
    <KobalteTooltip
      placement={props.placement ?? "top"}
      gutter={4}
      // Uncontrolled mode — Kobalte openDelay works here, unlike Tooltip which uses controlled mode
      openDelay={300}
    >
      <KobalteTooltip.Trigger
        as="button"
        type="button"
        aria-label="More information"
        class="inline-flex items-center justify-center w-4 h-4 rounded-full bg-base-300 text-base-content/60 text-[10px] font-bold cursor-help border-none p-0"
      >
        i
      </KobalteTooltip.Trigger>
      <KobalteTooltip.Portal>
        <KobalteTooltip.Content class={TOOLTIP_CONTENT_CLASS}>
          <KobalteTooltip.Arrow />
          {props.content}
        </KobalteTooltip.Content>
      </KobalteTooltip.Portal>
    </KobalteTooltip>
  );
}
