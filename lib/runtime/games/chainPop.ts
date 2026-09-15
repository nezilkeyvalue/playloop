// lib/runtime/games/chainPop.ts
//
// Chain Pop: a grid of product tiles; tap a group of 3+ orthogonally-
// connected matching tiles to pop them. Popped tiles burst into particles,
// bigger chains flash a bonus callout, and the column above them eases
// down to refill the gap with fresh tiles. Score as much as you can before
// time runs out. Build spec §13 / capability schema §2
// (lib/capabilities/chain_pop.json).
//
// Tuning knobs honored:
//   gridCols, gridRows   — board dimensions
//   durationSec          — total run time
//   minChainLength       — minimum connected group size to pop
//
// Roles honored:
//   tile            — optional; the distinct "kinds" filling the grid. With
//                      real product photos, each kind shows one; with fewer
//                      than 3 (or zero), missing kinds fall back to a
//                      glossy brand-colour gem so the mechanic always works
//                      ("generatedShape" fallback per the capability).
//   stageBackground — optional; brand gradient if unfilled.
//
// Tap is the whole input surface (ctx.input.justPressed) — no dragging, no
// precision required, which is deliberately the most forgiving input model
// available (see lib/runtime/input.ts) for a widget that has to work on a
// phone inside someone else's page.

import type { GameModule, RuntimeContext, LoadedAsset } from "@/lib/runtime/gameModule";
import type { BrandKit } from "@/lib/engine/types";

// Scoring constants, chosen so maxRealisticScore() at the capability's
// default tuning (durationSec 45, minChainLength 3) lands close to
// chain_pop.json's scoring.maxRealistic (1350):
//   avgPoints  = pointsForChain(4, 3) = 4*10 + 1*5           = 45
//   totalPops  = 45s / 1.2s per pop                          = 37.5
//   maxRealistic = 37.5 * 45 * 0.8 (efficiency)               ≈ 1350
const POINTS_PER_TILE = 10;
const CHAIN_BONUS_PER_EXTRA = 5;
const POP_INTERVAL_SEC = 1.2;
const REALISTIC_AVG_CHAIN = 4;
const REALISTIC_EFFICIENCY = 0.8;

const MIN_KINDS = 3;
const MAX_KINDS = 6;
const DEFAULT_KIND_COUNT = 5;

const GRID_PADDING = 14;
const CELL_GUTTER = 4;
const TILE_CORNER_RADIUS_FACTOR = 0.26; // fraction of tile size — deliberately rounded, "sticker" look
// Blurred backdrop for "photographic" + "blurFill" tiles (see Kind.blurredBackdrop) —
// pre-rendered once per kind at a fixed resolution, not full sprite
// resolution, since it's shown blurred; keeps it cheap regardless of the
// final on-screen tile size. Zoomed in specifically to crop OUT the
// sprite's own transparent letterbox margin (every sprite is pipeline-
// normalized to a square canvas via "contain" fit — see sprites.ts's
// SPRITE_SIZE resize) — this cropping only ever affects the blurred decor
// layer, never the sharp foreground image, so no real content is lost.
const BLUR_BACKDROP_RESOLUTION = 96;
const BLUR_BACKDROP_ZOOM = 1.3;
const BLUR_BACKDROP_RADIUS_PX = 12;
const FALL_EASE_RATE = 14; // higher = snappier settle
const SQUASH_DURATION = 0.16;
const POP_DURATION = 0.22;
const SHAKE_DURATION = 0.28;
const SHAKE_AMPLITUDE = 5;
const PARTICLES_PER_TILE = 7;
const PARTICLE_GRAVITY = 480;
const PARTICLE_LIFE_MIN = 0.45;
const PARTICLE_LIFE_MAX = 0.7;
const MAX_PARTICLES = 300;
const FLOATING_TEXT_LIFE = 0.9;
const FLOAT_RISE_PX = 34;
const BIG_CHAIN_THRESHOLD = 5;
const BIG_CHAIN_LABELS = ["Nice chain!", "Great chain!", "Amazing!"];

