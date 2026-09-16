// lib/runtime/games/whack.ts
//
// Whack-a-Mole: products pop up out of holes arranged in a grid and duck
// back down after a short window; tap them before they do. A minority of
// pops are decoys (hazards) that cost points instead. Build spec §13 /
// capability schema §2 (lib/capabilities/whack.json).
//
// Tuning knobs honored:
//   holeCount    — how many holes are in the grid
//   popRateHz    — how often a new pop is attempted into a free hole
//   upTimeSec    — how long a popped item stays up before ducking away
//   durationSec  — total run time
//   hazardRatio  — fraction of pops that are hazards instead of moles
//
// Roles honored:
//   mole            — required (fallback "none"); the products that pop up
//   hazard          — optional; if unfilled, hazards still pop (per
//                     hazardRatio) as a generated shape so the mechanic
//                     works even with zero hazard assets
//   stageBackground — optional; brand gradient if unfilled

import type { GameModule, RuntimeContext, LoadedAsset } from "@/lib/runtime/gameModule";

// Scoring constants. Chosen so maxRealisticScore() at the capability's
// *default* tuning (popRateHz 1.1, durationSec 35, hazardRatio 0.2) lands
// close to whack.json's scoring.maxRealistic (1040):
//   totalPops      = 1.1 * 35                         = 38.5
//   molePops       = 38.5 * (1 - 0.2)                  = 30.8
//   maxRealistic   = 30.8 * POINTS_PER_WHACK * REALISTIC_HIT_RATE
//                  = 30.8 * 45 * 0.75                  ≈ 1040
const POINTS_PER_WHACK = 45;
const HAZARD_PENALTY = 35;
const REALISTIC_HIT_RATE = 0.75; // fraction of pops a competent player taps in time

const HOLE_ITEM_SIZE = 68;
const HOLE_RADIUS_FACTOR = 0.42; // fraction of cell size drawn as the burrow
const HIT_PAD_FACTOR = 1.15; // generous tap target for touch
const POP_ANIM_SEC = 0.12;
const GRID_PADDING = 20;
const FLOATING_TEXT_LIFE = 0.6;
const FLOAT_RISE_PX = 26;

interface Hole {
  cx: number;
  cy: number;
  occupant: {
    kind: "mole" | "hazard";
    asset: LoadedAsset | null;
    fullDuration: number;
    timer: number;
  } | null;
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
  const popRateHz = tuning.popRateHz ?? 1.1;
  const durationSec = tuning.durationSec ?? 35;
  const hazardRatio = clamp01(tuning.hazardRatio ?? 0.2);

  const totalPops = popRateHz * durationSec;
  const molePops = totalPops * (1 - hazardRatio);
  return Math.round(molePops * POINTS_PER_WHACK * REALISTIC_HIT_RATE);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

class WhackGame implements GameModule {
  id: "whack" = "whack";

  private ctx!: RuntimeContext;
  private holes: Hole[] = [];
  private cellSize = 100;
  private spawnTimer = 0;
  private elapsed = 0;
  private ended = false;
  private floatingTexts: FloatingText[] = [];

  private moles: LoadedAsset[] = [];
  private hazards: LoadedAsset[] = [];
  private hasStageBackgroundFallback = false;

  init(ctx: RuntimeContext): void {
    this.ctx = ctx;
    this.spawnTimer = 0;
    this.elapsed = 0;
    this.ended = false;
    this.floatingTexts = [];

    this.moles = ctx.roles.mole?.assets ?? [];
    this.hazards = ctx.roles.hazard?.assets ?? [];
    this.hasStageBackgroundFallback = !ctx.roles.stageBackground?.assets.length;

    const holeCount = clampInt(ctx.tuning.holeCount ?? 7, 4, 9);
    this.holes = [];
    for (let i = 0; i < holeCount; i++) {
      this.holes.push({ cx: 0, cy: 0, occupant: null });
    }
    this.layoutHoles();
  }

  update(dt: number): void {
    if (this.ended) return;
    const { tuning, input, random } = this.ctx;

    this.elapsed += dt;

    // --- pop timers ---
    for (const hole of this.holes) {
      if (!hole.occupant) continue;
      hole.occupant.timer -= dt;
      if (hole.occupant.timer <= 0) hole.occupant = null; // ducked away unmissed, no penalty
    }

    // --- spawning ---
    const popRateHz = tuning.popRateHz ?? 1.1;
    const popIntervalSec = popRateHz > 0 ? 1 / popRateHz : Infinity;
    this.spawnTimer += dt;
    while (this.spawnTimer >= popIntervalSec) {
      this.spawnTimer -= popIntervalSec;
      this.tryPop();
    }

    // --- input: tap a hole ---
    if (input.justPressed) {
      const hitRadius = (this.cellSize * HOLE_RADIUS_FACTOR + HOLE_ITEM_SIZE / 2) * 0.5 * HIT_PAD_FACTOR;
      for (const hole of this.holes) {
        if (!hole.occupant) continue;
        const dx = input.pointerX - hole.cx;
        const dy = input.pointerY - hole.cy;
        if (dx * dx + dy * dy <= hitRadius * hitRadius) {
          this.whack(hole);
          break; // one tap hits at most one hole
        }
      }
    }

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

    for (const hole of this.holes) {
      this.drawHole(c, hole);
    }

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
    this.holes = [];
    this.floatingTexts = [];
  }

