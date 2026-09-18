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
//
// Theme dressing: `spec.meta.theme === "pet_supplies"` swaps the generated
// catcher for a food bowl and puts dog silhouettes along the ground. That
// is the ONLY behaviour any theme changes here — no scoring, no spawning,
// no role handling — and with no theme set (every spec generated before
// meta.theme existed) this file renders exactly as it always did. If a
// third theme ever lands, move the switch out to a lookup table rather
// than growing a chain of branches through the render path.
//
// The pet is deliberately NOT routed through the `catcher` role: that role
// requires subjectTypeIn ["product", "logo", "shape"], and a store's own
// dog photo classifies as "lifestyle", so the matcher would never assign
// it. Loosening the role to let one through would also let any lifestyle
// rectangle become a basket on every other site. A generated silhouette
// needs no asset at all and is right on every pet store.

import type { GameModule, RuntimeContext, LoadedAsset } from "@/lib/runtime/gameModule";
import {
  drawAssetContain,
  drawBrandBackground,
  withDropShadow,
  updateCelebrations,
  drawCelebration,
  type Celebration,
} from "@/lib/runtime/games/spriteRender";
import {
  drawGemShape,
  drawHazardShape,
  drawBasketShape,
  drawPetBowlShape,
  drawDogSilhouette,
} from "@/lib/runtime/games/shapeLibrary";

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

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
}

