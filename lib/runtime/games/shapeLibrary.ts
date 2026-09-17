// lib/runtime/games/shapeLibrary.ts
//
// Hand-drawn vector icons for generated-shape fallbacks — the shapes a game
// module draws in place of a real product asset when a role's pool is empty
// (catch's collectible/hazard/basket, sweet_spot's prize medallion,
// shooter's target/decoy). Every one of these used to be a flat filled
// circle or rounded-rect (see CLAUDE.md's aesthetics notes) even though a
// site with few or zero usable product photos hits this fallback path
// constantly — these are the shapes most players actually see. Built on
// spriteRender.ts's fillGlossyCircle/fillGlossyRoundedRect/withDropShadow
// so they share the same "designed" surface treatment as everything else.

import { fillGlossyCircle, fillGlossyRoundedRect, shadeHex, withDropShadow } from "@/lib/runtime/games/spriteRender";

/** A faceted gem — catch's collectible fallback, chainPop's synthesized
 * kind. Reads as "a thing worth collecting" regardless of brand colour. */
export function drawGemShape(c: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string): void {
  const half = size / 2;
  withDropShadow(c, () => {
    c.save();
    c.beginPath();
    c.moveTo(cx, cy - half);
    c.lineTo(cx + half * 0.85, cy - half * 0.28);
    c.lineTo(cx + half * 0.55, cy + half);
    c.lineTo(cx - half * 0.55, cy + half);
    c.lineTo(cx - half * 0.85, cy - half * 0.28);
    c.closePath();
    c.fillStyle = color;
    c.fill();

    // Facet lines — a couple of straight internal strokes read as cut
    // facets rather than a plain pentagon.
    c.strokeStyle = shadeHex(color, -0.15);
    c.lineWidth = Math.max(1, size * 0.03);
    c.beginPath();
    c.moveTo(cx, cy - half);
    c.lineTo(cx, cy + half);
    c.moveTo(cx - half * 0.85, cy - half * 0.28);
    c.lineTo(cx + half * 0.85, cy - half * 0.28);
    c.stroke();

    // Top-facet highlight.
    c.fillStyle = "rgba(255,255,255,0.45)";
    c.beginPath();
    c.moveTo(cx, cy - half);
    c.lineTo(cx + half * 0.85, cy - half * 0.28);
    c.lineTo(cx, cy - half * 0.28);
    c.closePath();
    c.fill();
    c.restore();
  });
}

/** A jagged "hazard" burst — catch's hazard fallback. Deliberately spiky
 * and asymmetric rather than a rounded shape, so it reads as "avoid this"
 * at a glance, matching the danger it represents. */
export function drawHazardShape(c: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string): void {
  const half = size / 2;
  const spikes = 7;
  withDropShadow(c, () => {
    c.save();
    c.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const r = i % 2 === 0 ? half : half * 0.6;
      const angle = (Math.PI / spikes) * i - Math.PI / 2;
      const px = cx + Math.cos(angle) * r;
      const py = cy + Math.sin(angle) * r;
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.closePath();
    c.fillStyle = color;
    c.fill();

    c.strokeStyle = shadeHex(color, -0.2);
    c.lineWidth = Math.max(1, size * 0.03);
    c.stroke();

    // A simple "!" mark — the universal warning glyph, so the shape reads
    // as "hazard" even to a player who never learned the spiky-outline
    // convention from other games. A plain rect stem (not a rounded one —
    // this codebase draws rounded rects via a manual arcTo helper per game
    // module, not the newer native `roundRect`, for broader canvas/browser
    // compatibility on arbitrary third-party host pages) reads fine at
    // this size.
    c.fillStyle = "rgba(255,255,255,0.85)";
    c.fillRect(cx - size * 0.045, cy - half * 0.42, size * 0.09, half * 0.6);
    c.beginPath();
    c.arc(cx, cy + half * 0.32, size * 0.05, 0, Math.PI * 2);
    c.fill();
    c.restore();
  });
}

/** A woven basket silhouette — catch's catcher fallback, in place of a
 * plain rounded-rect. Trapezoid body, a rim, and a couple of weave lines
 * for texture, since this sits on screen for the whole run. */
