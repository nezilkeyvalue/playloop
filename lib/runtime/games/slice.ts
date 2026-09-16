// lib/runtime/games/slice.ts
//
// Slice: products launch upward off the bottom of the stage and arc back
// down under gravity; the player swipes across them to slice before they
// fall past the bottom. A minority of launches are decoys (hazards) that
// cost points if sliced. Build spec §13 / capability schema §2
// (lib/capabilities/slice.json).
//
// Tuning knobs honored:
//   launchRateHz — how often a new item launches
//   launchSpeed  — initial upward speed, px/sec
//   gravity      — downward acceleration, px/sec^2
//   durationSec  — total run time
//   hazardRatio  — fraction of launches that are hazards instead of collectibles
//
// Roles honored:
//   collectible     — required (fallback "none"); the items to slice
//   hazard          — optional; if unfilled, hazards still launch (per
//                     hazardRatio) as a generated shape so the mechanic
//                     works even with zero hazard assets
//   stageBackground — optional; brand gradient if unfilled
//
// Slicing is a swipe, not a tap: only the segment between last frame's
// pointer position and this frame's counts as a cut, and only while the
// pointer is held down — a fresh press with no prior "down" frame draws no
// segment, so a new touch elsewhere on the stage can't register a
// long-distance phantom slice. A short fading trail follows the pointer
// while dragging; on a touchscreen there's no visible cursor, so without it
// a player has no way to see whether their swipe is registering at all.

import type { GameModule, RuntimeContext, LoadedAsset } from "@/lib/runtime/gameModule";

// Scoring constants. Chosen so maxRealisticScore() at the capability's
// *default* tuning (launchRateHz 1.1, durationSec 35, hazardRatio 0.18)
// lands close to slice.json's scoring.maxRealistic (1000):
//   totalLaunches       = 1.1 * 35                          = 38.5
//   collectibleLaunches = 38.5 * (1 - 0.18)                  = 31.57
//   maxRealistic         = 31.57 * POINTS_PER_SLICE * REALISTIC_SLICE_RATE
//                        = 31.57 * 45 * 0.7                  ≈ 994
const POINTS_PER_SLICE = 45;
const HAZARD_PENALTY = 35;
const REALISTIC_SLICE_RATE = 0.7; // swiping a moving target is harder than positioning a basket

const ITEM_SIZE = 60;
const SIDE_MARGIN = 50;
const TRAIL_POINT_LIFE = 0.2;
const TRAIL_MAX_POINTS = 10;
const FLOATING_TEXT_LIFE = 0.55;
const FLOAT_RISE_PX = 24;

interface FlyingItem {
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: "collectible" | "hazard";
  asset: LoadedAsset | null;
  size: number;
}

interface TrailPoint {
  x: number;
  y: number;
  life: number;
}

interface FloatingText {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  maxLife: number;
}