interface Kind {
  asset: LoadedAsset | null;
  color: string;
  /** Pre-rendered once (see buildKinds) for "photographic" + "blurFill"
   * assets — a blurred, zoomed-in copy of the asset's own image, drawn
   * behind the full (never-cropped) foreground image so the tile blends
   * without cutting off any real content. Null otherwise. */
  blurredBackdrop: HTMLCanvasElement | null;
}

interface Cell {
  kind: number; // index into this.kinds, or -1 once popped/empty
  y: number; // current animated top-left Y, px
  targetY: number; // resting Y for its current row
  landed: boolean;
  scale: number;
  alpha: number;
  popping: boolean;
  popT: number; // 0..1 progress through the pop animation
  shakeT: number; // >0 while playing the "not enough" denial shake
  squashT: number; // >0 while playing the landing squash-bounce
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

interface FloatingText {
  x: number;
  y: number;
  text: string;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

function pointsForChain(size: number, minChainLength: number): number {
  const base = size * POINTS_PER_TILE;
  const bonus = Math.max(0, size - minChainLength) * CHAIN_BONUS_PER_EXTRA;
  return base + bonus;
}

export function maxRealisticScore(tuning: Record<string, number>): number {
  const durationSec = tuning.durationSec ?? 45;
  const minChainLength = tuning.minChainLength ?? 3;
  const avgPoints = pointsForChain(REALISTIC_AVG_CHAIN, minChainLength);
  const totalPops = durationSec / POP_INTERVAL_SEC;
  return Math.round(totalPops * avgPoints * REALISTIC_EFFICIENCY);
}

class ChainPopGame implements GameModule {
  id: "chain_pop" = "chain_pop";

  private ctx!: RuntimeContext;
  private cols = 6;
  private rows = 7;
  private minChainLength = 3;
  private durationSec = 45;
  private elapsed = 0;
  private ended = false;

  private kinds: Kind[] = [];
  private grid: Cell[][] = [];
  private particles: Particle[] = [];
  private floatingTexts: FloatingText[] = [];

  private cellSize = 40;
  private originX = 0;
  private originY = 0;

  private hasStageBackgroundFallback = false;

  init(ctx: RuntimeContext): void {
    this.ctx = ctx;
    const { tuning } = ctx;

    this.cols = Math.round(tuning.gridCols ?? 6);
    this.rows = Math.round(tuning.gridRows ?? 7);
    this.minChainLength = Math.round(tuning.minChainLength ?? 3);
    this.durationSec = tuning.durationSec ?? 45;
    this.elapsed = 0;
    this.ended = false;
    this.particles = [];
    this.floatingTexts = [];
    this.hasStageBackgroundFallback = !ctx.roles.stageBackground?.assets.length;

    this.kinds = buildKinds(ctx.roles.tile?.assets ?? [], ctx.brand, ctx.random);

    this.grid = [];
    for (let row = 0; row < this.rows; row++) {
      const rowCells: Cell[] = [];
      for (let col = 0; col < this.cols; col++) {
        rowCells.push(this.makeCell(Math.floor(ctx.random() * this.kinds.length)));
      }
      this.grid.push(rowCells);
    }

    this.recomputeLayout();
    // Deal the board in from above the fold, staggered by row/col, instead
    // of popping in fully-formed — the first thing a player sees is the
    // board settling into place.
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const cell = this.grid[row]![col]!;
        cell.y = this.originY - (this.rows - row) * this.cellSize - col * 10;
      }
    }
  }

