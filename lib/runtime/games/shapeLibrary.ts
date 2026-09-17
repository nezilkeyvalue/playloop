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

/** A pet food bowl — catch's catcher fallback when the game's theme is
 * pet supplies, in place of the woven basket. Wide flared bowl on a base
 * ring, with a lighter inner well so it reads as something you drop food
 * INTO, which is exactly the verb the template already has. */
export function drawPetBowlShape(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  const rimH = h * 0.26;
  const baseInset = w * 0.22;
  const baseH = h * 0.14;

  withDropShadow(c, () => {
    c.save();
    // Bowl body — a steep trapezoid, much narrower at the base than the
    // basket so the flared "dish" silhouette is unmistakable.
    c.beginPath();
    c.moveTo(x, y + rimH * 0.5);
    c.lineTo(x + w, y + rimH * 0.5);
    c.lineTo(x + w - baseInset, y + h - baseH);
    c.lineTo(x + baseInset, y + h - baseH);
    c.closePath();
    c.fillStyle = color;
    c.fill();

    // Foot ring.
    c.fillStyle = shadeHex(color, -0.18);
    c.fillRect(x + baseInset * 0.8, y + h - baseH, w - baseInset * 1.6, baseH);
    c.restore();
  });

  // Rim, then the inner well sunk into it — drawn after the shadow pass so
  // the well doesn't cast one of its own.
  fillGlossyRoundedRect(c, x - w * 0.02, y, w * 1.04, rimH, rimH / 2, shadeHex(color, 0.14));
  c.save();
  c.fillStyle = shadeHex(color, -0.3);
  c.beginPath();
  c.ellipse(x + w / 2, y + rimH * 0.52, w * 0.4, rimH * 0.3, 0, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

/** A side-on dog silhouette, facing right. Used as static scenery along
 * the bottom of a pet-supplies game — decoration only, never a role asset
 * and never something the player interacts with, so it takes a single flat
 * colour and the caller sets the alpha it wants. `size` is the body's full
 * length nose-to-tail. */
export function drawDogSilhouette(c: CanvasRenderingContext2D, x: number, feetY: number, size: number, color: string): void {
  const bodyW = size * 0.58;
  const bodyH = size * 0.3;
  const bodyCx = x - size * 0.06;
  const bodyCy = feetY - size * 0.36;
  const legH = size * 0.22;
  const legW = size * 0.07;

  c.save();
  c.fillStyle = color;

  // Legs first, so the body reads as in front of them.
  for (const t of [-0.34, -0.16, 0.18, 0.34]) {
    c.fillRect(bodyCx + bodyW * t - legW / 2, feetY - legH, legW, legH);
  }

  // Body.
  c.beginPath();
  c.ellipse(bodyCx, bodyCy, bodyW / 2, bodyH / 2, 0, 0, Math.PI * 2);
  c.fill();

  // Neck + head, up and to the right.
  const headCx = bodyCx + bodyW * 0.46;
  const headCy = bodyCy - size * 0.17;
  c.beginPath();
  c.moveTo(bodyCx + bodyW * 0.2, bodyCy - bodyH * 0.2);
  c.lineTo(headCx - size * 0.05, headCy);
  c.lineTo(headCx + size * 0.05, headCy + size * 0.05);
  c.lineTo(bodyCx + bodyW * 0.3, bodyCy + bodyH * 0.25);
  c.closePath();
  c.fill();

  c.beginPath();
  c.ellipse(headCx, headCy, size * 0.135, size * 0.115, 0, 0, Math.PI * 2);
  c.fill();
  // Muzzle, pushed forward so the silhouette has an unambiguous "facing
  // right" read — without it the head is just a lump and the whole shape
  // lands somewhere between a dog and a sheep.
  c.beginPath();
  c.ellipse(headCx + size * 0.14, headCy + size * 0.03, size * 0.095, size * 0.062, 0, 0, Math.PI * 2);
  c.fill();
  // Ear — a flopped triangle back over the skull.
  c.beginPath();
  c.moveTo(headCx - size * 0.05, headCy - size * 0.1);
  c.lineTo(headCx - size * 0.16, headCy + size * 0.07);
  c.lineTo(headCx - size * 0.01, headCy + size * 0.04);
  c.closePath();
  c.fill();

  // Tail — a short upward flick. A long curl reads as a squirrel at this
  // silhouette size.
  c.strokeStyle = color;
  c.lineWidth = size * 0.06;
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(bodyCx - bodyW * 0.46, bodyCy - bodyH * 0.12);
  c.quadraticCurveTo(bodyCx - bodyW * 0.62, bodyCy - size * 0.12, bodyCx - bodyW * 0.56, bodyCy - size * 0.18);
  c.stroke();
  c.restore();
}

/** A modelled bottle — pour's generated-shape fallback for the `prize` role
 * when a site yields no product image and has no logo either. Given depth
 * the same way the cup in pour.ts is: a horizontal body gradient standing
 * in for a curved surface (dark edges, bright just left of centre), an
 * ellipse at the shoulder and the base, a specular stripe, and visible
 * liquid inside — a flat accent rectangle next to a shaded cup reads as a
 * missing asset rather than a fallback. `liquid` is the colour of what is
 * being poured, so the bottle and the stream agree. */
export function drawBottleShape(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  liquid: string,
): void {
  const cx = x + w / 2;
  const neckW = w * 0.34;
  const neckH = h * 0.2;
  const shoulderY = y + neckH;
  const bodyTop = shoulderY + h * 0.1;
  const baseY = y + h;
  const ry = w * 0.13;

  const bodyPath = () => {
    c.beginPath();
    c.moveTo(cx - neckW / 2, y + h * 0.04);
    // Shoulder — a curve out to the full body width, not a hard step.
    c.quadraticCurveTo(cx - w / 2, shoulderY, cx - w / 2, bodyTop);
    c.lineTo(cx - w / 2, baseY - ry);
    c.ellipse(cx, baseY - ry, w / 2, ry, 0, Math.PI, 0, true);
    c.lineTo(cx + w / 2, bodyTop);
    c.quadraticCurveTo(cx + w / 2, shoulderY, cx + neckW / 2, y + h * 0.04);
    c.closePath();
  };

  c.save();
  bodyPath();
  const shell = c.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
  shell.addColorStop(0, shadeHex(color, -0.26));
  shell.addColorStop(0.32, shadeHex(color, 0.1));
  shell.addColorStop(0.6, color);
  shell.addColorStop(1, shadeHex(color, -0.3));
  c.fillStyle = shell;
  c.fill();

  // Liquid sitting in the lower two thirds, with its own surface ellipse.
  c.save();
  bodyPath();
  c.clip();
  const liquidTop = bodyTop + (baseY - bodyTop) * 0.34;
  c.fillStyle = liquid;
  c.fillRect(cx - w / 2, liquidTop, w, baseY - liquidTop);
  c.beginPath();
  c.ellipse(cx, liquidTop, w / 2, ry * 0.8, 0, 0, Math.PI * 2);
  c.fillStyle = shadeHex(liquid, 0.14);
  c.fill();

  // Specular stripe, same light source as the body gradient.
  const gloss = c.createLinearGradient(cx - w * 0.3, 0, cx - w * 0.08, 0);
  gloss.addColorStop(0, "rgba(255,255,255,0)");
  gloss.addColorStop(0.5, "rgba(255,255,255,0.3)");
  gloss.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = gloss;
  c.fillRect(cx - w * 0.3, y, w * 0.22, h);
  c.restore();

  c.strokeStyle = shadeHex(color, -0.35);
  c.lineWidth = Math.max(1, w * 0.03);
  bodyPath();
  c.stroke();

  // Cap.
  c.fillStyle = shadeHex(color, -0.38);
  c.fillRect(cx - neckW * 0.62, y - h * 0.01, neckW * 1.24, h * 0.07);
  c.restore();
}
