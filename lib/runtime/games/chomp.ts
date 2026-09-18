// lib/runtime/games/chomp.ts
//
// Chomp: a Pac-Man-style chaser roams a brand board eating product pellets
// before each one's own clock runs out. No enemies/lose-condition beyond the
// overall round timer — the per-pellet countdown supplies the challenge
// instead (see lib/capabilities/chomp.json).
//
// The board is a CORRIDOR LATTICE, not a maze: corridors are drawn between
// a grid of nodes and pellets only ever sit on a node, but the chaser still
// moves freely in 2D with no wall collision. That is deliberate — real maze
// walls need grid-snapped movement and corridor pathing, and on a 300x250 ad
// slot they routinely make pellets unreachable. The lattice buys the "this is
// a designed board" read for none of that risk, and it replaced the old
// random-placement-with-rejection-retries scatter, so it is also less code.
//
// Tuning knobs honored (all read from ctx.tuning, already clamped to the
// capability's ranges by mount.ts):
//   pelletCount        — how many pellets are on screen at once, capped by
//                        how many lattice nodes the stage can actually fit
//   moveSpeed          — px/sec the chaser moves at (keyboard) / pointer-follow
//   pelletLifetimeSec  — how long an uneaten pellet survives before it
//                        vanishes and respawns elsewhere (no penalty)
//   durationSec        — total run time
//
// Roles honored:
//   pellet          — required (fallback "none"); the products the player
//                     eats by overlapping them
//   chaser          — optional; draws the sprite if a real asset filled the
//                     role, else a classic wedge-mouth circle in
//                     brand.accent ("generatedShape" fallback)
//   stageBackground — optional; brand gradient if unfilled

import type { GameModule, RuntimeContext, LoadedAsset } from "@/lib/runtime/gameModule";
import {
  drawAssetContain,
  updateCelebrations,
  drawCelebration,
  type Celebration,
} from "@/lib/runtime/games/spriteRender";

// Scoring constants. Chosen so maxRealisticScore() at the capability's
// *default* tuning (durationSec 40) lands at chomp.json's scoring.maxRealistic
// (1260):
//   realisticEatsPerSec = 0.9  (bounded by moveSpeed + pelletLifetimeSec —
//                                a competent player can't out-travel the
//                                board fast enough to sustain much more)
//   maxRealisticScore = durationSec * realisticEatsPerSec * POINTS_PER_PELLET
//                      = 40 * 0.9 * 35 ≈ 1260
const POINTS_PER_PELLET = 35;
const REALISTIC_EATS_PER_SEC = 0.9;

const CHASER_SIZE = 64;
const PELLET_SIZE = 52;
const FADE_WINDOW_SEC = 1; // pellets shrink/fade in their last second of life
const PLACEMENT_MARGIN = 40; // keep lattice nodes off the very edge of the stage

// Board dressing.
const NODE_SPACING_TARGET = PELLET_SIZE * 1.45;
const MIN_NODES_PER_AXIS = 2;
const MAX_NODES_PER_AXIS = 9;
// Narrow enough that the gaps between corridors stay visible. At ~0.85 of
// the pellet size the horizontal and vertical runs overlap into a solid
// wash and the board reads as a checkerboard rather than as corridors.
const CORRIDOR_WIDTH = PELLET_SIZE * 0.5;
const FRAME_INSET = 8;

// The banner is a fixed strip at the top of the stage: the brand logo plus
// whatever the player last ate. Nothing is drawn under it and the chaser is
// clamped out of it, so it never covers play.
const BANNER_MIN_HEIGHT = 34;
const BANNER_MAX_HEIGHT = 54;
const BANNER_HEIGHT_FRACTION = 0.11;

interface Pellet {
  x: number;
  y: number;
  asset: LoadedAsset | null; // null → draw a generated dot
  age: number;
  /** Index into `nodes`, so the slot can be released when the pellet goes. */
  node: number;
}

interface Node {
  x: number;
  y: number;
}