  update(dt: number): void {
    if (this.ended) return;
    this.recomputeLayout();
    this.elapsed += dt;

    if (this.ctx.input.justPressed) {
      const col = Math.floor((this.ctx.input.pointerX - this.originX) / this.cellSize);
      const row = Math.floor((this.ctx.input.pointerY - this.originY) / this.cellSize);
      if (row >= 0 && row < this.rows && col >= 0 && col < this.cols) {
        this.handleTap(row, col);
      }
    }

    let anyResolved = false;
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const cell = this.grid[row]![col]!;
        if (cell.popping) {
          cell.popT += dt / POP_DURATION;
          cell.scale = Math.max(0, 1 - cell.popT);
          cell.alpha = Math.max(0, 1 - cell.popT);
          if (cell.popT >= 1) {
            cell.popping = false;
            cell.kind = -1;
            cell.scale = 1;
            cell.alpha = 1;
            anyResolved = true;
          }
        }
        if (cell.shakeT > 0) cell.shakeT = Math.max(0, cell.shakeT - dt);
        if (cell.squashT > 0) cell.squashT = Math.max(0, cell.squashT - dt);
      }
    }
    if (anyResolved) this.resolveColumns();

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const cell = this.grid[row]![col]!;
        if (Math.abs(cell.targetY - cell.y) > 0.5) {
          cell.y = lerp(cell.y, cell.targetY, 1 - Math.exp(-FALL_EASE_RATE * dt));
          cell.landed = false;
        } else if (!cell.landed) {
          cell.y = cell.targetY;
          cell.landed = true;
          cell.squashT = SQUASH_DURATION;
        }
      }
    }

    this.particles = this.particles.filter((p) => {
      p.vy += PARTICLE_GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      return p.life > 0;
    });
    if (this.particles.length > MAX_PARTICLES) {
      this.particles.splice(0, this.particles.length - MAX_PARTICLES);
    }
    this.floatingTexts = this.floatingTexts.filter((t) => {
      t.life -= dt;
      return t.life > 0;
    });

    if (this.elapsed >= this.durationSec) {
      this.ended = true;
      this.ctx.complete();
    }
  }

  render(c: CanvasRenderingContext2D): void {
    const { stage, brand } = this.ctx;

    if (this.hasStageBackgroundFallback) {
      const gradient = c.createLinearGradient(0, 0, 0, stage.height);
      gradient.addColorStop(0, brand.background);
      gradient.addColorStop(1, shade(brand.background, -0.06));
      c.fillStyle = gradient;
      c.fillRect(0, 0, stage.width, stage.height);
    } else {
      const bg = this.ctx.roles.stageBackground?.assets[0]?.image ?? null;
      if (bg) c.drawImage(bg, 0, 0, stage.width, stage.height);
    }

    // Frosted board panel behind the grid.
    c.save();
    c.globalAlpha = 0.08;
    c.fillStyle = brand.foreground;
    roundedRect(
      c,
      this.originX - 10,
      this.originY - 10,
      this.cols * this.cellSize + 20,
      this.rows * this.cellSize + 20,
      20,
    );
    c.fill();
    c.restore();

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        this.drawCell(c, this.grid[row]![col]!, col);
      }
    }

    for (const p of this.particles) {
      c.save();
      c.globalAlpha = Math.max(0, p.life / p.maxLife);
      c.fillStyle = p.color;
      c.beginPath();
      c.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }

    for (const t of this.floatingTexts) {
      const lifeRatio = t.life / t.maxLife;
      let alpha = 1;
      if (lifeRatio > 0.85) alpha = (1 - lifeRatio) / 0.15;
      else if (lifeRatio < 0.4) alpha = lifeRatio / 0.4;

      c.save();
      c.globalAlpha = Math.max(0, Math.min(1, alpha));
      c.fillStyle = t.color;
      c.font = `800 ${t.size}px ${fontFamilyForCanvas(brand.fontFamily)}`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(t.text, t.x, t.y - (1 - lifeRatio) * FLOAT_RISE_PX);
      c.restore();
    }
  }

  teardown(): void {
    this.grid = [];
    this.particles = [];
    this.floatingTexts = [];
  }

  maxRealisticScore(tuning: Record<string, number>): number {
    return maxRealisticScore(tuning);
  }

  // ---------------------------------------------------------------------

  private makeCell(kind: number): Cell {
    return {
      kind,
      y: 0,
      targetY: 0,
      landed: false,
      scale: 1,
      alpha: 1,
      popping: false,
      popT: 0,
      shakeT: 0,
      squashT: 0,
    };
  }

  private recomputeLayout(): void {
    const { stage } = this.ctx;
    const cellSize = Math.floor(
      Math.min((stage.width - GRID_PADDING * 2) / this.cols, (stage.height - GRID_PADDING * 2) / this.rows),
    );
    this.cellSize = Math.max(16, cellSize);
    this.originX = (stage.width - this.cellSize * this.cols) / 2;
    this.originY = (stage.height - this.cellSize * this.rows) / 2;
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        this.grid[row]![col]!.targetY = this.originY + row * this.cellSize;
      }
    }
  }

  private handleTap(row: number, col: number): void {
    const cell = this.grid[row]?.[col];
    if (!cell || cell.kind === -1 || cell.popping) return;

    const group = this.floodFill(row, col);
    if (group.length >= this.minChainLength) {
      this.popGroup(group);
    } else {
      for (const { row: r, col: c } of group) {
        const gc = this.grid[r]?.[c];
        if (gc) gc.shakeT = SHAKE_DURATION;
      }
    }
  }

  private floodFill(startRow: number, startCol: number): { row: number; col: number }[] {
    const kind = this.grid[startRow]?.[startCol]?.kind;
    if (kind === undefined || kind === -1) return [];

    const visited = new Set<string>();
    const stack: [number, number][] = [[startRow, startCol]];
    const group: { row: number; col: number }[] = [];

    while (stack.length > 0) {
      const [row, col] = stack.pop()!;
      const key = `${row},${col}`;
      if (visited.has(key)) continue;
      visited.add(key);

      const cell = this.grid[row]?.[col];
      if (!cell || cell.kind !== kind || cell.popping) continue;
      group.push({ row, col });

      if (row > 0) stack.push([row - 1, col]);
      if (row < this.rows - 1) stack.push([row + 1, col]);
      if (col > 0) stack.push([row, col - 1]);
      if (col < this.cols - 1) stack.push([row, col + 1]);
    }
    return group;
  }

  private popGroup(group: { row: number; col: number }[]): void {
    const first = group[0]!;
    const kindIndex = this.grid[first.row]?.[first.col]?.kind ?? -1;
    const kind = kindIndex >= 0 ? this.kinds[kindIndex] : undefined;
    const color = kind?.color ?? this.ctx.brand.accent;

    let cx = 0;
    let cy = 0;
    for (const { row, col } of group) {
      const cell = this.grid[row]?.[col];
      if (!cell) continue;
      cell.popping = true;
      cell.popT = 0;
      const centerX = this.originX + col * this.cellSize + this.cellSize / 2;
      const centerY = cell.y + this.cellSize / 2;
      cx += centerX;
      cy += centerY;
      this.spawnParticles(centerX, centerY, color);
    }
    cx /= group.length;
    cy /= group.length;

    const points = pointsForChain(group.length, this.minChainLength);
    this.ctx.addScore(points);
    this.floatingTexts.push({
      x: cx,
      y: cy,
      text: `+${points}`,
      life: FLOATING_TEXT_LIFE,
      maxLife: FLOATING_TEXT_LIFE,
      color: this.ctx.brand.foreground,
      size: 20,
    });

    if (group.length >= BIG_CHAIN_THRESHOLD) {
      const labelIndex = Math.min(BIG_CHAIN_LABELS.length - 1, group.length - BIG_CHAIN_THRESHOLD);
      this.floatingTexts.push({
        x: cx,
        y: cy - 28,
        text: BIG_CHAIN_LABELS[labelIndex]!,
        life: FLOATING_TEXT_LIFE,
        maxLife: FLOATING_TEXT_LIFE,
        color: this.ctx.brand.accent,
        size: 16,
      });
    }
  }

  private spawnParticles(x: number, y: number, color: string): void {
    for (let i = 0; i < PARTICLES_PER_TILE; i++) {
      const angle = this.ctx.random() * Math.PI * 2;
      const speed = 70 + this.ctx.random() * 110;
      const life = PARTICLE_LIFE_MIN + this.ctx.random() * (PARTICLE_LIFE_MAX - PARTICLE_LIFE_MIN);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 40,
        life,
        maxLife: life,
        color,
        size: 3 + this.ctx.random() * 3,
      });
    }
  }

  /** Compacts each column's surviving (non-empty) cells downward and spawns
   * fresh ones above the board to refill the gaps — object references move
   * between grid slots (not values) so a surviving cell's current animated
   * `y` carries over and it visibly falls into its new row rather than
   * teleporting. */
  private resolveColumns(): void {
    for (let col = 0; col < this.cols; col++) {
      const remaining: Cell[] = [];
      for (let row = 0; row < this.rows; row++) {
        const cell = this.grid[row]![col]!;
        if (cell.kind !== -1) remaining.push(cell);
      }
      const missing = this.rows - remaining.length;
      const fresh: Cell[] = [];
      for (let i = 0; i < missing; i++) {
        fresh.push(this.makeCell(Math.floor(this.ctx.random() * this.kinds.length)));
      }
      const combined = [...fresh, ...remaining];
      for (let row = 0; row < this.rows; row++) {
        const cell = combined[row]!;
        cell.targetY = this.originY + row * this.cellSize;
        if (row < fresh.length) {
          cell.y = this.originY - (fresh.length - row) * this.cellSize - 6;
          cell.landed = false;
        }
        this.grid[row]![col] = cell;
      }
    }
  }

  private drawCell(c: CanvasRenderingContext2D, cell: Cell, col: number): void {
    if (cell.kind === -1) return;
    const kind = this.kinds[cell.kind];
    if (!kind) return;

    const size = this.cellSize - CELL_GUTTER * 2;
    const shakeOffset =
      cell.shakeT > 0
        ? Math.sin((cell.shakeT / SHAKE_DURATION) * Math.PI * 4) * SHAKE_AMPLITUDE * (cell.shakeT / SHAKE_DURATION)
        : 0;
    const x = this.originX + col * this.cellSize + CELL_GUTTER + shakeOffset;
    const y = cell.y + CELL_GUTTER;

    const squash = cell.squashT > 0 ? cell.squashT / SQUASH_DURATION : 0;
    const scaleX = cell.scale * (1 + 0.14 * squash);
    const scaleY = cell.scale * (1 - 0.22 * squash);
    const cx = x + size / 2;
    const cy = y + size / 2;

    c.save();
    c.globalAlpha = cell.alpha;
    c.translate(cx, cy);
    c.scale(scaleX, scaleY);
    c.translate(-size / 2, -size / 2);

    const radius = size * TILE_CORNER_RADIUS_FACTOR;

    // A "photographic" asset (real, uncut photo backdrop — see
    // AssetPresentation in lib/engine/types.ts) still has its own real
    // background baked into the sprite; filling the chip with the
    // *brand's* colour behind it used to read as an amateur "sticker in an
    // unrelated coloured box". Filling with the photo's own sampled
    // background colour instead means the chip and the photo's backdrop
    // are the same colour — no seam. The image itself is NEVER cropped to
    // achieve this (a crop can cut off a real product/person) — only the
    // decorative fill behind it changes.
    const isPhotographic = kind.asset?.presentation === "photographic" && Boolean(kind.asset.backgroundColor);
    const chipFill = isPhotographic ? kind.asset!.backgroundColor! : shade(kind.color, 0.72);

    c.fillStyle = chipFill;
    roundedRect(c, 0, 0, size, size, radius);
    c.fill();

    if (kind.asset?.image) {
      const inset = size * 0.1;
      c.save();
      roundedRect(c, 0, 0, size, size, radius);
      c.clip();
      if (isPhotographic && kind.blurredBackdrop) {
        // A busy/contextual backdrop (a room, outdoors, etc.) — a flat
        // colour fill would look like an obvious patch, so extend the
        // photo's own content outward via a blurred, zoomed copy instead
        // (pre-rendered once in buildKinds, not re-blurred every frame).
        c.drawImage(kind.blurredBackdrop, 0, 0, size, size);
      }
      // The full sprite, always — "contain" scaling only (fit entirely
      // within the inset box, preserving aspect), never a source crop, so
      // no real content is ever cut off regardless of treatment.
      c.drawImage(kind.asset.image, inset, inset, size - inset * 2, size - inset * 2);
      c.restore();
    } else {
      c.fillStyle = kind.color;
      roundedRect(c, size * 0.08, size * 0.08, size * 0.84, size * 0.84, radius * 0.9);
      c.fill();

      const grad = c.createRadialGradient(size * 0.32, size * 0.28, 1, size * 0.32, size * 0.28, size * 0.5);
      grad.addColorStop(0, "rgba(255,255,255,0.55)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = grad;
      roundedRect(c, size * 0.08, size * 0.08, size * 0.84, size * 0.84, radius * 0.9);
      c.fill();
    }

    // A crisp coloured ring reads the rounded corner as a deliberate
    // design feature (a "sticker" edge) rather than an artifact of
    // clipping — especially valuable now that real, mixed-aspect product
    // photos (not just generated gems) fill most tiles.
    c.lineWidth = Math.max(1.5, size * 0.035);
    c.strokeStyle = shade(kind.color, -0.08);
    roundedRect(c, 0, 0, size, size, radius);
    c.stroke();

    c.restore();
  }
}