  maxRealisticScore(tuning: Record<string, number>): number {
    return maxRealisticScore(tuning);
  }

  private layoutHoles(): void {
    const { stage } = this.ctx;
    const count = this.holes.length;
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);

    const cellSize = Math.floor(
      Math.min((stage.width - GRID_PADDING * 2) / cols, (stage.height - GRID_PADDING * 2) / rows),
    );
    this.cellSize = Math.max(48, cellSize);
    const gridWidth = this.cellSize * cols;
    const gridHeight = this.cellSize * rows;
    const originX = (stage.width - gridWidth) / 2;
    const originY = (stage.height - gridHeight) / 2;

    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const hole = this.holes[i]!;
      hole.cx = originX + col * this.cellSize + this.cellSize / 2;
      hole.cy = originY + row * this.cellSize + this.cellSize / 2;
    }
  }

  private tryPop(): void {
    const free = this.holes.filter((h) => !h.occupant);
    if (free.length === 0) return;
    const hole = free[Math.floor(this.ctx.random() * free.length)]!;

    const { tuning, random } = this.ctx;
    const hazardRatio = clamp01(tuning.hazardRatio ?? 0.2);
    const wantHazard = random() < hazardRatio;
    const kind: "mole" | "hazard" = wantHazard ? "hazard" : "mole";
    const pool = kind === "hazard" ? this.hazards : this.moles;
    const asset = pool.length > 0 ? pool[Math.floor(random() * pool.length)]! : null;

    const upTimeSec = tuning.upTimeSec ?? 0.9;
    hole.occupant = { kind, asset: asset ?? null, fullDuration: upTimeSec, timer: upTimeSec };
  }

  private whack(hole: Hole): void {
    const occupant = hole.occupant;
    if (!occupant) return;
    hole.occupant = null;

    if (occupant.kind === "mole") {
      this.ctx.addScore(POINTS_PER_WHACK);
      this.floatingTexts.push({
        x: hole.cx,
        y: hole.cy - this.cellSize * 0.3,
        text: `+${POINTS_PER_WHACK}`,
        color: this.ctx.brand.accent,
        life: FLOATING_TEXT_LIFE,
        maxLife: FLOATING_TEXT_LIFE,
      });
    } else {
      this.ctx.addScore(-HAZARD_PENALTY);
      this.floatingTexts.push({
        x: hole.cx,
        y: hole.cy - this.cellSize * 0.3,
        text: `-${HAZARD_PENALTY}`,
        color: this.ctx.brand.secondaryAccent || "#c0392b",
        life: FLOATING_TEXT_LIFE,
        maxLife: FLOATING_TEXT_LIFE,
      });
    }
  }

  private drawHole(c: CanvasRenderingContext2D, hole: Hole): void {
    const { brand } = this.ctx;
    const holeRadius = this.cellSize * HOLE_RADIUS_FACTOR;

    // The burrow itself — a generated dark ellipse, never asset-dependent,
    // so the grid reads clearly even before anything has popped.
    c.save();
    c.beginPath();
    c.ellipse(hole.cx, hole.cy + holeRadius * 0.2, holeRadius, holeRadius * 0.55, 0, 0, Math.PI * 2);
    c.fillStyle = shade(brand.foreground, 0.65) + "aa";
    c.fill();
    c.restore();

    if (!hole.occupant) return;

    const elapsedSinceSpawn = hole.occupant.fullDuration - hole.occupant.timer;
    let scale = 1;
    if (elapsedSinceSpawn < POP_ANIM_SEC) {
      scale = elapsedSinceSpawn / POP_ANIM_SEC;
    } else if (hole.occupant.timer < POP_ANIM_SEC) {
      scale = hole.occupant.timer / POP_ANIM_SEC;
    }
    scale = Math.max(0, Math.min(1, scale));
    if (scale <= 0) return;

    const size = HOLE_ITEM_SIZE * scale;
    const half = size / 2;
    const cy = hole.cy - holeRadius * 0.15;

    if (hole.occupant.asset?.image) {
      c.drawImage(hole.occupant.asset.image, hole.cx - half, cy - half, size, size);
      return;
    }

    c.save();
    c.beginPath();
    if (hole.occupant.kind === "hazard") {
      c.fillStyle = brand.secondaryAccent || "#3a3a3a";
      roundedRect(c, hole.cx - half, cy - half, size, size, 10 * scale);
      c.fill();
    } else {
      c.fillStyle = brand.accent;
      c.arc(hole.cx, cy, half, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }
}

function roundedRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
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

export function createWhackGame(): GameModule {
  return new WhackGame();
}