export function drawBasketShape(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  const rimH = h * 0.22;
  const baseInset = w * 0.12;

  withDropShadow(c, () => {
    c.save();
    // Body — a trapezoid, narrower at the base, like a real woven basket.
    c.beginPath();
    c.moveTo(x, y + rimH);
    c.lineTo(x + w, y + rimH);
    c.lineTo(x + w - baseInset, y + h);
    c.lineTo(x + baseInset, y + h);
    c.closePath();
    c.fillStyle = color;
    c.fill();

    // Weave texture — a few horizontal lines, alpha-lightened.
    c.strokeStyle = "rgba(255,255,255,0.28)";
    c.lineWidth = Math.max(1, h * 0.035);
    const weaveRows = 3;
    for (let i = 1; i <= weaveRows; i++) {
      const t = i / (weaveRows + 1);
      const rowY = y + rimH + (h - rimH) * t;
      const inset = baseInset * t;
      c.beginPath();
      c.moveTo(x + inset, rowY);
      c.lineTo(x + w - inset, rowY);
      c.stroke();
    }

    // Rim — a rounded bar along the top, glossy so it reads as the basket's
    // "front", not a random cap.
    c.restore();
  });

  fillGlossyRoundedRect(c, x - w * 0.03, y, w * 1.06, rimH, rimH / 2, shadeHex(color, 0.12));
}

/** A badge/medallion ring — sweet_spot's prize fallback, in place of a
 * plain small dot. Reads as "prize" via the ring-and-star framing rather
 * than an unstyled circle. */
export function drawMedallionShape(c: CanvasRenderingContext2D, cx: number, cy: number, radius: number, color: string): void {
  withDropShadow(
    c,
    () => {
      fillGlossyCircle(c, cx, cy, radius, color);

      c.save();
      c.strokeStyle = "rgba(255,255,255,0.55)";
      c.lineWidth = Math.max(1.5, radius * 0.09);
      c.beginPath();
      c.arc(cx, cy, radius * 0.72, 0, Math.PI * 2);
      c.stroke();
      c.restore();

      drawStarShape(c, cx, cy, radius * 0.42, "rgba(255,255,255,0.9)");
    },
    { blur: 10, offsetY: 4 },
  );
}

/** A cartoon mole critter — whack's generated-shape fallback for the
 * `mole` role, in place of a flat circle. Drawn front-on emerging from a
 * hole: a rounded body, two small ears, a lighter snout, and closed
 * "squint" eyes (a mole popping up mid-blink reads more alive than one
 * with dot eyes staring blankly). `size` is the body's full width. */
export function drawMoleCreatureShape(c: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string): void {
  const half = size / 2;

  withDropShadow(c, () => {
    // Ears — drawn first so the body overlaps their base, reading as
    // "behind" the head.
    c.fillStyle = shadeHex(color, -0.12);
    c.beginPath();
    c.ellipse(cx - half * 0.55, cy - half * 0.62, half * 0.22, half * 0.26, -0.3, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.ellipse(cx + half * 0.55, cy - half * 0.62, half * 0.22, half * 0.26, 0.3, 0, Math.PI * 2);
    c.fill();

    // Body.
    fillGlossyCircle(c, cx, cy + half * 0.08, half * 0.92, color);

    // Snout — a lighter oval low on the face.
    c.fillStyle = shadeHex(color, 0.32);
    c.beginPath();
    c.ellipse(cx, cy + half * 0.42, half * 0.34, half * 0.22, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = shadeHex(color, -0.35);
    c.beginPath();
    c.ellipse(cx, cy + half * 0.4, half * 0.06, half * 0.045, 0, 0, Math.PI * 2);
    c.fill();

    // Closed, squinting eyes — two short upward-curved strokes.
    c.strokeStyle = shadeHex(color, -0.45);
    c.lineWidth = Math.max(1.5, size * 0.035);
    c.lineCap = "round";
    c.beginPath();
    c.arc(cx - half * 0.32, cy - half * 0.02, half * 0.16, Math.PI * 1.15, Math.PI * 1.85);
    c.stroke();
    c.beginPath();
    c.arc(cx + half * 0.32, cy - half * 0.02, half * 0.16, Math.PI * 1.15, Math.PI * 1.85);
    c.stroke();
  });
}

/** A five-point star — shooter's "this is the target" identity shape,
 * shared here so it's drawn once instead of duplicated per template that
 * wants the same "the special one" signal (also used by drawMedallionShape
 * above). */
export function drawStarShape(c: CanvasRenderingContext2D, cx: number, cy: number, radius: number, color: string): void {
  const spikes = 5;
  const inner = radius * 0.5;
  c.save();
  c.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? radius : inner;
    const angle = (Math.PI / spikes) * i - Math.PI / 2;
    const px = cx + Math.cos(angle) * r;
    const py = cy + Math.sin(angle) * r;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.closePath();
  c.fillStyle = color;
  c.fill();
  c.restore();
}
