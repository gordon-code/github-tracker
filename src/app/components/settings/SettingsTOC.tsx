import { createSignal, createMemo, createEffect, onMount, onCleanup, For, Show } from "solid-js";

export const SETTINGS_SECTIONS = [
  { id: "orgs-repos", label: "Orgs & Repos", group: "Data Sources" },
  { id: "tracked-users", label: "Tracked Users", group: "Data Sources" },
  { id: "refresh", label: "Refresh", group: "Data Sources" },
  { id: "api-usage", label: "API Usage", group: "Data Sources" },
  { id: "appearance", label: "Appearance", group: "Display" },
  { id: "tabs", label: "Tabs", group: "Display" },
  { id: "custom-tabs", label: "Custom Tabs", group: "Display" },
  { id: "actions", label: "Actions", group: "Integrations" },
  { id: "notifications", label: "Notifications", group: "Integrations" },
  { id: "mcp-relay", label: "MCP Relay", group: "Integrations" },
  { id: "jira", label: "Jira", group: "Integrations" },
  { id: "dependencies", label: "Dependencies", group: "Integrations" },
  { id: "data", label: "Data", group: "Account" },
] as const;

const SETTINGS_GROUPS: { name: string; items: (typeof SETTINGS_SECTIONS)[number][] }[] = [];
for (const s of SETTINGS_SECTIONS) {
  const g = SETTINGS_GROUPS.find((x) => x.name === s.group);
  if (g) g.items.push(s);
  else SETTINGS_GROUPS.push({ name: s.group, items: [s] });
}

function useScrollSpy() {
  const [activeId, setActiveId] = createSignal<string>(SETTINGS_SECTIONS[0].id);

  onMount(() => {
    const intersecting = new Map<string, IntersectionObserverEntry>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            intersecting.set(entry.target.id, entry);
          } else {
            intersecting.delete(entry.target.id);
          }
        }

        if (intersecting.size > 0) {
          const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
          if (atBottom) {
            setActiveId(SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1].id);
          } else {
            let nearest: string | null = null;
            let nearestDist = Infinity;
            for (const [id, entry] of intersecting) {
              const dist = Math.abs(entry.boundingClientRect.top);
              if (dist < nearestDist) {
                nearestDist = dist;
                nearest = id;
              }
            }
            if (nearest) setActiveId(nearest);
          }
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: [0, 1] }
    );

    for (const section of SETTINGS_SECTIONS) {
      const el = document.getElementById(section.id);
      if (el) observer.observe(el);
    }

    onCleanup(() => observer.disconnect());
  });

  return activeId;
}