export function maxRealisticScore(tuning: Record<string, number>): number {
  const durationSec = tuning.durationSec ?? 40;
  return Math.round(durationSec * REALISTIC_EATS_PER_SEC * POINTS_PER_PELLET);
}

class ChompGame implements GameModule {
  id: "chomp" = "chomp";

  private ctx!: RuntimeContext;
  private pellets: Pellet[] = [];
  private pelletAssets: LoadedAsset[] = [];
  private chaserAsset: LoadedAsset | null = null;
  private celebrations: Celebration[] = [];
  private chaserX = 0;
  private chaserY = 0;
  private facingAngle = 0; // radians; drives the generated mouth wedge
  private mouthClock = 0;
  private elapsed = 0;
  private ended = false;

  /** The lattice, plus the stage it was built for. mount.ts resizes the
   * stage live (ResizeObserver), so this is rebuilt whenever the stage
   * changes rather than computed once in init() and left to go stale. */
  private nodes: Node[] = [];
  private nodeCols = 0;
  private nodeRows = 0;
  private occupied: boolean[] = [];
  private latticeFor = { width: 0, height: 0 };

  /** The last product actually eaten — what the banner shows. */
  private lastEaten: LoadedAsset | null = null;

  init(ctx: RuntimeContext): void {
    this.ctx = ctx;
    this.elapsed = 0;
    this.ended = false;
    this.mouthClock = 0;
    this.facingAngle = 0;
    this.chaserX = ctx.stage.width / 2;
    this.chaserY = ctx.stage.height / 2;
    this.celebrations = [];
    this.lastEaten = null;

    this.pelletAssets = ctx.roles.pellet?.assets ?? [];
    this.chaserAsset = ctx.roles.chaser?.assets[0] ?? null;

    this.pellets = [];
    this.latticeFor = { width: 0, height: 0 };
    this.ensureLattice();
    if (this.pelletAssets.length > 0) {
      const target = this.livePelletTarget();
      for (let i = 0; i < target; i++) this.spawnPellet();
    }
  }

  update(dt: number): void {
    if (this.ended) return;
    const { tuning, input, stage } = this.ctx;

    this.elapsed += dt;
    this.mouthClock += dt;
    this.ensureLattice();

    // --- chaser control: drag (pointer) or arrow keys, full 2D ---
    const moveSpeed = tuning.moveSpeed ?? 260;
    let dx = 0;
    let dy = 0;
    if (input.pointerDown) {
      dx = input.pointerX - this.chaserX;
      dy = input.pointerY - this.chaserY;
      const dist = Math.hypot(dx, dy);
      const step = moveSpeed * dt;
      if (dist > step) {
        dx = (dx / dist) * step;
        dy = (dy / dist) * step;
      }
    } else {
      if (input.keysDown.has("ArrowLeft")) dx -= 1;
      if (input.keysDown.has("ArrowRight")) dx += 1;
      if (input.keysDown.has("ArrowUp")) dy -= 1;
      if (input.keysDown.has("ArrowDown")) dy += 1;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        dx = (dx / len) * moveSpeed * dt;
        dy = (dy / len) * moveSpeed * dt;
      }
    }
    if (dx !== 0 || dy !== 0) this.facingAngle = Math.atan2(dy, dx);

    const half = CHASER_SIZE / 2;
    const topLimit = this.bannerHeight() + half;
    this.chaserX = Math.min(stage.width - half, Math.max(half, this.chaserX + dx));
    this.chaserY = Math.min(stage.height - half, Math.max(topLimit, this.chaserY + dy));

