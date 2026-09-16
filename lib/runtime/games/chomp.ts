// lib/runtime/games/chomp.ts
//
// Chomp: a Pac-Man-style chaser roams an open stage eating product pellets
// before each one's own clock runs out. No enemies/lose-condition beyond the
// overall round timer — the per-pellet countdown supplies the challenge
// instead (see lib/capabilities/chomp.json).
//
// Tuning knobs honored (all read from ctx.tuning, already clamped to the
// capability's ranges by mount.ts):
//   pelletCount        — how many pellets are on screen at once
//   moveSpeed          — px/sec the chaser moves at (keyboard) / pointer-follow
//   pelletLifetimeSec  — how long an uneaten pellet survives before it
//                        vanishes and respawns elsewhere (no penalty)
//   durationSec        — total run time
//
// Roles honored:
//   pellet          — required (fallback "none"); scattered products the
//                     player eats by overlapping them
//   chaser          — optional; draws the sprite if a real asset filled the
//                     role, else a classic wedge-mouth circle in
//                     brand.accent ("generatedShape" fallback)
//   stageBackground — optional; brand gradient if unfilled

import type { GameModule, RuntimeContext, LoadedAsset } from "@/lib/runtime/gameModule";
import { drawAssetContain } from "@/lib/runtime/games/spriteRender";

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
const PLACEMENT_MARGIN = 40; // keep pellets off the very edge of the stage
const MIN_PELLET_SPACING = PELLET_SIZE * 1.4;
const PLACEMENT_RETRIES = 8;

interface Pellet {
  x: number;
  y: number;
  asset: LoadedAsset | null; // null → draw a generated dot
  age: number;
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
  private chaserX = 0;
  private chaserY = 0;
  private facingAngle = 0; // radians; drives the generated mouth wedge
  private mouthClock = 0;
  private elapsed = 0;
  private ended = false;

  init(ctx: RuntimeContext): void {
    this.ctx = ctx;
    this.elapsed = 0;
    this.ended = false;
    this.mouthClock = 0;
    this.facingAngle = 0;
    this.chaserX = ctx.stage.width / 2;
    this.chaserY = ctx.stage.height / 2;

    this.pelletAssets = ctx.roles.pellet?.assets ?? [];
    this.chaserAsset = ctx.roles.chaser?.assets[0] ?? null;

    this.pellets = [];
    const pelletCount = Math.round(ctx.tuning.pelletCount ?? 10);
    if (this.pelletAssets.length > 0) {
      for (let i = 0; i < pelletCount; i++) this.spawnPellet();
    }
  }

  update(dt: number): void {
    if (this.ended) return;
    const { tuning, input, stage } = this.ctx;

    this.elapsed += dt;
    this.mouthClock += dt;

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
    this.chaserX = Math.min(stage.width - half, Math.max(half, this.chaserX + dx));
    this.chaserY = Math.min(stage.height - half, Math.max(half, this.chaserY + dy));

    // --- pellets: age out, eat on contact, always keep the pool topped up ---
    const lifetimeSec = tuning.pelletLifetimeSec ?? 4;
    const eatRadius = CHASER_SIZE / 2 + PELLET_SIZE / 2;
    const survivors: Pellet[] = [];
    let eaten = 0;
    let expired = 0;
    for (const pellet of this.pellets) {
      pellet.age += dt;
      const dist = Math.hypot(pellet.x - this.chaserX, pellet.y - this.chaserY);
      if (dist <= eatRadius) {
        this.ctx.addScore(POINTS_PER_PELLET);
        eaten++;
        continue;
      }
      if (pellet.age >= lifetimeSec) {
        expired++;
        continue;
      }
      survivors.push(pellet);
    }
    this.pellets = survivors;
    for (let i = 0; i < eaten + expired; i++) this.spawnPellet();

    const durationSec = tuning.durationSec ?? 40;
    if (this.elapsed >= durationSec) {
      this.ended = true;
      this.ctx.complete();
    }
  }

  render(c: CanvasRenderingContext2D): void {
    this.drawBackground(c);

    const lifetimeSec = this.ctx.tuning.pelletLifetimeSec ?? 4;
    for (const pellet of this.pellets) {
      this.drawPellet(c, pellet, lifetimeSec);
    }

    this.drawChaser(c);
  }

  teardown(): void {
    this.pellets = [];
  }

  maxRealisticScore(tuning: Record<string, number>): number {
    return maxRealisticScore(tuning);
  }

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

  private spawnPellet(): void {
    if (this.pelletAssets.length === 0) return;
    const { stage, random } = this.ctx;
    const minX = PLACEMENT_MARGIN;
    const maxX = Math.max(minX, stage.width - PLACEMENT_MARGIN);
    const minY = PLACEMENT_MARGIN;
    const maxY = Math.max(minY, stage.height - PLACEMENT_MARGIN);

    let x = minX + random() * (maxX - minX);
    let y = minY + random() * (maxY - minY);
    for (let attempt = 0; attempt < PLACEMENT_RETRIES; attempt++) {
      const tooClose = this.pellets.some(
        (p) => Math.hypot(p.x - x, p.y - y) < MIN_PELLET_SPACING,
      );
      const tooCloseToChaser = Math.hypot(this.chaserX - x, this.chaserY - y) < MIN_PELLET_SPACING;
      if (!tooClose && !tooCloseToChaser) break;
      x = minX + random() * (maxX - minX);
      y = minY + random() * (maxY - minY);
    }

    const asset = this.pelletAssets[Math.floor(random() * this.pelletAssets.length)] ?? null;
    this.pellets.push({ x, y, asset, age: 0 });
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
      c.drawImage(
        this.chaserAsset.image,
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
    c.beginPath();
    c.moveTo(this.chaserX, this.chaserY);
    c.arc(this.chaserX, this.chaserY, half, this.facingAngle + gap, this.facingAngle - gap + Math.PI * 2);
    c.closePath();
    c.fill();
    c.restore();
  }
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

export function createChompGame(): GameModule {
  return new ChompGame();
}
