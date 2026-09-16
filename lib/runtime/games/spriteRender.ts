// lib/runtime/games/spriteRender.ts
//
// Shared canvas-rendering helpers for game modules that draw ProcessedAsset
// sprites subject-aware: crop toward SubjectBounds, apply ColorAdjust, fill
// a photographic asset's leftover frame with its own backdrop — see
// lib/engine/types.ts's SubjectBounds/AssetPresentation/
// AssetBackgroundTreatment/ColorAdjust doc comments for the field semantics
// these implement.
//
// containFit/colorAdjustFilterString/createBlurredBackdrop were originally
// duplicated between chainPop.ts and shooter.ts; extracted here so catch.ts
// and guessPrice.ts can reuse the same subject-aware draw instead of a
// third copy-paste, and so both templates share one blurFill implementation.

import type { LoadedAsset } from "@/lib/runtime/gameModule";

const BLUR_BACKDROP_RESOLUTION = 96;
const BLUR_BACKDROP_ZOOM = 1.3;
const BLUR_BACKDROP_RADIUS_PX = 12;

export const CELEBRATION_DURATION_SEC = 0.45;

/** "Contain" fit of a `srcW`x`srcH` rect into a `boxW`x`boxH` box: the
 * largest size that preserves the source's own aspect ratio, centred. A
 * subjectBounds sub-rect is generally not square even though the sprite's
 * own canvas is — see lib/engine/types.ts's SubjectBounds doc comment. */
export function containFit(
  srcW: number,
  srcH: number,
  boxW: number,
  boxH: number,
): { w: number; h: number; x: number; y: number } {
  if (srcW <= 0 || srcH <= 0) return { w: boxW, h: boxH, x: 0, y: 0 };
  const srcAspect = srcW / srcH;
  const boxAspect = boxW / boxH;
  const w = srcAspect > boxAspect ? boxW : boxH * srcAspect;
  const h = srcAspect > boxAspect ? boxW / srcAspect : boxH;
  return { w, h, x: (boxW - w) / 2, y: (boxH - h) / 2 };
}

/** `ColorAdjust` → a canvas `ctx.filter` string; "none" when absent or
 * numerically neutral — see lib/engine/types.ts's ColorAdjust doc comment. */
export function colorAdjustFilterString(adjust: LoadedAsset["colorAdjust"]): string {
  if (!adjust) return "none";
  const { brightness, contrast, saturation } = adjust;
  if (brightness === 1 && contrast === 1 && saturation === 1) return "none";
  return `brightness(${brightness}) contrast(${contrast}) saturate(${saturation})`;
}

/** Source sub-rect (in the sprite's own natural pixel space) for `asset`'s
 * SubjectBounds — the whole image when bounds are absent, per the field's
 * documented "absent means whole frame is subject" default. */
export function subjectSourceRect(asset: LoadedAsset): { sx: number; sy: number; sw: number; sh: number } {
  const img = asset.image;
  const naturalWidth = img?.naturalWidth ?? 0;
  const naturalHeight = img?.naturalHeight ?? 0;
  const bounds = asset.subjectBounds;
  return {
    sx: bounds ? bounds.x * naturalWidth : 0,
    sy: bounds ? bounds.y * naturalHeight : 0,
    sw: bounds ? bounds.width * naturalWidth : naturalWidth,
    sh: bounds ? bounds.height * naturalHeight : naturalHeight,
  };
}

/** Draws `asset`'s image cropped to its SubjectBounds and contain-fit into
 * the `boxW`x`boxH` box at (`dx`,`dy`) — never stretches, never crops into
 * the real subject (see lib/engine/types.ts's SubjectBounds doc comment for
 * why: cropping toward a known boundary only ever removes safe padding).
 * Applies ColorAdjust as a canvas filter. No-ops when the image never
 * loaded. Does not draw any background/backdrop behind the image — callers
 * that need one (a photographic asset's sampled backgroundColor, or a
 * blurFill backdrop) draw it themselves first, same as chainPop.ts/
 * shooter.ts already do for their own chip/tile framing. */
export function drawAssetContain(
  c: CanvasRenderingContext2D,
  asset: LoadedAsset,
  dx: number,
  dy: number,
  boxW: number,
  boxH: number,
): void {
  const img = asset.image;
  if (!img) return;
  const { sx, sy, sw, sh } = subjectSourceRect(asset);
  const fit = containFit(sw, sh, boxW, boxH);
  c.filter = colorAdjustFilterString(asset.colorAdjust);
  c.drawImage(img, sx, sy, sw, sh, dx + fit.x, dy + fit.y, fit.w, fit.h);
  c.filter = "none";
}

