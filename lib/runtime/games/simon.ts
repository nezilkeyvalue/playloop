// lib/runtime/games/simon.ts
//
// Simon: a small pad of product tiles flashes a sequence, the player taps
// the tiles back in the same order, and the sequence grows by one every
// round. The round ends the instant the player mistaps; each round also
// nudges the flash/gap timing faster, mirroring the original electronic
// Simon's speed-up. Build spec §13 / capability schema §2
// (lib/capabilities/simon.json).
//
// Tuning knobs honored:
//   tileCount        — how many tiles are in the pad
//   flashDurationSec — how long each tile lights up during playback
//   gapDurationSec   — pause between flashes during playback
//   maxRounds        — sequence length at which the game ends in a win
//   durationSec      — safety cap on total session length (a player who
//                      never taps back shouldn't hold an embed open forever)
//
// Roles honored:
//   tile            — optional; the distinct product tiles. With fewer real
//                     assets than tileCount, missing tiles fall back to a
//                     distinct brand-palette colour chip — Simon's original
//                     hardware used four coloured pads with no imagery at
//                     all, so this fallback isn't a compromise, it's the
//                     authentic version of the game ("generatedShape"
//                     fallback per the capability).
//   stageBackground — optional; brand gradient if unfilled.
//
// Tap is the whole input surface (ctx.input.justPressed) — same reasoning
// as chainPop.ts: the most forgiving input model available for a widget
// that has to work on a phone inside someone else's page.

import type { GameModule, RuntimeContext, LoadedAsset } from "@/lib/runtime/gameModule";
import type { BrandKit } from "@/lib/engine/types";
import { drawAssetContain } from "@/lib/runtime/games/spriteRender";

// Scoring constants. Chosen so maxRealisticScore() at the capability's
// *default* tuning (maxRounds 12) lands close to simon.json's
// scoring.maxRealistic (960):
//   realisticRounds = round(12 * 0.7)                  = 8
//   correctTaps     = 8*9/2 (triangular sum through round 8) = 36
//   maxRealistic    = 36*POINTS_PER_CORRECT_TAP + 8*ROUND_BONUS
//                   = 36*20 + 8*30                      = 960
const POINTS_PER_CORRECT_TAP = 20;
const ROUND_BONUS = 30;
const REALISTIC_ROUND_FRACTION = 0.7;

const TAP_FLASH_SEC = 0.25;
const GRID_PADDING = 18;
const CELL_GUTTER = 8;
const MIN_TILE_COUNT = 3;
const MAX_TILE_COUNT = 6;
// Each round shaves this fraction off flash/gap timing (floor at 55% of the
// base durations) so the sequence gets visibly harder to track over time.
const SPEEDUP_PER_ROUND = 0.035;
const SPEEDUP_FLOOR = 0.55;

type ShowPhase = "on" | "gap";

interface Tile {
  asset: LoadedAsset | null;
  color: string;
}

