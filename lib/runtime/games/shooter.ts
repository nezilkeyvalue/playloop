// lib/runtime/games/shooter.ts
//
// Space Shooter: one product is revealed as "the target" before play
// starts; the player drags a ship left/right (it auto-fires straight up)
// and must shoot only that product as it — and decoy products — fall and
// wiggle down the screen. Shooting a decoy costs a life; MAX_LIVES wrong
// shots ends the round early. Build spec §13 / capability schema §2
// (lib/capabilities/shooter.json).
//
// Tuning knobs honored:
//   fireRateHz    — how often the ship auto-fires
//   spawnRateHz   — how often a new target/decoy spawns
//   fallSpeed     — px/sec items fall at
//   targetRatio   — fraction of spawns that are the correct target
//   durationSec   — total run time
//
// Roles honored:
//   product — optional; supplies both the one target (picked once, at
//             init) and every decoy (every OTHER asset in the role). With
//             fewer than 2 distinct assets, decoys fall back to a
//             generated shape per spawn — the mechanic still works at
//             zero real images (see buildGeneratedIdentity).
//   ship    — optional; the player's ship. Generated rocket shape if unfilled.
//
// No stageBackground role: the starfield IS this template's identity, so
// it's always procedural (tinted with the brand's accent for personality)
// rather than a real photo, which would fight the space theme.

import type { GameModule, RuntimeContext, LoadedAsset } from "@/lib/runtime/gameModule";
import type { BrandKit } from "@/lib/engine/types";
import {
  containFit,
  colorAdjustFilterString,
  createBlurredBackdrop,
  drawArcText,
  withDropShadow,
  updateCelebrations,
  drawCelebration,
  type Celebration,
} from "@/lib/runtime/games/spriteRender";
import { drawStarShape } from "@/lib/runtime/games/shapeLibrary";

// Scoring constants, chosen so maxRealisticScore() at the capability's
// default tuning (spawnRateHz 1.0, durationSec 40, targetRatio 0.4) lands
// close to shooter.json's scoring.maxRealistic (800):
//   totalSpawns   = 1.0 * 40                    = 40
//   targetSpawns  = 40 * 0.4                    = 16
//   maxRealistic  = 16 * POINTS_PER_HIT * REALISTIC_HIT_RATE
//                 = 16 * 60 * 0.8                ≈ 768
const POINTS_PER_HIT = 60;
const REALISTIC_HIT_RATE = 0.8;

const MAX_LIVES = 3;
const INTRO_DURATION_SEC = 2.4;

const SHIP_WIDTH = 64;
const SHIP_HEIGHT = 48;
const ITEM_SIZE = 52;
const INTRO_ITEM_SIZE = 128;
const PROJECTILE_WIDTH = 5;
const PROJECTILE_LENGTH = 20;
const PROJECTILE_SPEED = 640; // px/sec

const WIGGLE_AMPLITUDE = 20; // px, horizontal sway while falling
const WIGGLE_FREQ_MIN = 1.3; // Hz-ish
const WIGGLE_FREQ_MAX = 2.3;

const HIT_FLASH_DURATION = 0.3;
const STAR_COUNT = 70;
// Fixed, not brand-derived — see drawIntro's comment on why brand.foreground
// is the wrong colour against this template's always-dark starfield.
const SPACE_TEXT_COLOR = "#F5F7FF";

interface FallingItem {
  baseX: number;
  x: number;
  y: number;
  size: number;
  isTarget: boolean;
  asset: LoadedAsset | null; // null → generated identity shape
  wiggleFreq: number;
  wigglePhase: number;
}

