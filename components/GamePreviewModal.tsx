// components/GamePreviewModal.tsx
//
// Shared inline preview: mounts the REAL runtime (lib/runtime/mount) against
// a GameSpec inside a modal, so both a saved/published game (games list,
// editor) and an in-progress draft that hasn't been saved yet (manual build
// wizard) can be played before committing to anything. Telemetry calls from
// mount() degrade gracefully (see lib/runtime/telemetry.ts) when the spec's
// slug isn't a real published game, so this is safe to open on a draft.
"use client";

import { useEffect, useRef, useState } from "react";
import type { GameSpec, Placement } from "@/lib/engine/types";

export function GamePreviewModal({
  spec,
  placement,
  slug,
  onClose,
}: {
  spec: GameSpec;
  placement: Placement;
  slug?: string;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [mountError, setMountError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let handle: { teardown(): void } | undefined;

    async function run() {
      if (!containerRef.current) return;
      containerRef.current.innerHTML = "";
      setMountError(null);
      try {
        const { mount } = await import("@/lib/runtime/mount");
        if (cancelled) return;
        handle = mount(spec, containerRef.current, placement, { slug });
      } catch {
        if (!cancelled) setMountError("Couldn't load the game runtime.");
      }
    }
    run();
    return () => {
      cancelled = true;
      handle?.teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, placement, slug]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-sm animate-pop-in flex-col overflow-hidden rounded-2xl bg-card shadow-elevated"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-semibold">Preview</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="rounded-full p-1.5 text-muted transition hover:bg-foreground/[0.06] hover:text-foreground"
          >
            ✕
          </button>
        </div>
        {/* mount.ts grows its own shell to fit whatever the idle/reward
            overlay actually needs (a reward tier + coupon terms + an
            engaged-products gallery routinely exceeds a template's
            gameplay aspect ratio) — this modal is a fixed-position,
            viewport-centered box with no scroll of its own, so a shell
            taller than the visitor's screen would otherwise have its top
            and bottom pushed off-screen with no way to reach them, not
            "clipped" by any overflow rule but just as unreachable. This
            wrapper is the one thing here that scrolls; the header above
            stays put (shrink-0) as a fixed anchor. */}
        <div className="overflow-y-auto">
          <div ref={containerRef} className="w-full" style={{ minHeight: 480 }} />
          {mountError && <div className="p-6 text-center text-sm text-muted">{mountError}</div>}
        </div>
      </div>
    </div>
  );
}
