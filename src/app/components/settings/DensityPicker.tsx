import { config, setConfig } from "../../stores/config";
import type { Config } from "../../stores/config";

type Density = Config["viewDensity"];

/** Skeleton of a comfortable-mode item row: title line, labels row, badges row */
function ComfortablePreviewRow() {
  return (
    <div class="flex items-start gap-1.5 px-2 py-1.5">
      {/* Status dot */}
      <div class="rounded-full w-1.5 h-1.5 bg-success shrink-0 mt-1" />
      {/* Content column */}
      <div class="flex-1 min-w-0 space-y-1">
        {/* Title line: #number + title */}
        <div class="flex items-center gap-1">
          <div class="rounded bg-base-content/15 w-3 h-1.5 shrink-0" />
          <div class="rounded bg-base-content/25 flex-1 h-2" />
        </div>
        {/* Labels row: colored pills */}
        <div class="flex items-center gap-0.5">
          <div class="rounded-full bg-error/30 w-5 h-1.5" />
          <div class="rounded-full bg-info/30 w-7 h-1.5" />
        </div>
        {/* Badges row */}
        <div class="flex items-center gap-0.5">
          <div class="rounded bg-success/30 w-4 h-1.5" />
          <div class="rounded bg-warning/30 w-3 h-1.5" />
        </div>
      </div>
      {/* Right column: author + time */}
      <div class="shrink-0 flex flex-col items-end gap-0.5">
        <div class="rounded bg-base-content/10 w-5 h-1.5" />
        <div class="rounded bg-base-content/10 w-4 h-1" />
      </div>
    </div>
  );
}

/** Skeleton of a compact-mode item row: everything on one line */
function CompactPreviewRow() {
  return (
    <div class="flex items-center gap-1 px-2 py-0.5">
      {/* Status dot */}
      <div class="rounded-full w-1.5 h-1.5 bg-success shrink-0" />
      {/* #number */}
      <div class="rounded bg-base-content/15 w-2 h-1.5 shrink-0" />
      {/* Title */}
      <div class="rounded bg-base-content/25 flex-1 h-1.5" />
      {/* Inline badges */}
      <div class="rounded bg-success/30 w-2.5 h-1.5 shrink-0" />
      <div class="rounded bg-warning/30 w-2 h-1.5 shrink-0" />
      {/* Label icon */}
      <div class="rounded bg-base-content/10 w-1.5 h-1.5 shrink-0" />
      {/* Author · time */}
      <div class="rounded bg-base-content/10 w-6 h-1.5 shrink-0" />
    </div>
  );
}

function DensityCard(props: { density: Density; label: string; description: string }) {
  const isActive = () => config.viewDensity === props.density;
  const isCompact = props.density === "compact";
  const Row = isCompact ? CompactPreviewRow : ComfortablePreviewRow;

  return (
    <button
      class={`flex-1 rounded-lg border-2 p-2 cursor-pointer transition-colors text-left ${isActive() ? "border-primary ring-2 ring-primary/30" : "border-base-300 hover:border-base-content/20"}`}
      onClick={() => setConfig("viewDensity", props.density)}
      aria-label={`View density: ${props.label}`}
      aria-pressed={isActive()}
    >
      <div class="bg-base-100 rounded overflow-hidden border border-base-300 mb-1.5">
        <Row />
        <div class="border-t border-base-200" />
        <Row />
        <div class="border-t border-base-200" />
        <Row />
      </div>
      <div class="mt-1">
        <span class="text-xs font-medium text-base-content">{props.label}</span>
        <span class="text-[10px] text-base-content/50 ml-1">{props.description}</span>
      </div>
    </button>
  );
}

export default function DensityPicker() {
  return (
    <div class="flex gap-3">
      <DensityCard density="comfortable" label="Comfortable" description="more detail" />
      <DensityCard density="compact" label="Compact" description="more items" />
    </div>
  );
}