interface Projectile {
  x: number;
  y: number;
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

interface Star {
  x: number;
  y: number;
  r: number;
  twinklePhase: number;
}

export function maxRealisticScore(tuning: Record<string, number>): number {
  const spawnRateHz = tuning.spawnRateHz ?? 1.0;
  const durationSec = tuning.durationSec ?? 40;
  const targetRatio = clamp01(tuning.targetRatio ?? 0.4);

  const totalSpawns = spawnRateHz * durationSec;
  const targetSpawns = totalSpawns * targetRatio;
  return Math.round(targetSpawns * POINTS_PER_HIT * REALISTIC_HIT_RATE);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

class ShooterGame implements GameModule {
  id: "shooter" = "shooter";
  private ctx!: RuntimeContext;

  private phase: "intro" | "playing" = "intro";
  private introT = 0;

  private shipX = 0;
  private shipAsset: LoadedAsset | null = null;

  private targetAsset: LoadedAsset | null = null;
  private decoyPool: LoadedAsset[] = [];
  private blurredBackdrops = new Map<string, HTMLCanvasElement | null>();

  private items: FallingItem[] = [];
  private projectiles: Projectile[] = [];
  private particles: Particle[] = [];
  private stars: Star[] = [];
  private celebrations: Celebration[] = [];

  private lives = MAX_LIVES;
  private elapsed = 0;
  private spawnTimer = 0;
  private fireTimer = 0;
  private hitFlashT = 0; // >0 while the "wrong!" screen flash/shake plays
  private ended = false;

  init(ctx: RuntimeContext): void {
    this.ctx = ctx;
    this.phase = "intro";
    this.introT = 0;
    this.shipX = ctx.stage.width / 2;
    this.shipAsset = ctx.roles.ship?.assets[0] ?? null;

    this.lives = MAX_LIVES;
    this.elapsed = 0;
    this.spawnTimer = 0;
    this.fireTimer = 0;
    this.hitFlashT = 0;
    this.ended = false;
    this.items = [];
    this.projectiles = [];
    this.particles = [];
    this.celebrations = [];

    const productPool = ctx.roles.product?.assets ?? [];
    if (productPool.length > 0) {
      const idx = Math.floor(ctx.random() * productPool.length);
      this.targetAsset = productPool[idx] ?? null;
      this.decoyPool = productPool.filter((_, i) => i !== idx);
    } else {
      this.targetAsset = null;
      this.decoyPool = [];
    }

    // Pre-rendered once per asset (see createBlurredBackdrop's own doc
    // comment on why not per-frame) — parity with chainPop.ts's tile
    // treatment for the same "photographic" + "blurFill" combination, so a
    // busy/contextual product photo gets its own backdrop extended outward
    // instead of a flat colour patch.
    this.blurredBackdrops = new Map();
    for (const asset of productPool) {
      if (asset.image && asset.presentation === "photographic" && asset.backgroundTreatment === "blurFill") {
        this.blurredBackdrops.set(asset.id, createBlurredBackdrop(asset.image, asset.colorAdjust));
      }
    }

    this.stars = buildStarfield(ctx.stage.width, ctx.stage.height, ctx.random, STAR_COUNT);
  }

  update(dt: number): void {
    if (this.ended) return;
    const { stage, input, tuning } = this.ctx;

    if (this.phase === "intro") {
      this.introT += dt;
      if (this.introT >= INTRO_DURATION_SEC || input.justPressed) {
        this.phase = "playing";
      }
      return;
    }

    this.elapsed += dt;
    if (this.hitFlashT > 0) this.hitFlashT = Math.max(0, this.hitFlashT - dt);

    // --- ship control: drag (pointer) or arrow keys ---
    const halfShip = SHIP_WIDTH / 2;
    if (input.pointerDown) this.shipX = input.pointerX;
    const keySpeed = 520; // px/sec
    if (input.keysDown.has("ArrowLeft")) this.shipX -= keySpeed * dt;
    if (input.keysDown.has("ArrowRight")) this.shipX += keySpeed * dt;
    this.shipX = clamp(this.shipX, halfShip, stage.width - halfShip);

    // --- auto-fire ---
    const fireRateHz = tuning.fireRateHz ?? 2.2;
    const fireIntervalSec = fireRateHz > 0 ? 1 / fireRateHz : Infinity;
    this.fireTimer += dt;
    while (this.fireTimer >= fireIntervalSec) {
      this.fireTimer -= fireIntervalSec;
      this.projectiles.push({ x: this.shipX, y: stage.height - SHIP_HEIGHT - 14 });
    }

    // --- spawning ---
    const spawnRateHz = tuning.spawnRateHz ?? 1.0;
    const spawnIntervalSec = spawnRateHz > 0 ? 1 / spawnRateHz : Infinity;
    this.spawnTimer += dt;
    while (this.spawnTimer >= spawnIntervalSec) {
      this.spawnTimer -= spawnIntervalSec;
      this.spawnFallingItem();
    }

    // --- move projectiles ---
    const survivingProjectiles: Projectile[] = [];
    for (const p of this.projectiles) {
      p.y -= PROJECTILE_SPEED * dt;
      if (p.y > -PROJECTILE_LENGTH) survivingProjectiles.push(p);
    }
    this.projectiles = survivingProjectiles;

    // --- move items (fall + wiggle) ---
    const fallSpeed = tuning.fallSpeed ?? 120;
    for (const item of this.items) {
      item.y += fallSpeed * dt;
      item.wigglePhase += item.wiggleFreq * dt;
      item.x = item.baseX + Math.sin(item.wigglePhase) * WIGGLE_AMPLITUDE;
    }

    // --- collision: each item vs. the nearest not-yet-consumed projectile ---
    const consumed = new Set<number>();
    const nextItems: FallingItem[] = [];
    for (const item of this.items) {
      let wasHit = false;
      for (let i = 0; i < this.projectiles.length; i++) {
        if (consumed.has(i)) continue;
        const p = this.projectiles[i]!;
        const dx = p.x - item.x;
        const dy = p.y - item.y;
        const hitRadius = item.size / 2 + PROJECTILE_WIDTH / 2;
        if (dx * dx + dy * dy <= hitRadius * hitRadius) {
          consumed.add(i);
          wasHit = true;
          break;
        }
      }
      if (wasHit) {
        this.resolveHit(item);
        continue;
      }
      if (item.y - item.size / 2 <= stage.height + item.size) {
        nextItems.push(item);
      }
      // else: fell past the bottom unshot — no penalty either way, same
      // convention as catch.ts's missed collectibles.
    }
    this.items = nextItems;
    this.projectiles = this.projectiles.filter((_, i) => !consumed.has(i));

    // --- particles ---
    const survivingParticles: Particle[] = [];
    for (const particle of this.particles) {
      particle.life -= dt;
      if (particle.life <= 0) continue;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vy += 260 * dt; // gentle gravity
      survivingParticles.push(particle);
    }
    this.particles = survivingParticles;
    this.celebrations = updateCelebrations(this.celebrations, dt);

    if (!this.ended) {
      const durationSec = tuning.durationSec ?? 40;
      if (this.elapsed >= durationSec) {
        this.ended = true;
        this.ctx.complete();
      }
    }
  }

  render(c: CanvasRenderingContext2D): void {
    const { stage, brand } = this.ctx;

    this.drawStarfield(c, stage.width, stage.height, brand);

    if (this.phase === "intro") {
      this.drawIntro(c, stage.width, stage.height, brand);
      return;
    }

    for (const item of this.items) {
      this.drawProductChip(c, item.x, item.y, item.size, item.asset, item.isTarget);
    }

    for (const p of this.projectiles) {
      this.drawProjectile(c, p, brand);
    }

    for (const particle of this.particles) {
      c.globalAlpha = Math.max(0, particle.life / particle.maxLife);
      c.fillStyle = particle.color;
      c.beginPath();
      c.arc(particle.x, particle.y, 2.5, 0, Math.PI * 2);
      c.fill();
      c.globalAlpha = 1;
    }

    this.drawShip(c, stage, brand);
    this.drawLives(c, stage.width, brand);

    for (const celebration of this.celebrations) {
      drawCelebration(c, celebration, ITEM_SIZE * 1.6, brand.accent);
    }

    if (this.hitFlashT > 0) {
      const alpha = (this.hitFlashT / HIT_FLASH_DURATION) * 0.28;
      c.fillStyle = `rgba(230, 60, 60, ${alpha})`;
      c.fillRect(0, 0, stage.width, stage.height);
    }
  }

  teardown(): void {
    this.items = [];
    this.projectiles = [];
    this.particles = [];
    this.celebrations = [];
  }

  maxRealisticScore(tuning: Record<string, number>): number {
    return maxRealisticScore(tuning);
  }

  // ---------------------------------------------------------------------

  private resolveHit(item: FallingItem): void {
    const { brand } = this.ctx;
    if (item.isTarget) {
      this.ctx.addScore(POINTS_PER_HIT);
      this.spawnParticles(item.x, item.y, brand.accent);
      if (item.asset?.image) {
        this.ctx.recordEngagement(item.asset.id);
        this.celebrations.push({ asset: item.asset, x: item.x, y: item.y, t: 0 });
      }
    } else {
      this.lives -= 1;
      this.hitFlashT = HIT_FLASH_DURATION;
      this.spawnParticles(item.x, item.y, "#c94b4b");
      if (this.lives <= 0) {
        this.ended = true;
        this.ctx.complete();
      }
    }
  }

  private spawnFallingItem(): void {
    const { stage, tuning, random } = this.ctx;
    const targetRatio = clamp01(tuning.targetRatio ?? 0.4);
    const isTarget = random() < targetRatio;

    const size = ITEM_SIZE;
    const baseX = size / 2 + random() * (stage.width - size);
    const wiggleFreq = WIGGLE_FREQ_MIN + random() * (WIGGLE_FREQ_MAX - WIGGLE_FREQ_MIN);
    const wigglePhase = random() * Math.PI * 2;

    const asset = isTarget
      ? this.targetAsset
      : this.decoyPool.length > 0
        ? (this.decoyPool[Math.floor(random() * this.decoyPool.length)] ?? null)
        : null;

    this.items.push({ baseX, x: baseX, y: -size, size, isTarget, asset, wiggleFreq, wigglePhase });
  }

  private spawnParticles(x: number, y: number, color: string): void {
    const { random } = this.ctx;
    const count = 10;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + random() * 0.4;
      const speed = 60 + random() * 120;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 40,
        life: 0.35 + random() * 0.25,
        maxLife: 0.6,
        color,
      });
    }
  }

  // --- drawing ------------------------------------------------------------

  private drawStarfield(c: CanvasRenderingContext2D, width: number, height: number, brand: BrandKit): void {
    const gradient = c.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#05060f");
    gradient.addColorStop(1, "#10122a");
    c.fillStyle = gradient;
    c.fillRect(0, 0, width, height);

    // Soft brand-accent "nebula" glows — the one place this background
    // reflects the brand at all; everything else is deliberately a fixed
    // deep-space palette (a light/pastel brand background would fight the
    // theme if used directly here — see the file header).
    drawNebula(c, width * 0.22, height * 0.28, Math.max(width, height) * 0.35, brand.accent);
    drawNebula(c, width * 0.82, height * 0.7, Math.max(width, height) * 0.3, brand.secondaryAccent || brand.accent);

    const t = this.elapsed + this.introT;
    for (const star of this.stars) {
      const alpha = 0.35 + 0.55 * Math.abs(Math.sin(t * 1.6 + star.twinklePhase));
      c.globalAlpha = alpha;
      c.fillStyle = "#ffffff";
      c.beginPath();
      c.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
  }

  private drawIntro(c: CanvasRenderingContext2D, width: number, height: number, brand: BrandKit): void {
    const centerX = width / 2;
    const centerY = height * 0.42;

    // Pulsing highlight ring behind the target so it reads as "the one to
    // look at", not just decoration.
    const pulse = 1 + 0.08 * Math.sin(this.introT * 5);
    c.save();
    c.globalAlpha = 0.35;
    c.strokeStyle = brand.accent;
    c.lineWidth = 6;
    c.beginPath();
    c.arc(centerX, centerY, (INTRO_ITEM_SIZE / 2 + 18) * pulse, 0, Math.PI * 2);
    c.stroke();
    c.restore();

    this.drawProductChip(c, centerX, centerY, INTRO_ITEM_SIZE, this.targetAsset, true);

    const font = fontFamilyForCanvas(brand.fontFamily);
    c.textAlign = "center";
    // Never brand.foreground: that colour is contrast-computed against
    // brand.background, which this template deliberately never renders —
    // the stage is always the fixed dark starfield (see drawStarfield's
    // comment). A light-background brand's foreground is typically near-
    // black, which would go almost invisible here. SPACE_TEXT_COLOR is
    // fixed light for the same reason the starfield itself is fixed dark.
    c.fillStyle = SPACE_TEXT_COLOR;

    // Curved name badge — only when there's a real name to show (skipped
    // silently otherwise, no invented placeholder ring); this doubles as
    // the "look here" framing "YOUR TARGET" otherwise provides, so the two
    // are alternatives rather than both showing at once.
    const name = this.targetAsset?.data?.name;
    if (name) {
      drawArcText(c, name.toUpperCase(), centerX, centerY, INTRO_ITEM_SIZE / 2 + 34, `700 15px ${font}`, SPACE_TEXT_COLOR);
    } else {
      c.globalAlpha = 0.75;
      c.font = `600 15px ${font}`;
      c.fillText("YOUR TARGET", centerX, centerY - INTRO_ITEM_SIZE / 2 - 34);
      c.globalAlpha = 1;
      c.font = `700 22px ${font}`;
      c.fillText("This one!", centerX, centerY + INTRO_ITEM_SIZE / 2 + 44);
    }

    c.globalAlpha = 0.75;
    c.font = `500 14px ${font}`;
    c.fillText("Shoot only this — avoid the rest!", centerX, centerY + INTRO_ITEM_SIZE / 2 + 70);
    c.globalAlpha = 1;
  }

  /** Draws one product image (or a generated identity shape when `asset` is
   * null) inside a circular chip — shared by the intro's large preview and
   * every falling item, so a player learns the target's look once and
   * recognizes it small and in motion. The ring is always neutral, never
   * colored by `isTarget`, whether or not a real photo fills it — colouring
   * it would hand the player a free answer that has nothing to do with
   * actually recognizing the product, defeating the whole mechanic. Only
   * the *generated-shape fallback* differs by `isTarget` (a star vs. a
   * dot), because with zero real images that fallback shape IS the only
   * identity signal available at all — not a hint layered on top of one. */
  private drawProductChip(
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    asset: LoadedAsset | null,
    isTarget: boolean,
  ): void {
    const { brand } = this.ctx;
    const half = size / 2;

    // Cast the chip's drop shadow as one clean circular silhouette before
    // the clipped, multi-layer content below (backdrop fill + optional
    // blurred backdrop + image) draws on top and fully covers it — drawing
    // each of those layers with its own shadow active would double up into
    // a muddy stacked shadow instead of one crisp lift off the starfield.
    withDropShadow(
      c,
      () => {
        c.beginPath();
        c.arc(x, y, half, 0, Math.PI * 2);
        c.fillStyle = "#000";
        c.fill();
      },
      { blur: 10, offsetY: 4 },
    );

    c.save();
    c.beginPath();
    c.arc(x, y, half, 0, Math.PI * 2);
    c.clip();

    if (asset?.image) {
      const isPhotographic = asset.presentation === "photographic" && Boolean(asset.backgroundColor);
      c.fillStyle = isPhotographic ? asset.backgroundColor! : shade(brand.accent, 0.78);
      c.fillRect(x - half, y - half, size, size);

      const blurredBackdrop = isPhotographic ? this.blurredBackdrops.get(asset.id) : undefined;
      if (blurredBackdrop) {
        c.drawImage(blurredBackdrop, x - half, y - half, size, size);
      }

      const img = asset.image;
      const bounds = asset.subjectBounds;
      const sx = bounds ? bounds.x * img.naturalWidth : 0;
      const sy = bounds ? bounds.y * img.naturalHeight : 0;
      const sw = bounds ? bounds.width * img.naturalWidth : img.naturalWidth;
      const sh = bounds ? bounds.height * img.naturalHeight : img.naturalHeight;
      const inset = size * 0.1;
      const boxSize = size - inset * 2;
      const fit = containFit(sw, sh, boxSize, boxSize);
      c.filter = colorAdjustFilterString(asset.colorAdjust);
      c.drawImage(img, sx, sy, sw, sh, x - half + inset + fit.x, y - half + inset + fit.y, fit.w, fit.h);
      c.filter = "none";
    } else {
      c.fillStyle = shade(brand.accent, 0.7);
      c.fillRect(x - half, y - half, size, size);
      if (isTarget) {
        drawStarShape(c, x, y, half * 0.55, "#ffffff");
      } else {
        c.fillStyle = "rgba(255,255,255,0.55)";
        c.beginPath();
        c.arc(x, y, half * 0.32, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.restore();

    c.lineWidth = Math.max(1.5, size * 0.035);
    c.strokeStyle = "rgba(255,255,255,0.55)";
    c.beginPath();
    c.arc(x, y, half, 0, Math.PI * 2);
    c.stroke();
  }

  private drawProjectile(c: CanvasRenderingContext2D, p: Projectile, brand: BrandKit): void {
    const grad = c.createLinearGradient(0, p.y - PROJECTILE_LENGTH, 0, p.y);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(1, brand.accent);
    c.fillStyle = grad;
    c.beginPath();
    roundedRect(c, p.x - PROJECTILE_WIDTH / 2, p.y - PROJECTILE_LENGTH, PROJECTILE_WIDTH, PROJECTILE_LENGTH, PROJECTILE_WIDTH / 2);
    c.fill();
  }

  /** Always draws the fighter-ship hull — a real `ship` asset (which,
   * per shooter.json's role, is very often just the brand's extracted
   * logo) decals onto the hull as a badge instead of replacing it outright.
   * A raw logo image stretched into a rectangle doesn't read as "a ship" at
   * all; a fighter silhouette with the logo on its hull reads as a branded
   * ship, which is the actual ask. */
  private drawShip(c: CanvasRenderingContext2D, stage: { width: number; height: number }, brand: BrandKit): void {
    const x = this.shipX - SHIP_WIDTH / 2;
    const y = stage.height - SHIP_HEIGHT - 8;

    c.save();
    c.fillStyle = brand.accent;
    c.beginPath();
    c.moveTo(this.shipX, y);
    c.lineTo(x + SHIP_WIDTH, y + SHIP_HEIGHT * 0.75);
    c.lineTo(x + SHIP_WIDTH * 0.65, y + SHIP_HEIGHT * 0.75);
    c.lineTo(x + SHIP_WIDTH * 0.65, y + SHIP_HEIGHT);
    c.lineTo(x + SHIP_WIDTH * 0.35, y + SHIP_HEIGHT);
    c.lineTo(x + SHIP_WIDTH * 0.35, y + SHIP_HEIGHT * 0.75);
    c.lineTo(x, y + SHIP_HEIGHT * 0.75);
    c.closePath();
    c.fill();
    c.lineWidth = 1.5;
    c.strokeStyle = "rgba(255,255,255,0.4)";
    c.stroke();

    if (this.shipAsset?.image) {
      const badgeRadius = SHIP_WIDTH * 0.22;
      const badgeX = this.shipX;
      const badgeY = y + SHIP_HEIGHT * 0.46;

      c.save();
      c.beginPath();
      c.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
      c.clip();
      c.fillStyle = "#ffffff";
      c.fillRect(badgeX - badgeRadius, badgeY - badgeRadius, badgeRadius * 2, badgeRadius * 2);
      const img = this.shipAsset.image;
      const fit = containFit(img.naturalWidth, img.naturalHeight, badgeRadius * 1.6, badgeRadius * 1.6);
      c.drawImage(img, badgeX - fit.w / 2, badgeY - fit.h / 2, fit.w, fit.h);
      c.restore();

      c.lineWidth = 1.5;
      c.strokeStyle = "rgba(255,255,255,0.7)";
      c.beginPath();
      c.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
      c.stroke();
    }

    const flicker = 0.6 + 0.4 * Math.abs(Math.sin(this.elapsed * 18));
    c.globalAlpha = flicker;
    c.fillStyle = "#ffb454";
    c.beginPath();
    c.moveTo(this.shipX - 6, y + SHIP_HEIGHT);
    c.lineTo(this.shipX + 6, y + SHIP_HEIGHT);
    c.lineTo(this.shipX, y + SHIP_HEIGHT + 14 * flicker);
    c.closePath();
    c.fill();
    c.restore();
  }

  private drawLives(c: CanvasRenderingContext2D, width: number, brand: BrandKit): void {
    const dotRadius = 7;
    const gap = 20;
    const startX = width / 2 - ((MAX_LIVES - 1) * gap) / 2;
    const y = 22;
    for (let i = 0; i < MAX_LIVES; i++) {
      const filled = i < this.lives;
      c.beginPath();
      c.arc(startX + i * gap, y, dotRadius, 0, Math.PI * 2);
      c.fillStyle = filled ? brand.accent : "rgba(255,255,255,0.18)";
      c.fill();
      if (filled) {
        c.lineWidth = 1.5;
        c.strokeStyle = "rgba(255,255,255,0.5)";
        c.stroke();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

function buildStarfield(width: number, height: number, random: () => number, count: number): Star[] {
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: random() * width,
      y: random() * height,
      r: 0.6 + random() * 1.4,
      twinklePhase: random() * Math.PI * 2,
    });
  }
  return stars;
}

function drawNebula(c: CanvasRenderingContext2D, x: number, y: number, radius: number, hex: string | undefined): void {
  if (!hex || !isHexColor(hex)) return;
  const grad = c.createRadialGradient(x, y, 0, x, y, radius);
  grad.addColorStop(0, `${hex}33`);
  grad.addColorStop(1, `${hex}00`);
  c.fillStyle = grad;
  c.beginPath();
  c.arc(x, y, radius, 0, Math.PI * 2);
  c.fill();
}

function roundedRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  c.moveTo(x + radius, y);
  c.arcTo(x + w, y, x + w, y + h, radius);
  c.arcTo(x + w, y + h, x, y + h, radius);
  c.arcTo(x, y + h, x, y, radius);
  c.arcTo(x, y, x + w, y, radius);
  c.closePath();
}

function isHexColor(value: string | undefined): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Lightens (positive amt) or darkens a #rrggbb hex colour by `amt` (-1..1). */
function shade(hex: string, amt: number): string {
  if (!isHexColor(hex)) return "#4F46E5";
  const clean = hex.replace("#", "");
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

export function createShooterGame(): GameModule {
  return new ShooterGame();
}