const PARTICLES_PER_CATCH = 8;
const BASKET_SQUASH_DURATION = 0.16;

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
  private particles: Particle[] = [];
  private basketX = 0;
  private basketSquashT = 0;
  private spawnTimer = 0;
  private elapsed = 0;
  private ended = false;

  private collectibles: LoadedAsset[] = [];
  private hazards: LoadedAsset[] = [];
  private catcherAsset: LoadedAsset | null = null;
  private hasStageBackgroundFallback = false;
  private petTheme = false;

  init(ctx: RuntimeContext): void {
    this.ctx = ctx;
    this.items = [];
    this.celebrations = [];
    this.particles = [];
    this.spawnTimer = 0;
    this.elapsed = 0;
    this.ended = false;
    this.basketX = ctx.stage.width / 2;
    this.basketSquashT = 0;

    this.collectibles = ctx.roles.collectible?.assets ?? [];
    this.hazards = ctx.roles.hazard?.assets ?? [];
    this.catcherAsset = ctx.roles.catcher?.assets[0] ?? null;
    this.hasStageBackgroundFallback = !ctx.roles.stageBackground?.assets.length;
    this.petTheme = ctx.spec.meta.theme === "pet_supplies";
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
        this.basketSquashT = BASKET_SQUASH_DURATION;
        if (item.kind === "collectible") {
          this.ctx.addScore(POINTS_PER_CATCH);
          this.ctx.sound.play("success");
          this.spawnParticles(item.x, item.y, this.ctx.brand.accent);
          if (item.asset?.image) {
            this.ctx.recordEngagement(item.asset.id);
            this.celebrations.push({ asset: item.asset, x: item.x, y: item.y, t: 0 });
          }
        } else {
          this.ctx.addScore(-HAZARD_PENALTY);
          this.ctx.sound.play("fail");
          this.spawnParticles(item.x, item.y, "#c94b4b");
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
    if (this.basketSquashT > 0) this.basketSquashT = Math.max(0, this.basketSquashT - dt);
    this.particles = this.particles.filter((p) => {
      p.vy += 420 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      return p.life > 0;
    });

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
      drawBrandBackground(c, stage.width, stage.height, brand.background, brand.accent);
    } else {
      const bg = this.ctx.roles.stageBackground?.assets[0]?.image ?? null;
      if (bg) c.drawImage(bg, 0, 0, stage.width, stage.height);
    }

    // Theme scenery sits behind everything that moves.
    if (this.petTheme) this.drawPetScenery(c);

    // Falling items
    for (const item of this.items) {
      this.drawItem(c, item);
    }

    // Basket
    this.drawBasket(c);

    for (const p of this.particles) {
      c.save();
      c.globalAlpha = Math.max(0, p.life / p.maxLife);
      c.fillStyle = p.color;
      c.beginPath();
      c.arc(p.x, p.y, 3, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }

    // Celebrations (a brief grow-and-fade on the just-caught product) draw
    // last so they read as the clear focal point.
    for (const celebration of this.celebrations) {
      drawCelebration(c, celebration, ITEM_SIZE * 1.6, brand.accent);
    }
  }

  teardown(): void {
    this.items = [];
    this.celebrations = [];
    this.particles = [];
  }

  private spawnParticles(x: number, y: number, color: string): void {
    const { random } = this.ctx;
    for (let i = 0; i < PARTICLES_PER_CATCH; i++) {
      const angle = (i / PARTICLES_PER_CATCH) * Math.PI * 2 + random() * 0.4;
      const speed = 60 + random() * 100;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 60,
        life: 0.35 + random() * 0.25,
        maxLife: 0.6,
        color,
      });
    }
  }

  timeRemaining(): { secondsLeft: number; totalSeconds: number } | null {
    const total = this.ctx.tuning.durationSec ?? 40;
    return { secondsLeft: Math.max(0, total - this.elapsed), totalSeconds: total };
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
      withDropShadow(c, () => drawAssetContain(c, item.asset!, item.x - half, item.y - half, item.size, item.size));
      return;
    }

    // generatedShape fallback — a hand-drawn hazard burst or gem instead of
    // a flat rect/circle, so the mechanic still works (and looks
    // deliberate) with 0 sprite assets.
    if (item.kind === "hazard") {
      drawHazardShape(c, item.x, item.y, item.size, brand.secondaryAccent || "#3a3a3a");
    } else {
      drawGemShape(c, item.x, item.y, item.size, brand.accent);
    }
  }

  private drawBasket(c: CanvasRenderingContext2D): void {
    const { stage, brand } = this.ctx;
    const x = this.basketX - BASKET_WIDTH / 2;
    const y = stage.height - BASKET_HEIGHT - 8;

    // A brief squash-bounce on every catch — wider and shorter for an
    // instant, easing back — so the basket reads as reacting to the catch
    // instead of items just silently vanishing into it.
    const squash = this.basketSquashT > 0 ? this.basketSquashT / BASKET_SQUASH_DURATION : 0;
    const scaleX = 1 + 0.1 * squash;
    const scaleY = 1 - 0.16 * squash;
    const cx = this.basketX;
    const cy = y + BASKET_HEIGHT;

    c.save();
    c.translate(cx, cy);
    c.scale(scaleX, scaleY);
    c.translate(-cx, -cy);

    if (this.catcherAsset?.image) {
      withDropShadow(c, () => drawAssetContain(c, this.catcherAsset!, x, y, BASKET_WIDTH, BASKET_HEIGHT));
    } else if (this.petTheme) {
      drawPetBowlShape(c, x, y, BASKET_WIDTH, BASKET_HEIGHT, brand.accent);
    } else {
      drawBasketShape(c, x, y, BASKET_WIDTH, BASKET_HEIGHT, brand.accent);
    }
    c.restore();
  }

  /** Two dogs waiting along the ground, watching the supplies come down.
   * Scenery only: drawn under the falling items, well below the play line,
   * and faint enough that it never competes with a product sprite. */
  private drawPetScenery(c: CanvasRenderingContext2D): void {
    const { stage, brand } = this.ctx;
    const feetY = stage.height - 4;
    const size = Math.max(64, Math.min(132, stage.width * 0.26));

    c.save();
    c.globalAlpha = 0.18;
    drawDogSilhouette(c, size * 0.75, feetY, size, brand.foreground);
    drawDogSilhouette(c, stage.width - size * 0.55, feetY, size * 0.82, brand.foreground);
    c.restore();
  }
}

export function createCatchGame(): GameModule {
  return new CatchGame();
}