/** Picks up to MAX_KINDS distinct "kinds" for the grid: one per real tile
 * asset where available, padded out with synthesized brand-colour gems so
 * the game always has at least MIN_KINDS kinds even with zero product
 * photos (a site with only a logo and a colour palette still gets a fully
 * playable board). */
function buildKinds(tileAssets: LoadedAsset[], brand: BrandKit, random: () => number): Kind[] {
  const kindCount = clampInt(tileAssets.length > 0 ? tileAssets.length : DEFAULT_KIND_COUNT, MIN_KINDS, MAX_KINDS);
  const colors = buildPaletteColors(brand, kindCount, random);
  const kinds: Kind[] = [];
  for (let i = 0; i < kindCount; i++) {
    const asset = tileAssets[i] ?? null;
    kinds.push({
      asset,
      color: colors[i % colors.length] ?? brand.accent,
      blurredBackdrop:
        asset?.image && asset.presentation === "photographic" && asset.backgroundTreatment === "blurFill"
          ? createBlurredBackdrop(asset.image)
          : null,
    });
  }
  return kinds;
}

/** Pre-renders a blurred, zoomed-in copy of `image` onto a small offscreen
 * canvas — once per kind (see buildKinds), not per frame: applying a CSS
 * blur filter live in drawCell for every tile every frame (up to
 * MAX_KINDS distinct blurs, each potentially drawn many times across the
 * board) would be needless per-frame cost for a result that never
 * changes. Returns null in non-DOM environments (SSR) or if 2D context
 * creation fails — callers already treat a null backdrop as "no blur
 * decoration", never a hard failure. */