export function maxRealisticScore(tuning: Record<string, number>): number {
  const launchRateHz = tuning.launchRateHz ?? 1.1;
  const durationSec = tuning.durationSec ?? 35;
  const hazardRatio = clamp01(tuning.hazardRatio ?? 0.18);

  const totalLaunches = launchRateHz * durationSec;
  const collectibleLaunches = totalLaunches * (1 - hazardRatio);
  return Math.round(collectibleLaunches * POINTS_PER_SLICE * REALISTIC_SLICE_RATE);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

class SliceGame implements GameModule {
  id: "slice" = "slice";

  private ctx!: RuntimeContext;
  private items: FlyingItem[] = [];
  private trail: TrailPoint[] = [];
  private floatingTexts: FloatingText[] = [];
  private spawnTimer = 0;
  private elapsed = 0;
  private ended = false;

  private wasDragging = false;
  private lastPX = 0;
  private lastPY = 0;

  private collectibles: LoadedAsset[] = [];
  private hazards: LoadedAsset[] = [];
  private hasStageBackgroundFallback = false;

  init(ctx: RuntimeContext): void {
    this.ctx = ctx;
    this.items = [];
    this.trail = [];
    this.floatingTexts = [];
    this.spawnTimer = 0;
    this.elapsed = 0;
    this.ended = false;
    this.wasDragging = false;

    this.collectibles = ctx.roles.collectible?.assets ?? [];
    this.hazards = ctx.roles.hazard?.assets ?? [];
    this.hasStageBackgroundFallback = !ctx.roles.stageBackground?.assets.length;
  }

  update(dt: number): void {
    if (this.ended) return;
    const { tuning, input, stage, random } = this.ctx;

    this.elapsed += dt;

    // --- swipe tracking + slicing ---
    if (input.pointerDown) {
      this.pushTrailPoint(input.pointerX, input.pointerY);
      if (this.wasDragging) {
        this.testSlice(this.lastPX, this.lastPY, input.pointerX, input.pointerY);
      }
      this.lastPX = input.pointerX;
      this.lastPY = input.pointerY;
      this.wasDragging = true;
    } else {
      this.wasDragging = false;
    }
    this.trail = this.trail.filter((p) => {
      p.life -= dt;
      return p.life > 0;
    });
    if (this.trail.length > TRAIL_MAX_POINTS) {
      this.trail.splice(0, this.trail.length - TRAIL_MAX_POINTS);
    }

    // --- spawning ---
    const launchRateHz = tuning.launchRateHz ?? 1.1;
    const launchIntervalSec = launchRateHz > 0 ? 1 / launchRateHz : Infinity;
    this.spawnTimer += dt;
    while (this.spawnTimer >= launchIntervalSec && this.collectibles.length > 0) {
      this.spawnTimer -= launchIntervalSec;
      this.spawnItem();
    }

    // --- physics + cleanup ---
    const gravity = tuning.gravity ?? 1400;
    const survivors: FlyingItem[] = [];
    for (const item of this.items) {
      item.vy += gravity * dt;
      item.x += item.vx * dt;
      item.y += item.vy * dt;
      if (item.y - item.size / 2 <= stage.height + item.size && item.x > -item.size && item.x < stage.width + item.size) {
        survivors.push(item);
      }
      // else: fell past the bottom unsliced — no penalty for a missed item
    }
    this.items = survivors;

    this.floatingTexts = this.floatingTexts.filter((t) => {
      t.life -= dt;
      return t.life > 0;
    });

    const durationSec = tuning.durationSec ?? 35;
    if (this.elapsed >= durationSec) {
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

    for (const item of this.items) {
      this.drawItem(c, item);
    }

    this.drawTrail(c);

    for (const t of this.floatingTexts) {
      const lifeRatio = t.life / t.maxLife;
      c.save();
      c.globalAlpha = Math.max(0, lifeRatio);
      c.fillStyle = t.color;
      c.font = `800 20px ${fontFamilyForCanvas(brand.fontFamily)}`;
      c.textAlign = "center";
      c.fillText(t.text, t.x, t.y - (1 - lifeRatio) * FLOAT_RISE_PX);
      c.restore();
    }
  }

  teardown(): void {
    this.items = [];
    this.trail = [];
    this.floatingTexts = [];
  }

  maxRealisticScore(tuning: Record<string, number>): number {
    return maxRealisticScore(tuning);
  }

  private spawnItem(): void {
    const { stage, tuning, random } = this.ctx;
    const hazardRatio = clamp01(tuning.hazardRatio ?? 0.18);
    const wantHazard = random() < hazardRatio;
    const kind: FlyingItem["kind"] = wantHazard ? "hazard" : "collectible";

    const pool = kind === "hazard" ? this.hazards : this.collectibles;
    const asset = pool.length > 0 ? pool[Math.floor(random() * pool.length)] : null;

    const launchSpeed = tuning.launchSpeed ?? 650;
    const x = SIDE_MARGIN + random() * (stage.width - SIDE_MARGIN * 2);
    const vx = (random() - 0.5) * 160;
    const vy = -(launchSpeed * (0.85 + random() * 0.3));

    this.items.push({ x, y: stage.height + ITEM_SIZE / 2, vx, vy, kind, asset: asset ?? null, size: ITEM_SIZE });
  }

  private pushTrailPoint(x: number, y: number): void {
    this.trail.push({ x, y, life: TRAIL_POINT_LIFE });
  }

  private testSlice(x1: number, y1: number, x2: number, y2: number): void {
    const survivors: FlyingItem[] = [];
    for (const item of this.items) {
      const hitRadius = item.size / 2;
      if (distanceToSegment(item.x, item.y, x1, y1, x2, y2) <= hitRadius) {
        this.registerSlice(item);
      } else {
        survivors.push(item);
      }
    }
    this.items = survivors;
  }

  private registerSlice(item: FlyingItem): void {
    if (item.kind === "collectible") {
      this.ctx.addScore(POINTS_PER_SLICE);
      this.floatingTexts.push({
        x: item.x,
        y: item.y,
        text: `+${POINTS_PER_SLICE}`,
        color: this.ctx.brand.accent,
        life: FLOATING_TEXT_LIFE,
        maxLife: FLOATING_TEXT_LIFE,
      });
    } else {
      this.ctx.addScore(-HAZARD_PENALTY);
      this.floatingTexts.push({
        x: item.x,
        y: item.y,
        text: `-${HAZARD_PENALTY}`,
        color: this.ctx.brand.secondaryAccent || "#c0392b",
        life: FLOATING_TEXT_LIFE,
        maxLife: FLOATING_TEXT_LIFE,
      });
    }
  }

  private drawItem(c: CanvasRenderingContext2D, item: FlyingItem): void {
    const { brand } = this.ctx;
    const half = item.size / 2;

    if (item.asset?.image) {
      c.drawImage(item.asset.image, item.x - half, item.y - half, item.size, item.size);
      return;
    }

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

  private drawTrail(c: CanvasRenderingContext2D): void {
    if (this.trail.length < 2) return;
    c.save();
    c.strokeStyle = this.ctx.brand.accent;
    c.lineCap = "round";
    c.lineJoin = "round";
    for (let i = 1; i < this.trail.length; i++) {
      const prev = this.trail[i - 1]!;
      const curr = this.trail[i]!;
      const alpha = Math.max(0, curr.life / TRAIL_POINT_LIFE);
      c.globalAlpha = alpha * 0.8;
      c.lineWidth = 3 + alpha * 5;
      c.beginPath();
      c.moveTo(prev.x, prev.y);
      c.lineTo(curr.x, curr.y);
      c.stroke();
    }
    c.restore();
  }
}

/** Shortest distance from point (px,py) to the segment (x1,y1)-(x2,y2). */
function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
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

function fontFamilyForCanvas(fontFamily: string): string {
  return fontFamily || "system-ui, sans-serif";
}

export function createSliceGame(): GameModule {
  return new SliceGame();
}
