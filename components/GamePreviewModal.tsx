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
        className="w-full max-w-sm animate-pop-in overflow-hidden rounded-2xl bg-card shadow-elevated"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
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
        <div ref={containerRef} className="w-full" style={{ minHeight: 480 }} />
        {mountError && <div className="p-6 text-center text-sm text-muted">{mountError}</div>}
      </div>
    </div>
  );
}
