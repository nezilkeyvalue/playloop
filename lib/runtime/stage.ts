// lib/runtime/stage.ts
//
// Canvas sizing, devicePixelRatio correction, and fit-to-container logic
// per Placement, reading minWidth/minHeight/preferredAspect (or fixed ad
// `sizes`) off the capability (build spec §13 "Placement fitting",
// capability schema §2 `placements`).

import type { Placement, PlacementConstraint } from "@/lib/engine/types";

export interface StageSize {
  /** CSS pixels — what you set canvas.style.width/height to. */
  width: number;
  height: number;
  dpr: number;
}

/**
 * A merchant-configured size for THIS embed, layered on top of (never
 * instead of) the template's own capability constraints — maxWidth still
 * can't shrink narrower than the placement's minWidth, and height still
 * can't shrink shorter than its minHeight. Distinct from `PlacementConstraint`
 * (which is per-template, capability-JSON data) because this is per-embed,
 * merchant-chosen data threaded in from outside the engine (see
 * lib/engine/embedSnippet.ts's data-width/data-height and
 * app/play/[slug]/page.tsx's ?width=/?height=).
 *
 * `height` here is a literal target, not something computeStageSize reads
 * back from the container — it comes from a value the merchant set once,
 * not from this function's own prior output, so it doesn't create the
 * feedback loop the comment below warns about for container-height reads.
 */
export interface StageSizeOverride {
  maxWidth?: number;
  height?: number;
}

const DEFAULT_MIN_WIDTH = 300;
const DEFAULT_ASPECT = 0.75; // height = width * aspect, matches "section" defaults

/**
 * Works out the logical (CSS-pixel) stage size for `container`, honoring
 * the placement's declared constraints. Ad placements are fixed-size by
 * definition (build spec §13: "Ad sizes are fixed-dimension and are a
 * separate concern from responsive layout — do not build one clever system
 * for both") so they short-circuit to the first non-excluded size.
 */
export function computeStageSize(
  container: HTMLElement,
  placement: Placement,
  constraint: PlacementConstraint | undefined,
  override?: StageSizeOverride,
): StageSize {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const rect = container.getBoundingClientRect();

  if (placement === "ad") {
    const sizes = constraint?.sizes ?? [];
    const excluded = new Set(constraint?.excluded ?? []);
    const usable = sizes.filter((s) => !excluded.has(s));
    const chosen = usable[0] ?? "300x250";
    const [w, h] = chosen.split("x").map((n) => parseInt(n, 10));
    return { width: w || 300, height: h || 250, dpr };
  }

  const minWidth = constraint?.minWidth ?? DEFAULT_MIN_WIDTH;
  const minHeight = constraint?.minHeight ?? Math.round(minWidth * DEFAULT_ASPECT);
  const aspect = constraint?.preferredAspect ?? DEFAULT_ASPECT;

  let width = Math.max(Math.round(rect.width) || minWidth, minWidth);
  if (override?.maxWidth) {
    // The cap can never win against the template's own floor — a merchant
    // asking for a box narrower than the game can function in still gets
    // the smallest usable size instead of a broken layout.
    width = Math.max(Math.min(width, Math.round(override.maxWidth)), minWidth);
  }

  // Height is always derived from width * preferredAspect, never read back
  // from the container's own box — UNLESS a merchant supplied an explicit
  // override.height, which is a value chosen once outside this function,
  // not this function's own prior output, so it carries none of the
  // feedback-loop risk the aspect-derivation comment below warns about.
  // section/fullpage/modal slots are fluid-width by design (build spec §1
  // "Placements" — a section is "full width, ~500-700px tall", not a fixed
  // box) and mount.ts writes this computed height onto a wrapper *inside*
  // the container, so reading the container's height here would just be
  // reading our own last output back — a feedback loop that freezes height
  // across later width changes (e.g. a phone rotation). Ad placements never
  // reach this branch.
  const height = override?.height
    ? Math.max(Math.round(override.height), minHeight)
    : Math.max(Math.round(width * aspect), minHeight);

  return { width, height, dpr };
}

/**
 * Applies a StageSize to a canvas with devicePixelRatio correction: the
 * backing store is `width*dpr` x `height*dpr`, the CSS box stays
 * `width`x`height`, and the returned context is pre-scaled so all drawing
 * code can work in CSS-pixel (logical) coordinates.
 */
export function applyStageSize(canvas: HTMLCanvasElement, size: StageSize): CanvasRenderingContext2D {
  const backingWidth = Math.max(1, Math.round(size.width * size.dpr));
  const backingHeight = Math.max(1, Math.round(size.height * size.dpr));

  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;
  canvas.style.width = `${size.width}px`;
  canvas.style.height = `${size.height}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("stage.ts: 2D canvas context unavailable");
  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  return ctx;
}

export interface StageController {
  ctx: CanvasRenderingContext2D;
  size: StageSize;
  destroy(): void;
}

/**
 * Sizes `canvas` to fit `container` under `placement`, and keeps it sized
 * as the container resizes (e.g. the host page's responsive layout, or a
 * mobile orientation change) via ResizeObserver.
 */
export function mountStage(
  canvas: HTMLCanvasElement,
  container: HTMLElement,
  placement: Placement,
  constraint: PlacementConstraint | undefined,
  onResize?: (size: StageSize) => void,
  override?: StageSizeOverride,
): StageController {
  let size = computeStageSize(container, placement, constraint, override);
  let ctx = applyStageSize(canvas, size);

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined" && placement !== "ad") {
    observer = new ResizeObserver(() => {
      const next = computeStageSize(container, placement, constraint, override);
      if (next.width === size.width && next.height === size.height && next.dpr === size.dpr) return;
      size = next;
      ctx = applyStageSize(canvas, size);
      onResize?.(size);
    });
    observer.observe(container);
  }

  return {
    get ctx() {
      return ctx;
    },
    get size() {
      return size;
    },
    destroy() {
      observer?.disconnect();
    },
  } as StageController;
}