    // --- pellets: age out, eat on contact, always keep the board topped up ---
    const lifetimeSec = tuning.pelletLifetimeSec ?? 4;
    const eatRadius = CHASER_SIZE / 2 + PELLET_SIZE / 2;
    const survivors: Pellet[] = [];
    let vacated = 0;
    for (const pellet of this.pellets) {
      pellet.age += dt;
      const dist = Math.hypot(pellet.x - this.chaserX, pellet.y - this.chaserY);
      if (dist <= eatRadius) {
        this.ctx.addScore(POINTS_PER_PELLET);
        // The moment of success. The pellet role's fallback is "none", so
        // everything in the pool is a real product — but the image can
        // still have failed to load, and a pellet drawn as a generated dot
        // is not something the player engaged with.
        if (pellet.asset?.image) {
          this.ctx.recordEngagement(pellet.asset.id);
          this.lastEaten = pellet.asset;
          this.celebrations.push({ asset: pellet.asset, x: pellet.x, y: pellet.y, t: 0 });
        }
        this.release(pellet.node);
        vacated++;
        continue;
      }
      if (pellet.age >= lifetimeSec) {
        this.release(pellet.node);
        vacated++;
        continue;
      }
      survivors.push(pellet);
    }
    this.pellets = survivors;
    for (let i = 0; i < vacated; i++) this.spawnPellet();
    this.celebrations = updateCelebrations(this.celebrations, dt);

