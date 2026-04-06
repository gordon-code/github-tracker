import { createMemo, createSignal } from "solid-js";
import { Tooltip as KobalteTooltip } from "@kobalte/core/tooltip";
import type { JSX } from "solid-js";

// SECURITY: tooltip content must be JSX children, never raw HTML

interface TooltipProps {
  content: string;
  placement?: "top" | "bottom" | "left" | "right";
  focusable?: boolean;
  children: JSX.Element;
}

export function Tooltip(props: TooltipProps) {
  const [isHovered, setIsHovered] = createSignal(false);
  const [isFocused, setIsFocused] = createSignal(false);
  const open = createMemo(() => isHovered() || isFocused());

  return (
    <KobalteTooltip
      open={open()}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          setIsHovered(false);
          setIsFocused(false);
        }
      }}
      placement={props.placement ?? "top"}
      gutter={4}
      openDelay={300}
    >
      <KobalteTooltip.Trigger
        as="span"
        class="inline-flex"
        tabindex={props.focusable ? "0" : undefined}
        onPointerEnter={() => setIsHovered(true)}
        onPointerLeave={() => setIsHovered(false)}
        onFocusIn={() => setIsFocused(true)}
        onFocusOut={() => setIsFocused(false)}
      >
        {props.children}
      </KobalteTooltip.Trigger>
      <KobalteTooltip.Portal>
        <KobalteTooltip.Content class="z-50 max-w-xs rounded bg-neutral px-2 py-1 text-xs text-neutral-content shadow-lg">
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
        <KobalteTooltip.Content class="z-50 max-w-xs rounded bg-neutral px-2 py-1 text-xs text-neutral-content shadow-lg">
          <KobalteTooltip.Arrow />
          {props.content}
        </KobalteTooltip.Content>
      </KobalteTooltip.Portal>
    </KobalteTooltip>
  );
}
