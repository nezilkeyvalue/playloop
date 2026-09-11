"use client";

// app/play/[slug]/PlayRuntime.tsx
//
// Client half of the hosted runtime page. page.tsx (a Server Component)
// resolves a plain, serializable GameSpec + Placement — from a fixture or
// from the DB — and hands them to this component, which is the only place
// that touches the DOM: it calls lib/runtime/mount.ts and runs the
// postMessage auto-height handshake the embed loader listens for.

import { useEffect, useRef } from "react";
import type { GameSpec, Placement } from "@/lib/engine/types";
import { mount } from "@/lib/runtime/mount";

export function PlayRuntime({
  spec,
  placement,
  slug,
}: {
  spec: GameSpec;
  placement: Placement;
  slug: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const handle = mount(spec, container, placement, { slug });

    // --- postMessage auto-height (build spec §14, §23) ----------------------
    // An iframe never grows to fit its content on its own. The loader
    // (app/embed.js/route.ts) listens for this exact message shape and
    // resizes its iframe accordingly.
    function postHeight() {
      const height = Math.ceil(document.documentElement.scrollHeight);
      try {
        window.parent.postMessage({ type: "playloop:resize", slug, height }, "*");
      } catch {
        // Running standalone (no parent frame) or a hostile embedder —
        // either way, never throw out of this handler.
      }
    }

    postHeight();
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => postHeight());
      observer.observe(document.documentElement);
    }
    window.addEventListener("load", postHeight);

    return () => {
      observer?.disconnect();
      window.removeEventListener("load", postHeight);
      handle.teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.id, placement, slug]);

  return <div ref={containerRef} style={{ width: "100%" }} />;
}
