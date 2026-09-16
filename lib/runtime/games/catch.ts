// lib/runtime/games/catch.ts
//
// Catch: products fall from the top, the player drags a basket to catch
// them. Build spec §13 / capability schema §2 (lib/capabilities/catch.json).
//
// Tuning knobs honored (all read from ctx.tuning, already clamped to the
// capability's ranges by mount.ts):
//   spawnRateHz   — how often a new item spawns
//   fallSpeed     — px/sec items fall at
//   durationSec   — total run time
//   hazardRatio   — fraction of spawns that are hazards instead of collectibles
//
// Roles honored:
//   collectible     — required (fallback "none"); the falling items
//   catcher         — the basket; draws the sprite if a real asset filled
//                     the role, else a rounded-rect in brand.accent
//                     ("generatedShape" fallback per the capability)
//   hazard          — optional; if unfilled, hazards still spawn (per
//                     hazardRatio) as a generated shape so the mechanic
//                     works even with zero hazard assets
//   stageBackground — optional; brand gradient if unfilled

import type { GameModule, RuntimeContext, LoadedAsset } from "@/lib/runtime/gameModule";
import {
  drawAssetContain,
  updateCelebrations,
  drawCelebration,
  type Celebration,
} from "@/lib/runtime/games/spriteRender";

// Scoring constants. Chosen so maxRealisticScore() at the capability's
// *default* tuning (spawnRateHz 1.2, durationSec 40, hazardRatio 0.2) lands
// close to catch.json's scoring.maxRealistic (1400):
//   totalSpawns          = 1.2 * 40                          = 48
//   collectibleSpawns    = 48 * (1 - 0.2)                     = 38.4
//   maxRealisticScore     = 38.4 * POINTS_PER_CATCH * CATCH_RATE
//                          = 38.4 * 50 * 0.75                 ≈ 1440
// It naturally scales with whatever tuning a real generated game ends up
// with, which is the point: it's a ceiling for THIS game's tuning, not a
// fixed number.
const POINTS_PER_CATCH = 50;
const HAZARD_PENALTY = 35;
const REALISTIC_CATCH_RATE = 0.75; // fraction of spawned collectibles a competent player nets

const BASKET_WIDTH = 96;
const BASKET_HEIGHT = 64;
const ITEM_SIZE = 56;

interface FallingItem {
  x: number;
  y: number;
  kind: "collectible" | "hazard";
  asset: LoadedAsset | null; // null → draw a generated shape
  size: number;
}