/** Pre-renders a blurred, zoomed-in copy of `image` onto a small offscreen
 * canvas — meant to be called once per distinct asset (e.g. at game
 * init/round-build), not per frame: applying a CSS blur filter live for
 * every draw call every frame would be needless per-frame cost for a result
 * that never changes. Returns null in non-DOM environments (SSR) or if 2D
 * context creation fails — callers already treat a null backdrop as "no
 * blur decoration," never a hard failure. */
export function createBlurredBackdrop(
  image: HTMLImageElement,
  colorAdjust: LoadedAsset["colorAdjust"],
): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = BLUR_BACKDROP_RESOLUTION;
  canvas.height = BLUR_BACKDROP_RESOLUTION;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const adjust = colorAdjustFilterString(colorAdjust);
  ctx.filter = adjust === "none" ? `blur(${BLUR_BACKDROP_RADIUS_PX}px)` : `blur(${BLUR_BACKDROP_RADIUS_PX}px) ${adjust}`;
  const d = BLUR_BACKDROP_RESOLUTION * BLUR_BACKDROP_ZOOM;
  const offset = (BLUR_BACKDROP_RESOLUTION - d) / 2;
  ctx.drawImage(image, offset, offset, d, d);
  return canvas;
}

/** Draws `text` centred along the TOP of a circular arc around (`cx`,
 * `cy`), letters upright and reading left-to-right — e.g. a product name
 * curving above shooter.ts's intro-reveal chip. Canvas has no curved-text
 * primitive; this is the standard manual technique: rotate the whole
 * coordinate system before each glyph, then draw at a fixed radius offset
 * straight "up" (0 rotation) — the rotation applied *before* the draw is
 * what keeps each glyph upright and tangent to the arc automatically,
 * without separate per-glyph orientation math. Only a top arc is
 * implemented (not a mirrored bottom arc) — a single name string never
 * needed the extra complexity/risk of a bottom-mirrored variant. No-ops on
 * an empty string. */
export function drawArcText(
  c: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  radius: number,
  font: string,
  color: string,
): void {
  if (!text) return;
  c.save();
  c.font = font;
  c.fillStyle = color;
  c.textAlign = "center";
  c.textBaseline = "middle";

  const chars = Array.from(text);
  const charAngles = chars.map((ch) => c.measureText(ch).width / radius);
  const totalAngle = charAngles.reduce((sum, a) => sum + a, 0);

  c.translate(cx, cy);
  c.rotate(-totalAngle / 2);
  for (let i = 0; i < chars.length; i++) {
    const half = charAngles[i]! / 2;
    c.rotate(half);
    c.save();
    c.translate(0, -radius);
    c.fillText(chars[i]!, 0, 0);
    c.restore();
    c.rotate(half);
  }
  c.restore();
}

// ---------------------------------------------------------------------------
// Celebrate primitive — a brief, non-blocking "look at this" beat drawn when
// the player successfully interacts with a real product asset (a catch, a
// popped chain, a hit) instead of it just vanishing. Deliberately NOT a
// screen-space tween to a fixed location: it grows/fades in place, which is
// simpler, lower-risk, and still reads clearly as a moment of focus.
// ---------------------------------------------------------------------------

export interface Celebration {
  asset: LoadedAsset;
  x: number;
  y: number;
  t: number; // seconds since triggered; remove once >= CELEBRATION_DURATION_SEC
}

/** Ages every celebration by `dt` and drops the ones that have finished.
 * Returns a new array (callers reassign, e.g. `this.celebrations =
 * updateCelebrations(this.celebrations, dt)`). */
export function updateCelebrations(list: Celebration[], dt: number): Celebration[] {
  const next: Celebration[] = [];
  for (const cel of list) {
    const t = cel.t + dt;
    if (t < CELEBRATION_DURATION_SEC) next.push({ ...cel, t });
  }
  return next;
}

/** Draws one celebration: the asset's image grows from `baseSize` to about
 * 1.6x and fades out, with a soft brand-accent glow behind it. Draw these
 * last in `render()`, after the normal scene, so they sit on top as the
 * clear focal point. */
export function drawCelebration(
  c: CanvasRenderingContext2D,
  celebration: Celebration,
  baseSize: number,
  brandAccent: string,
): void {
  const progress = Math.min(1, Math.max(0, celebration.t / CELEBRATION_DURATION_SEC));
  const scale = 1 + 0.6 * Math.sin(progress * Math.PI); // grows then settles back down
  const alpha = 1 - progress;
  const size = baseSize * scale;

  c.save();
  c.globalAlpha = alpha * 0.5;
  c.fillStyle = brandAccent;
  c.beginPath();
  c.arc(celebration.x, celebration.y, size * 0.62, 0, Math.PI * 2);
  c.fill();
  c.globalAlpha = alpha;
  drawAssetContain(c, celebration.asset, celebration.x - size / 2, celebration.y - size / 2, size, size);
  c.restore();
}