    const durationSec = tuning.durationSec ?? 40;
    if (this.elapsed >= durationSec) {
      this.ended = true;
      this.ctx.complete();
    }
  }

  render(c: CanvasRenderingContext2D): void {
    this.drawBackground(c);
    this.drawLattice(c);

    const lifetimeSec = this.ctx.tuning.pelletLifetimeSec ?? 4;
    for (const pellet of this.pellets) {
      this.drawPellet(c, pellet, lifetimeSec);
    }

    this.drawChaser(c);
    this.drawFrame(c);
    this.drawBanner(c);

    // Last, so the product just eaten is the clear focal point.
    for (const celebration of this.celebrations) {
      drawCelebration(c, celebration, PELLET_SIZE * 1.5, this.ctx.brand.accent);
    }
  }

  teardown(): void {
    this.pellets = [];
    this.celebrations = [];
    this.occupied = [];
  }

  maxRealisticScore(tuning: Record<string, number>): number {
    return maxRealisticScore(tuning);
  }

  // -------------------------------------------------------------------------
  // Lattice
  // -------------------------------------------------------------------------

  private bannerHeight(): number {
    return Math.max(
      BANNER_MIN_HEIGHT,
      Math.min(BANNER_MAX_HEIGHT, this.ctx.stage.height * BANNER_HEIGHT_FRACTION),
    );
  }

  /**
   * Rebuilds the node grid when the stage size changes. Node spacing is
   * derived from the space actually available rather than fixed, so a
   * 300x250 ad slot gets a coarser board instead of nodes off the edge —
   * and live pellets are re-seated onto the new grid rather than dropped,
   * so a mid-round resize doesn't blank the board.
   */
  private ensureLattice(): void {
    const { stage } = this.ctx;
    if (this.latticeFor.width === stage.width && this.latticeFor.height === stage.height) return;
    this.latticeFor = { width: stage.width, height: stage.height };

    // Clear the banner AND the frame line by a full pellet radius, so the
    // top row of products never pokes up under the banner strip.
    const top = this.bannerHeight() + FRAME_INSET + PELLET_SIZE * 0.6;
    const availWidth = Math.max(0, stage.width - PLACEMENT_MARGIN * 2);
    const availHeight = Math.max(0, stage.height - PLACEMENT_MARGIN - top);

    this.nodeCols = clampInt(Math.round(availWidth / NODE_SPACING_TARGET) + 1, MIN_NODES_PER_AXIS, MAX_NODES_PER_AXIS);
    this.nodeRows = clampInt(Math.round(availHeight / NODE_SPACING_TARGET) + 1, MIN_NODES_PER_AXIS, MAX_NODES_PER_AXIS);

    const stepX = this.nodeCols > 1 ? availWidth / (this.nodeCols - 1) : 0;
    const stepY = this.nodeRows > 1 ? availHeight / (this.nodeRows - 1) : 0;

    this.nodes = [];
    for (let row = 0; row < this.nodeRows; row++) {
      for (let col = 0; col < this.nodeCols; col++) {
        this.nodes.push({ x: PLACEMENT_MARGIN + col * stepX, y: top + row * stepY });
      }
    }
    this.occupied = new Array(this.nodes.length).fill(false);

    // Re-seat whatever is already on the board, dropping any pellet the new
    // (possibly smaller) grid has no room for.
    const carried = this.pellets;
    this.pellets = [];
    for (const pellet of carried) {
      const node = this.claimFreeNode();
      if (node === null) break;
      const at = this.nodes[node]!;
      this.pellets.push({ ...pellet, node, x: at.x, y: at.y });
    }
  }

  /** How many pellets should be live: what the tuning asks for, capped by
   * what the board can actually seat one-per-node. */
  private livePelletTarget(): number {
    const wanted = Math.round(this.ctx.tuning.pelletCount ?? 10);
    return Math.max(0, Math.min(wanted, this.nodes.length));
  }

  private claimFreeNode(): number | null {
    const free: number[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      if (!this.occupied[i]) free.push(i);
    }
    if (free.length === 0) return null;
    const chosen = free[Math.floor(this.ctx.random() * free.length)] ?? free[0]!;
    this.occupied[chosen] = true;
    return chosen;
  }

  private release(node: number): void {
    if (node >= 0 && node < this.occupied.length) this.occupied[node] = false;
  }

  private spawnPellet(): void {
    if (this.pelletAssets.length === 0) return;
    if (this.pellets.length >= this.livePelletTarget()) return;
    const node = this.claimFreeNode();
    if (node === null) return;
    const at = this.nodes[node]!;
    const asset = this.pelletAssets[Math.floor(this.ctx.random() * this.pelletAssets.length)] ?? null;
    this.pellets.push({ x: at.x, y: at.y, asset, age: 0, node });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * A real stageBackground asset wins outright. Otherwise, tie the empty
   * board to the actual product brand rather than a generic fill: tile the
   * store's own logo (pre-loaded by mount.ts onto ctx.brandLogo) faintly
   * across a solid brand.background; with no logo, sweep a diagonal wash
   * from brand.background into brand.accent instead of a flat shade, so
   * even the fallback still reads as "this brand's board".
   */
  private drawBackground(c: CanvasRenderingContext2D): void {
    const { stage, brand } = this.ctx;

    const bg = this.ctx.roles.stageBackground?.assets[0]?.image ?? null;
    if (bg) {
      c.drawImage(bg, 0, 0, stage.width, stage.height);
      return;
    }

    if (this.ctx.brandLogo) {
      c.fillStyle = brand.background;
      c.fillRect(0, 0, stage.width, stage.height);
      this.drawLogoWatermark(c, this.ctx.brandLogo);
      return;
    }

    const gradient = c.createLinearGradient(0, 0, stage.width, stage.height);
    gradient.addColorStop(0, brand.background);
    gradient.addColorStop(1, shade(brand.accent, 0.55));
    c.fillStyle = gradient;
    c.fillRect(0, 0, stage.width, stage.height);
  }

  private drawLogoWatermark(c: CanvasRenderingContext2D, logo: HTMLImageElement): void {
    const { stage } = this.ctx;
    const w = 90;
    const h = w / (logo.naturalWidth / logo.naturalHeight || 1);
    const stepX = w * 1.6;
    const stepY = h * 1.8;

    c.save();
    c.globalAlpha = 0.07;
    let row = 0;
    for (let y = -h; y < stage.height + h; y += stepY, row++) {
      const offsetX = (row % 2) * (stepX / 2);
      for (let x = -w - offsetX; x < stage.width + w; x += stepX) {
        c.drawImage(logo, x, y, w, h);
      }
    }
    c.restore();
  }

  /** Corridors between the nodes, plus a dot at each junction. Purely
   * decorative — nothing collides with these. */
  private drawLattice(c: CanvasRenderingContext2D): void {
    if (this.nodes.length === 0) return;
    const { brand } = this.ctx;
    const first = this.nodes[0]!;
    const last = this.nodes[this.nodes.length - 1]!;

    c.save();
    c.strokeStyle = withAlpha(brand.foreground, 0.07);
    c.lineWidth = CORRIDOR_WIDTH;
    c.lineCap = "round";

    for (let row = 0; row < this.nodeRows; row++) {
      const y = this.nodes[row * this.nodeCols]!.y;
      c.beginPath();
      c.moveTo(first.x, y);
      c.lineTo(last.x, y);
      c.stroke();
    }
    for (let col = 0; col < this.nodeCols; col++) {
      const x = this.nodes[col]!.x;
      c.beginPath();
      c.moveTo(x, first.y);
      c.lineTo(x, last.y);
      c.stroke();
    }
    c.restore();

    c.save();
    c.fillStyle = withAlpha(brand.accent, 0.3);
    for (const node of this.nodes) {
      c.beginPath();
      c.arc(node.x, node.y, 2.5, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  private drawPellet(c: CanvasRenderingContext2D, pellet: Pellet, lifetimeSec: number): void {
    const remaining = lifetimeSec - pellet.age;
    const fade = remaining < FADE_WINDOW_SEC ? Math.max(0, remaining / FADE_WINDOW_SEC) : 1;
    const size = PELLET_SIZE * (0.5 + 0.5 * fade);
    const half = size / 2;

    c.save();
    c.globalAlpha = 0.35 + 0.65 * fade;
    if (pellet.asset?.image) {
      drawAssetContain(c, pellet.asset, pellet.x - half, pellet.y - half, size, size);
    } else {
      c.fillStyle = this.ctx.brand.accent;
      c.beginPath();
      c.arc(pellet.x, pellet.y, half, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  private drawChaser(c: CanvasRenderingContext2D): void {
    const half = CHASER_SIZE / 2;

    if (this.chaserAsset?.image) {
      // Shared helper, not a bare drawImage: it honours subjectBounds and
      // colorAdjust, which a hand-rolled draw silently ignores.
      drawAssetContain(
        c,
        this.chaserAsset,
        this.chaserX - half,
        this.chaserY - half,
        CHASER_SIZE,
        CHASER_SIZE,
      );
      return;
    }

    // generatedShape fallback: the classic wedge-mouth circle, mouth opening
    // and closing over time and oriented toward the last movement direction.
    const mouthOpen = (Math.sin(this.mouthClock * 8) + 1) / 2; // 0..1
    const maxMouthAngle = Math.PI / 4;
    const gap = mouthOpen * maxMouthAngle;

    c.save();
    c.fillStyle = this.ctx.brand.accent;
    c.strokeStyle = withAlpha(this.ctx.brand.foreground, 0.35);
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(this.chaserX, this.chaserY);
    c.arc(this.chaserX, this.chaserY, half, this.facingAngle + gap, this.facingAngle - gap + Math.PI * 2);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
  }

  /** A thin brand-accent border with corner ticks, so the play area reads
   * as a board rather than as the whole canvas. */
  private drawFrame(c: CanvasRenderingContext2D): void {
    const { stage, brand } = this.ctx;
    const top = this.bannerHeight();
    const x = FRAME_INSET;
    const y = top + FRAME_INSET;
    const w = stage.width - FRAME_INSET * 2;
    const h = stage.height - top - FRAME_INSET * 2;
    if (w <= 0 || h <= 0) return;

    c.save();
    c.strokeStyle = withAlpha(brand.accent, 0.35);
    c.lineWidth = 2;
    roundedRect(c, x, y, w, h, 10);
    c.stroke();

    c.strokeStyle = brand.accent;
    c.lineWidth = 3;
    const tick = Math.min(18, w / 4, h / 4);
    const corners: [number, number, number, number][] = [
      [x, y + tick, x, y],
      [x, y, x + tick, y],
      [w + x - tick, y, w + x, y],
      [w + x, y, w + x, y + tick],
      [x, h + y - tick, x, h + y],
      [x, h + y, x + tick, h + y],
      [w + x - tick, h + y, w + x, h + y],
      [w + x, h + y - tick, w + x, h + y],
    ];
    c.beginPath();
    for (const [x1, y1, x2, y2] of corners) {
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
    }
    c.stroke();
    c.restore();
  }

  /**
   * The banner is the board's persistent brand surface: the logo sits in it
   * for the whole round, and the right side calls out the product the
   * player just ate. Before the first eat it shows the game's own headline,
   * so the strip is never empty.
   */
  private drawBanner(c: CanvasRenderingContext2D): void {
    const { stage, brand, brandLogo, copy } = this.ctx;
    const h = this.bannerHeight();
    const pad = h * 0.18;

    c.save();
    // Opaque base first: the banner sits over the board, and a translucent
    // strip alone let the corridors show through and made the logo and the
    // product name hard to read.
    c.fillStyle = brand.background;
    c.fillRect(0, 0, stage.width, h);
    c.fillStyle = withAlpha(brand.accent, 0.16);
    c.fillRect(0, 0, stage.width, h);
    c.fillStyle = withAlpha(brand.accent, 0.45);
    c.fillRect(0, h - 1.5, stage.width, 1.5);

    let textLeft = pad;
    if (brandLogo) {
      const logoW = Math.min(stage.width * 0.28, h * 2.4);
      drawImageContain(c, brandLogo, pad, pad, logoW, h - pad * 2);
      textLeft = pad + logoW + pad;
    }

    const thumb = this.lastEaten;
    let textRight = stage.width - pad;
    if (thumb?.image) {
      const size = h - pad * 2;
      drawAssetContain(c, thumb, stage.width - pad - size, pad, size, size);
      textRight = stage.width - pad - size - pad * 0.6;
    }

    const label = thumb?.data?.name ?? copy.headline;
    const available = textRight - textLeft;
    if (label && available > 24) {
      c.fillStyle = withAlpha(brand.foreground, 0.82);
      c.font = `600 ${Math.round(h * 0.34)}px ${brand.fontFamily}, system-ui, sans-serif`;
      c.textAlign = "right";
      c.textBaseline = "middle";
      c.fillText(truncate(c, label, available), textRight, h / 2);
    }
    c.restore();
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function roundedRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + radius, y);
  c.arcTo(x + w, y, x + w, y + h, radius);
  c.arcTo(x + w, y + h, x, y + h, radius);
  c.arcTo(x, y + h, x, y, radius);
  c.arcTo(x, y, x + w, y, radius);
  c.closePath();
}

/** "Contain" draw for a plain HTMLImageElement (the pre-loaded brand logo),
 * which has no LoadedAsset wrapper and so can't go through
 * spriteRender.ts's drawAssetContain. */
function drawImageContain(
  c: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const srcW = image.naturalWidth || w;
  const srcH = image.naturalHeight || h;
  const scale = Math.min(w / srcW, h / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  c.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function truncate(c: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (c.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && c.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

/** #rrggbb -> rgba() at the given alpha; returns the input unchanged if it
 * isn't a 6-digit hex, so a malformed brand colour degrades visibly rather
 * than painting transparent. */
function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return hex;
  const num = parseInt(clean, 16);
  return `rgba(${(num >> 16) & 0xff}, ${(num >> 8) & 0xff}, ${num & 0xff}, ${alpha})`;
}

/** Darkens (negative amt) or lightens a #rrggbb hex colour by `amt` (-1..1). */
function shade(hex: string, amt: number): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return hex;
  const num = parseInt(clean, 16);
  const adjust = (channel: number) => Math.min(255, Math.max(0, Math.round(channel + 255 * amt)));
  const r = adjust((num >> 16) & 0xff);
  const g = adjust((num >> 8) & 0xff);
  const b = adjust(num & 0xff);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function createChompGame(): GameModule {
  return new ChompGame();
}