export function maxRealisticScore(tuning: Record<string, number>): number {
  const spawnRateHz = tuning.spawnRateHz ?? 1.2;
  const durationSec = tuning.durationSec ?? 40;
  const hazardRatio = clamp01(tuning.hazardRatio ?? 0.2);

  const totalSpawns = spawnRateHz * durationSec;
  const collectibleSpawns = totalSpawns * (1 - hazardRatio);
  return Math.round(collectibleSpawns * POINTS_PER_CATCH * REALISTIC_CATCH_RATE);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

class CatchGame implements GameModule {
  id: "catch" = "catch";

  private ctx!: RuntimeContext;
  private items: FallingItem[] = [];
  private celebrations: Celebration[] = [];
  private basketX = 0;
  private spawnTimer = 0;
  private elapsed = 0;
  private ended = false;

  private collectibles: LoadedAsset[] = [];
  private hazards: LoadedAsset[] = [];
  private catcherAsset: LoadedAsset | null = null;
  private hasStageBackgroundFallback = false;

  init(ctx: RuntimeContext): void {
    this.ctx = ctx;
    this.items = [];
    this.celebrations = [];
    this.spawnTimer = 0;
    this.elapsed = 0;
    this.ended = false;
    this.basketX = ctx.stage.width / 2;

    this.collectibles = ctx.roles.collectible?.assets ?? [];
    this.hazards = ctx.roles.hazard?.assets ?? [];
    this.catcherAsset = ctx.roles.catcher?.assets[0] ?? null;
    this.hasStageBackgroundFallback = !ctx.roles.stageBackground?.assets.length;
  }

  update(dt: number): void {
    if (this.ended) return;
    const { tuning, input, stage } = this.ctx;

    this.elapsed += dt;

    // --- basket control: drag (pointer) or arrow keys ---
    const halfBasket = BASKET_WIDTH / 2;
    if (input.pointerDown) {
      this.basketX = input.pointerX;
    }
    const keySpeed = 480; // px/sec
    if (input.keysDown.has("ArrowLeft")) this.basketX -= keySpeed * dt;
    if (input.keysDown.has("ArrowRight")) this.basketX += keySpeed * dt;
    this.basketX = Math.min(stage.width - halfBasket, Math.max(halfBasket, this.basketX));

    // --- spawning ---
    const spawnRateHz = tuning.spawnRateHz ?? 1.2;
    const spawnIntervalSec = spawnRateHz > 0 ? 1 / spawnRateHz : Infinity;
    this.spawnTimer += dt;
    while (this.spawnTimer >= spawnIntervalSec && this.collectibles.length > 0) {
      this.spawnTimer -= spawnIntervalSec;
      this.spawnItem();
    }

    // --- movement + collision + cleanup ---
    const fallSpeed = tuning.fallSpeed ?? 160;
    const basketTop = stage.height - BASKET_HEIGHT - 8;
    const survivors: FallingItem[] = [];
    for (const item of this.items) {
      item.y += fallSpeed * dt;

      const caught =
        item.y + item.size / 2 >= basketTop &&
        item.y - item.size / 2 <= basketTop + BASKET_HEIGHT &&
        Math.abs(item.x - this.basketX) <= halfBasket + item.size / 2;

      if (caught) {
        if (item.kind === "collectible") {
          this.ctx.addScore(POINTS_PER_CATCH);
          if (item.asset?.image) {
            this.ctx.recordEngagement(item.asset.id);
            this.celebrations.push({ asset: item.asset, x: item.x, y: item.y, t: 0 });
          }
        } else {
          this.ctx.addScore(-HAZARD_PENALTY);
        }
        continue; // consumed
      }

      if (item.y - item.size / 2 <= stage.height + item.size) {
        survivors.push(item);
      }
      // else: fell past the bottom unmissed — no penalty for a missed collectible
    }
    this.items = survivors;
    this.celebrations = updateCelebrations(this.celebrations, dt);

    const durationSec = tuning.durationSec ?? 40;
    if (this.elapsed >= durationSec) {
      this.ended = true;
      this.ctx.complete();
    }
  }

  render(c: CanvasRenderingContext2D): void {
    const { stage, brand } = this.ctx;

    // Background
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

    // Falling items
    for (const item of this.items) {
      this.drawItem(c, item);
    }

    // Basket
    this.drawBasket(c);

    // Celebrations (a brief grow-and-fade on the just-caught product) draw
    // last so they read as the clear focal point.
    for (const celebration of this.celebrations) {
      drawCelebration(c, celebration, ITEM_SIZE * 1.6, brand.accent);
    }
  }

  teardown(): void {
    this.items = [];
    this.celebrations = [];
  }

  maxRealisticScore(tuning: Record<string, number>): number {
    return maxRealisticScore(tuning);
  }

  private spawnItem(): void {
    const { stage, tuning, random } = this.ctx;
    const hazardRatio = clamp01(tuning.hazardRatio ?? 0.2);
    // Hazards can spawn even with zero real hazard assets — they just draw
    // as a generated shape (drawItem's fallback path) instead of a sprite.
    const wantHazard = random() < hazardRatio;
    const kind: FallingItem["kind"] = wantHazard ? "hazard" : "collectible";

    const pool = kind === "hazard" ? this.hazards : this.collectibles;
    const asset = pool.length > 0 ? pool[Math.floor(random() * pool.length)] : null;

    const size = ITEM_SIZE;
    const x = size / 2 + random() * (stage.width - size);

    this.items.push({ x, y: -size, kind, asset: asset ?? null, size });
  }

  private drawItem(c: CanvasRenderingContext2D, item: FallingItem): void {
    const { brand } = this.ctx;
    const half = item.size / 2;

    if (item.asset?.image) {
      drawAssetContain(c, item.asset, item.x - half, item.y - half, item.size, item.size);
      return;
    }

    // generatedShape fallback: hazard as a dark chip, collectible as a
    // brand-accent circle, so the mechanic still works with 0 sprite assets.
    c.save();
    c.beginPath();
    c.fillStyle = item.kind === "hazard" ? brand.secondaryAccent || "#3a3a3a" : brand.accent;
    if (item.kind === "hazard") {
      roundedRect(c, item.x - half, item.y - half, item.size, item.size, 10);
      c.fill();
    } else {
      c.arc(item.x, item.y, half, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  private drawBasket(c: CanvasRenderingContext2D): void {
    const { stage, brand } = this.ctx;
    const x = this.basketX - BASKET_WIDTH / 2;
    const y = stage.height - BASKET_HEIGHT - 8;

    if (this.catcherAsset?.image) {
      drawAssetContain(c, this.catcherAsset, x, y, BASKET_WIDTH, BASKET_HEIGHT);
      return;
    }

    c.save();
    c.fillStyle = brand.accent;
    roundedRect(c, x, y, BASKET_WIDTH, BASKET_HEIGHT, 14);
    c.fill();
    c.restore();
  }
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

/** Darkens (negative amt) or lightens a #rrggbb hex colour by `amt` (-1..1). */
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

export function createCatchGame(): GameModule {
  return new CatchGame();
}