function createBlurredBackdrop(image: HTMLImageElement): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = BLUR_BACKDROP_RESOLUTION;
  canvas.height = BLUR_BACKDROP_RESOLUTION;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.filter = `blur(${BLUR_BACKDROP_RADIUS_PX}px)`;
  const d = BLUR_BACKDROP_RESOLUTION * BLUR_BACKDROP_ZOOM;
  const offset = (BLUR_BACKDROP_RESOLUTION - d) / 2;
  ctx.drawImage(image, offset, offset, d, d);
  return canvas;
}

function buildPaletteColors(brand: BrandKit, count: number, random: () => number): string[] {
  const seed = [brand.accent, brand.secondaryAccent, ...brand.palette].filter(isHexColor);
  const uniq: string[] = [];
  for (const hex of seed) {
    if (!uniq.includes(hex)) uniq.push(hex);
  }
  // Not enough distinct real brand colours — synthesize more by shading
  // the accent so the board still reads as varied instead of monochrome.
  let step = 1;
  while (uniq.length < count) {
    const sign = step % 2 === 0 ? 1 : -1;
    const amt = sign * 0.12 * Math.ceil(step / 2) + (random() - 0.5) * 0.02;
    uniq.push(shade(brand.accent, amt));
    step++;
    if (step > 20) break; // safety valve, never reachable in practice
  }
  return uniq.slice(0, count);
}

function isHexColor(value: string | undefined): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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

/** Lightens (positive amt) or darkens (negative amt) a #rrggbb hex colour
 * by `amt` (-1..1). */
function shade(hex: string, amt: number): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return hex;
  const num = parseInt(clean, 16);
  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  const adjust = (channel: number) => Math.min(255, Math.max(0, Math.round(channel + 255 * amt)));
  r = adjust(r);
  g = adjust(g);
  b = adjust(b);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function fontFamilyForCanvas(fontFamily: string): string {
  return fontFamily || "system-ui, sans-serif";
}

export function createChainPopGame(): GameModule {
  return new ChainPopGame();
}