export function maxRealisticScore(tuning: Record<string, number>): number {
  const maxRounds = Math.max(1, Math.round(tuning.maxRounds ?? 12));
  const realisticRounds = Math.max(1, Math.round(maxRounds * REALISTIC_ROUND_FRACTION));
  const correctTaps = (realisticRounds * (realisticRounds + 1)) / 2;
  return Math.round(correctTaps * POINTS_PER_CORRECT_TAP + realisticRounds * ROUND_BONUS);
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

class SimonGame implements GameModule {
  id: "simon" = "simon";

  private ctx!: RuntimeContext;
  private tiles: Tile[] = [];
  private cellSize = 80;
  private cols = 2;
  private originX = 0;
  private originY = 0;

  private sequence: number[] = [];
  private maxRounds = 12;
  private flashDurationSec = 0.55;
  private gapDurationSec = 0.28;

  private state: "showing" | "listening" | "over" = "showing";
  private showingIndex = 0;
  private showingLit = -1;
  private showPhase: ShowPhase = "on";
  private phaseTimer = 0;
  private inputIndex = 0;
  private litTile = -1; // currently highlighted tile index, any reason (playback or tap feedback)
  private tapFlashTimer = 0;

  private elapsed = 0;
  private ended = false;
  private hasStageBackgroundFallback = false;

  init(ctx: RuntimeContext): void {
    this.ctx = ctx;
    this.elapsed = 0;
    this.ended = false;
    this.hasStageBackgroundFallback = !ctx.roles.stageBackground?.assets.length;

    const tileCount = clampInt(ctx.tuning.tileCount ?? 4, MIN_TILE_COUNT, MAX_TILE_COUNT);
    this.tiles = buildTiles(ctx.roles.tile?.assets ?? [], ctx.brand, tileCount);
    this.maxRounds = Math.max(1, Math.round(ctx.tuning.maxRounds ?? 12));
    this.flashDurationSec = ctx.tuning.flashDurationSec ?? 0.55;
    this.gapDurationSec = ctx.tuning.gapDurationSec ?? 0.28;

    this.recomputeLayout();
    this.sequence = [Math.floor(ctx.random() * this.tiles.length)];
    this.beginShowing();
  }

  update(dt: number): void {
    if (this.ended) return;
    this.recomputeLayout();
    this.elapsed += dt;

    if (this.tapFlashTimer > 0) {
      this.tapFlashTimer -= dt;
      if (this.tapFlashTimer <= 0) this.litTile = -1;
    }

    if (this.state === "showing") {
      this.updateShowing(dt);
    } else if (this.state === "listening") {
      this.updateListening();
    }

    const durationSec = this.ctx.tuning.durationSec ?? 60;
    if (this.elapsed >= durationSec) {
      this.finish();
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

    for (let i = 0; i < this.tiles.length; i++) {
      this.drawTile(c, i);
    }
  }

  teardown(): void {
    this.tiles = [];
    this.sequence = [];
  }

  maxRealisticScore(tuning: Record<string, number>): number {
    return maxRealisticScore(tuning);
  }

  // ---------------------------------------------------------------------

  private beginShowing(): void {
    this.state = "showing";
    this.showingIndex = 0;
    this.showPhase = "on";
    this.showingLit = this.sequence[0] ?? -1;
    this.litTile = this.showingLit;
    this.phaseTimer = this.currentFlashDurationSec();
    this.inputIndex = 0;
  }

  private currentFlashDurationSec(): number {
    const factor = Math.max(SPEEDUP_FLOOR, 1 - SPEEDUP_PER_ROUND * (this.sequence.length - 1));
    return this.flashDurationSec * factor;
  }

  private currentGapDurationSec(): number {
    const factor = Math.max(SPEEDUP_FLOOR, 1 - SPEEDUP_PER_ROUND * (this.sequence.length - 1));
    return this.gapDurationSec * factor;
  }

  private updateShowing(dt: number): void {
    this.phaseTimer -= dt;
    if (this.phaseTimer > 0) return;

    if (this.showPhase === "on") {
      this.showPhase = "gap";
      this.showingLit = -1;
      this.litTile = -1;
      this.phaseTimer = this.currentGapDurationSec();
      return;
    }

    this.showingIndex += 1;
    if (this.showingIndex >= this.sequence.length) {
      this.state = "listening";
      this.inputIndex = 0;
      return;
    }
    this.showPhase = "on";
    this.showingLit = this.sequence[this.showingIndex] ?? -1;
    this.litTile = this.showingLit;
    this.phaseTimer = this.currentFlashDurationSec();
  }

  private updateListening(): void {
    if (!this.ctx.input.justPressed) return;
    const tapped = this.tileAt(this.ctx.input.pointerX, this.ctx.input.pointerY);
    if (tapped < 0) return;

    this.litTile = tapped;
    this.tapFlashTimer = TAP_FLASH_SEC;

    if (tapped !== this.sequence[this.inputIndex]) {
      this.finish();
      return;
    }

    this.ctx.addScore(POINTS_PER_CORRECT_TAP);
    this.inputIndex += 1;
    if (this.inputIndex < this.sequence.length) return;

    // Round complete.
    this.ctx.addScore(ROUND_BONUS);
    if (this.sequence.length >= this.maxRounds) {
      this.finish();
      return;
    }
    this.sequence.push(Math.floor(this.ctx.random() * this.tiles.length));
    this.beginShowing();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.state = "over";
    this.ctx.complete();
  }

  private recomputeLayout(): void {
    const { stage } = this.ctx;
    const count = this.tiles.length;
    this.cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / this.cols);

    const cellSize = Math.floor(
      Math.min((stage.width - GRID_PADDING * 2) / this.cols, (stage.height - GRID_PADDING * 2) / rows),
    );
    this.cellSize = Math.max(48, cellSize);
    const gridWidth = this.cellSize * this.cols;
    const gridHeight = this.cellSize * rows;
    this.originX = (stage.width - gridWidth) / 2;
    this.originY = (stage.height - gridHeight) / 2;
  }

  private tileAt(px: number, py: number): number {
    const col = Math.floor((px - this.originX) / this.cellSize);
    const row = Math.floor((py - this.originY) / this.cellSize);
    if (col < 0 || col >= this.cols) return -1;
    const index = row * this.cols + col;
    if (row < 0 || index < 0 || index >= this.tiles.length) return -1;
    return index;
  }

  private drawTile(c: CanvasRenderingContext2D, index: number): void {
    const tile = this.tiles[index];
    if (!tile) return;

    const col = index % this.cols;
    const row = Math.floor(index / this.cols);
    const size = this.cellSize - CELL_GUTTER * 2;
    const x = this.originX + col * this.cellSize + CELL_GUTTER;
    const y = this.originY + row * this.cellSize + CELL_GUTTER;
    const radius = size * 0.22;
    const lit = this.litTile === index;

    c.save();
    if (lit) {
      c.translate(x + size / 2, y + size / 2);
      c.scale(1.06, 1.06);
      c.translate(-(x + size / 2), -(y + size / 2));
    }

    c.fillStyle = lit ? shade(tile.color, 0.35) : tile.color;
    roundedRect(c, x, y, size, size, radius);
    c.fill();

    if (tile.asset?.image) {
      const inset = size * 0.14;
      c.save();
      roundedRect(c, x, y, size, size, radius);
      c.clip();
      drawAssetContain(c, tile.asset, x + inset, y + inset, size - inset * 2, size - inset * 2);
      c.restore();
    }

    c.lineWidth = lit ? Math.max(3, size * 0.06) : Math.max(1.5, size * 0.03);
    c.strokeStyle = lit ? this.ctx.brand.foreground : shade(tile.color, -0.1);
    roundedRect(c, x, y, size, size, radius);
    c.stroke();
    c.restore();
  }
}

/** Picks up to tileCount tiles: one per real asset where available, padded
 * out with distinct brand-palette colour chips (no imagery needed — the
 * original Simon hardware was four coloured pads, so a fully-fallback pad
 * is the authentic version of this game, not a degraded one). */
function buildTiles(tileAssets: LoadedAsset[], brand: BrandKit, tileCount: number): Tile[] {
  const colors = buildPaletteColors(brand, tileCount);
  const tiles: Tile[] = [];
  for (let i = 0; i < tileCount; i++) {
    tiles.push({
      asset: tileAssets[i] ?? null,
      color: colors[i % colors.length] ?? brand.accent,
    });
  }
  return tiles;
}

function buildPaletteColors(brand: BrandKit, count: number): string[] {
  const seed = [brand.accent, brand.secondaryAccent, ...brand.palette].filter(isHexColor);
  const uniq: string[] = [];
  for (const hex of seed) {
    if (!uniq.includes(hex)) uniq.push(hex);
  }
  let step = 1;
  while (uniq.length < count) {
    const sign = step % 2 === 0 ? 1 : -1;
    const amt = sign * 0.14 * Math.ceil(step / 2);
    uniq.push(shade(brand.accent, amt));
    step++;
    if (step > 20) break; // safety valve, never reachable in practice
  }
  return uniq.slice(0, count);
}

function isHexColor(value: string | undefined): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
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

export function createSimonGame(): GameModule {
  return new SimonGame();
}
