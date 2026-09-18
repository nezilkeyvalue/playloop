"use client";

// app/play/[slug]/PlayRuntime.tsx
//
// Client half of the hosted runtime page. page.tsx (a Server Component)
// resolves a plain, serializable GameSpec + Placement — from a fixture or
// from the DB — and hands them to this component, which is the only place
// that touches the DOM: it calls lib/runtime/mount.ts and runs the
// postMessage auto-height handshake the embed loader listens for.

import { useEffect, useRef, type CSSProperties } from "react";
import type { GameSpec, Placement } from "@/lib/engine/types";
import { mount } from "@/lib/runtime/mount";
import { RUNNER_THEME_PRESETS } from "@/lib/runtime/games/runnerTheme";
import type { StageSizeOverride } from "@/lib/runtime/stage";

export function PlayRuntime({
  spec,
  placement,
  slug,
  viewportHeight,
  sizeOverride,
  themePreset,
}: {
  spec: GameSpec;
  placement: Placement;
  slug: string;
  /** The visitor's real browser viewport height in px, forwarded by
   * embed.js's "fullpage" mounting (only it can measure this — see that
   * file's comment). Undefined for every other placement, and for a direct
   * (non-embedded) visit to this page, where "100vh" is already correct
   * because there's no iframe boundary in the way. */
  viewportHeight?: number;
  /** A merchant's custom width/height (embed/page.tsx's Size section),
   * resolved from ?width=/?height= by page.tsx. Passed straight through to
   * mount() for the canvas's own sizing (see stage.ts's StageSizeOverride),
   * and used again below to cap/centre the OUTER wrapper the same way — the
   * canvas alone respecting maxWidth would otherwise just float in the
   * top-left corner of an iframe that stayed full width. */
  sizeOverride?: StageSizeOverride;
  /** A named brand skin requested by the host with ?theme= — looked up in
   * the runtime's preset registry here, so an unknown or hostile value is
   * simply ignored and the game renders the theme it derives from its own
   * BrandKit. */
  themePreset?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const brandTheme = themePreset ? RUNNER_THEME_PRESETS[themePreset] : undefined;
    const handle = mount(spec, container, placement, { slug, sizeOverride, brandTheme });

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
  }, [spec.id, placement, slug, sizeOverride?.maxWidth, sizeOverride?.height, themePreset]);

  // "fullpage" is meant to read as a real full-page moment, not just a
  // taller section: mount.ts sizes the shell tight to the canvas (stage.ts's
  // computed height, never taller), so without this the game would just sit
  // at the top of whatever height the host page's iframe happens to be —
  // centering it inside a min-height:100vh, brand-coloured backdrop is what
  // actually makes document.documentElement.scrollHeight (and therefore the
  // postMessage handshake embed.js listens for) report a full-viewport
  // height, which is what makes the iframe itself grow to match.
  //
  // maxWidth is applied here too, on the WRAPPER, not just handed to
  // mount() for the canvas — mount.ts's canvas is capped/centred inside its
  // shell, but the shell itself stays 100% of whatever this wrapper is, so
  // without this a capped canvas would just float in the top-left corner of
  // an iframe that stayed full width instead of visibly matching the box
  // size the merchant configured.
  const capWidth = sizeOverride?.maxWidth;
  const wrapperStyle: CSSProperties =
    placement === "fullpage"
      ? {
          width: "100%",
          minHeight: viewportHeight ? `${viewportHeight}px` : "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: spec.brand.background,
        }
      : {
          width: "100%",
          maxWidth: capWidth ? `${capWidth}px` : undefined,
          marginLeft: capWidth ? "auto" : undefined,
          marginRight: capWidth ? "auto" : undefined,
        };

  return (
    <div style={wrapperStyle}>
      <div ref={containerRef} style={{ width: "100%", maxWidth: capWidth ? `${capWidth}px` : undefined }} />
    </div>
  );
}
