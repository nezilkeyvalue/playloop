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

/** True when `imageSrc` is exactly the brand's own logo. A role can end up
 * filling with the brand logo as its declared `fallback` (e.g.
 * sweet_spot.json's `prize` role, which — unlike catch's `collectible` or
 * guess_price's `hero` — declares no `subjectTypeIn` restriction at all) —
 * the logo is brand identity, not a product, so it must never be treated as
 * one a player "engaged with" (celebrated, recorded for the reward
 * screen's recap gallery). Same category as the existing "never for
 * hazards/decoys/generated-shape fallbacks" rule, just for this one
 * specific fallback kind. */
export function isBrandLogoUrl(imageSrc: string | null | undefined, logoUrl: string | undefined): boolean {
  return Boolean(logoUrl && imageSrc && imageSrc === logoUrl);
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

// ---------------------------------------------------------------------------
// Shared visual-polish primitives — a soft drop shadow, a "glossy" fill for
// generated-shape fallbacks, and a richer procedural background. Every game
// module's flattest visuals (a plain circle/rect fallback, a plain 2-stop
// gradient backdrop) were independently reinventing a weaker version of
// what chainPop.ts's generated-gem tiles already proved reads well
// (lib/runtime/games/chainPop.ts's drawCell) — pulled out here so catch,
// guess_price, sweet_spot, and shooter can all pick up the same "designed",
// not "placeholder", look with one shared call each.
// ---------------------------------------------------------------------------

function roundedRectPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + radius, y);
  c.arcTo(x + w, y, x + w, y + h, radius);
  c.arcTo(x + w, y + h, x, y + h, radius);
  c.arcTo(x, y + h, x, y, radius);
  c.arcTo(x, y, x + w, y, radius);
  c.closePath();
}

/** Lightens (positive `amt`) or darkens (negative) a `#rrggbb` colour. Falls
 * back to the input unchanged for anything else (a `rgba(...)` string, a
 * malformed hex) so a caller passing through an already-resolved colour
 * degrades instead of throwing. */
export function shadeHex(hex: string, amt: number): string {
  const clean = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(clean)) return hex;
  const num = parseInt(clean, 16);
  const adjust = (channel: number) => Math.min(255, Math.max(0, Math.round(channel + 255 * amt)));
  const r = adjust((num >> 16) & 0xff);
  const g = adjust((num >> 8) & 0xff);
  const b = adjust(num & 0xff);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Runs `draw()` with a soft blurred drop shadow active — canvas's native
 * `shadow*` properties, so the shadow traces whatever silhouette `draw()`
 * actually paints (a sprite's real alpha edge, a rounded-rect, a hand-drawn
 * icon) rather than a separate approximate blob primitive. Always restores
 * shadow state afterward, including when `draw` itself calls `c.save()`/
 * `restore()` internally (e.g. `drawAssetContain`). This is the one thing
 * that was making every falling item/basket/hero/medallion look pasted flat
 * onto its background instead of sitting above it. */
export function withDropShadow(
  c: CanvasRenderingContext2D,
  draw: () => void,
  opts: { color?: string; blur?: number; offsetY?: number } = {},
): void {
  c.save();
  c.shadowColor = opts.color ?? "rgba(15, 15, 20, 0.32)";
  c.shadowBlur = opts.blur ?? 14;
  c.shadowOffsetY = opts.offsetY ?? 6;
  draw();
  c.restore();
}

/** Paints the current fill (already applied by the caller) plus a soft
 * white radial highlight anchored in the shape's upper-left quadrant and a
 * thin darker stroke ring — the "glossy gem" read. Shared by
 * fillGlossyRoundedRect/fillGlossyCircle below; not exported on its own
 * since it needs the shape's path already set on `c`. */
function paintGloss(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  const grad = c.createRadialGradient(
    x + w * 0.32,
    y + h * 0.28,
    1,
    x + w * 0.32,
    y + h * 0.28,
    Math.max(w, h) * 0.7,
  );
  grad.addColorStop(0, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = grad;
  c.fill();

  c.lineWidth = Math.max(1.5, Math.min(w, h) * 0.045);
  c.strokeStyle = shadeHex(color, -0.1);
  c.stroke();
}

/** Fills a rounded-rect at (`x`,`y`,`w`,`h`,`r`) with a glossy "gem"
 * treatment — solid base colour, soft top-left highlight, thin stroke ring —
 * instead of a flat single-colour fill. Use for any generated-shape
 * fallback that reads as a tile/chip/rect (catch's hazard chip, guess
 * price's knob backdrop) whenever there's no real product asset to draw. */
export function fillGlossyRoundedRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  color: string,
): void {
  c.save();
  roundedRectPath(c, x, y, w, h, r);
  c.fillStyle = color;
  c.fill();
  roundedRectPath(c, x, y, w, h, r);
  paintGloss(c, x, y, w, h, color);
  c.restore();
}

/** Circle counterpart of fillGlossyRoundedRect — for any generated-shape
 * fallback that reads as a ball/medallion/gem (catch's collectible,
 * sweet_spot's prize medallion, shooter's decoy dot). */
export function fillGlossyCircle(c: CanvasRenderingContext2D, cx: number, cy: number, radius: number, color: string): void {
  c.save();
  c.beginPath();
  c.arc(cx, cy, radius, 0, Math.PI * 2);
  c.fillStyle = color;
  c.fill();
  c.beginPath();
  c.arc(cx, cy, radius, 0, Math.PI * 2);
  paintGloss(c, cx - radius, cy - radius, radius * 2, radius * 2, color);
  c.restore();
}

/** A richer procedural stage background than a barely-visible 2-stop shade:
 * a diagonal 3-stop gradient plus a soft brand-accent glow anchored toward
 * one corner — the same "nebula" idea shooter.ts's starfield already proves
 * reads well, toned down here for a light/branded background instead of a
 * fixed dark palette. Used by every template's stageBackground fallback
 * (no real background asset filled that role) in place of the near-
 * identical flat gradient each one used to hand-roll independently. */
export function drawBrandBackground(
  c: CanvasRenderingContext2D,
  w: number,
  h: number,
  backgroundHex: string,
  accentHex: string,
): void {
  const gradient = c.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, shadeHex(backgroundHex, 0.02));
  gradient.addColorStop(0.55, backgroundHex);
  gradient.addColorStop(1, shadeHex(backgroundHex, -0.08));
  c.fillStyle = gradient;
  c.fillRect(0, 0, w, h);

  c.save();
  const glowRadius = Math.max(w, h) * 0.65;
  const glow = c.createRadialGradient(w * 0.85, h * 0.08, 0, w * 0.85, h * 0.08, glowRadius);
  glow.addColorStop(0, `${accentHex}26`);
  glow.addColorStop(1, `${accentHex}00`);
  c.fillStyle = glow;
  c.fillRect(0, 0, w, h);
  c.restore();
}