export default function SettingsTOC() {
  const activeId = useScrollSpy();
  const [scrollingTo, setScrollingTo] = createSignal<string | null>(null);
  const [mobileOpen, setMobileOpen] = createSignal(false);

  const displayedActiveId = createMemo(() => scrollingTo() ?? activeId());
  const activeLabel = createMemo(() =>
    SETTINGS_SECTIONS.find((s) => s.id === displayedActiveId())?.label ?? SETTINGS_SECTIONS[0].label
  );

  let scrollEndCleanup: (() => void) | undefined;

  function smoothScrollTo(targetY: number, onDone: () => void) {
    const startY = window.scrollY;
    const diff = targetY - startY;
    if (Math.abs(diff) < 1) { onDone(); return; }
    const duration = Math.min(500, Math.max(200, Math.abs(diff) * 0.3));
    const startTime = performance.now();
    let raf: number;
    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const ease = progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      window.scrollTo(0, startY + diff * ease);
      if (progress < 1) {
        raf = requestAnimationFrame(step);
      } else {
        onDone();
      }
    };
    raf = requestAnimationFrame(step);
    scrollEndCleanup = () => { cancelAnimationFrame(raf); onDone(); };
  }

  function scrollToSection(id: string) {
    scrollEndCleanup?.();
    setScrollingTo(id);
    document.documentElement.dataset.scrollLock = "1";
    const el = document.getElementById(id);
    if (!el) { setScrollingTo(null); delete document.documentElement.dataset.scrollLock; return; }
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const clear = () => {
      setScrollingTo(null);
      delete document.documentElement.dataset.scrollLock;
      window.dispatchEvent(new Event("scroll"));
      scrollEndCleanup = undefined;
    };
    if (prefersReduced) {
      el.scrollIntoView({ behavior: "instant", block: "start" });
      requestAnimationFrame(clear);
      scrollEndCleanup = undefined;
    } else {
      const style = getComputedStyle(el);
      const scrollMargin = parseFloat(style.scrollMarginTop) || 0;
      const targetY = el.getBoundingClientRect().top + window.scrollY - scrollMargin;
      smoothScrollTo(targetY, clear);
    }
  }

  onCleanup(() => scrollEndCleanup?.());

  let mobileContainerRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (!mobileOpen()) return;
    const handleClickOutside = (e: PointerEvent) => {
      if (mobileContainerRef && !mobileContainerRef.contains(e.target as Node)) {
        setMobileOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileOpen(false);
      }
    };
    document.addEventListener("pointerdown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    onCleanup(() => {
      document.removeEventListener("pointerdown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    });
  });

  return (
    <>
      {/* Desktop sidebar */}
      <nav aria-label="Settings navigation" class="hidden lg:block w-44 shrink-0 sticky top-20 self-start">
        <For each={SETTINGS_GROUPS}>
          {(group) => (
            <div class="mt-4 first:mt-0">
              <p class="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-1 px-2">
                {group.name}
              </p>
              <For each={group.items}>
                {(item) => (
                  <button
                    type="button"
                    onClick={() => scrollToSection(item.id)}
                    aria-current={displayedActiveId() === item.id ? "location" : undefined}
                    class={`block w-full text-left text-sm px-2 py-1 rounded transition-colors ${
                      displayedActiveId() === item.id
                        ? "bg-primary/10 text-primary font-medium border-l-2 border-primary"
                        : "text-base-content/60 hover:text-base-content hover:bg-base-200 border-l-2 border-transparent"
                    }`}
                  >
                    {item.label}
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
      </nav>

      {/* Mobile dropdown */}
      <div class="lg:hidden sticky top-20 z-30 bg-base-200 border-b border-base-300 shadow-sm" data-testid="mobile-toc" ref={(el) => (mobileContainerRef = el)}>
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          class="btn btn-ghost gap-1 w-full justify-start"
          aria-label="Jump to section"
          aria-expanded={mobileOpen()}
          aria-controls="settings-toc-mobile"
        >
          <span class="text-xs text-base-content/60">{activeLabel()}</span>
          <svg class={`h-3 w-3 transition-transform ${mobileOpen() ? "rotate-180" : ""}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
          </svg>
        </button>
        <Show when={mobileOpen()}>
          <div
            id="settings-toc-mobile"
            class="absolute top-full left-0 right-0 bg-base-100 border-b border-base-300 shadow-lg z-40 px-4 py-2 max-h-[60vh] overflow-y-auto"
          >
            <For each={SETTINGS_GROUPS}>
              {(group) => (
                <div class="mt-3 first:mt-0">
                  <p class="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-1">
                    {group.name}
                  </p>
                  <For each={group.items}>
                    {(item) => (
                      <button
                        type="button"
                        onClick={() => {
                          scrollToSection(item.id);
                          setMobileOpen(false);
                        }}
                        aria-current={displayedActiveId() === item.id ? "location" : undefined}
                        class={`block w-full text-left text-sm px-2 py-1 rounded transition-colors ${
                          displayedActiveId() === item.id
                            ? "bg-primary/10 text-primary font-medium"
                            : "text-base-content/60 hover:text-base-content hover:bg-base-200"
                        }`}
                      >
                        {item.label}
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </>
  );
}
