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
import { drawAssetContain } from "@/lib/runtime/games/spriteRender";

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
const HAMMER_ANIM_SEC = 0.32;
const HAMMER_SWING_FRACTION = 0.45; // portion of HAMMER_ANIM_SEC spent swinging down; the rest is impact, recoil and fade
// Angles measured from "handle straight up, head raised above it", negative =
// counter-clockwise. The hammer pivots around a fixed grip (the hand) placed
// up and to the right of the target, so the head arcs down onto it.
const HAMMER_START_DEG = -40; // wound up: head raised high above the target
const HAMMER_IMPACT_DEG = -135; // struck: head down on the target, handle angled up to the hand
const HAMMER_RECOIL_DEG = 16; // slight bounce back off the target as it fades

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

/** A brief hammer-strike effect at wherever the player just tapped. */
interface HammerHit {
  x: number;
  y: number;
  life: number;
  maxLife: number;
  /** False for a whiff — same swing, weaker impact burst. */
  landed: boolean;
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
  private hammerHits: HammerHit[] = [];
  private groundTexture: CanvasPattern | null = null;

  private moles: LoadedAsset[] = [];
  private hazards: LoadedAsset[] = [];
  private hasStageBackgroundFallback = false;

  init(ctx: RuntimeContext): void {
    this.ctx = ctx;
    this.spawnTimer = 0;
    this.elapsed = 0;
    this.ended = false;
    this.floatingTexts = [];
    this.hammerHits = [];
    this.groundTexture = null;

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
    const { tuning, input } = this.ctx;

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
      let struck: Hole | null = null;
      for (const hole of this.holes) {
        if (!hole.occupant) continue;
        const dx = input.pointerX - hole.cx;
        const dy = input.pointerY - hole.cy;
        if (dx * dx + dy * dy <= hitRadius * hitRadius) {
          struck = hole; // one tap hits at most one hole
          break;
        }
      }

      // The hammer swings on every tap. A miss still strikes — where the
      // player actually tapped — so a whiff reads as a missed swing rather
      // than a dead click.
      this.hammerHits.push({
        x: struck ? struck.cx : input.pointerX,
        y: struck ? struck.cy : input.pointerY,
        life: HAMMER_ANIM_SEC,
        maxLife: HAMMER_ANIM_SEC,
        landed: struck !== null,
      });

      if (struck) this.whack(struck);
    }

    this.floatingTexts = this.floatingTexts.filter((t) => {
      t.life -= dt;
      return t.life > 0;
    });
    this.hammerHits = this.hammerHits.filter((h) => {
      h.life -= dt;
      return h.life > 0;
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

      const texture = this.ensureGroundTexture(c);
      if (texture) {
        c.save();
        c.globalAlpha = 0.5;
        c.fillStyle = texture;
        c.fillRect(0, 0, stage.width, stage.height);
        c.restore();
      }
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

    for (const hit of this.hammerHits) {
      this.drawHammer(c, hit);
    }
  }

  teardown(): void {
    this.holes = [];
    this.floatingTexts = [];
    this.hammerHits = [];
    this.groundTexture = null;
  }

  /** A small tiled speckle-and-scuff pattern, generated once per game instance
   * and reused as a fillRect pattern — cheaper than redrawing speckles in a
   * loop every frame. Only used behind the generated gradient fallback; a
   * real stageBackground asset already has its own texture. */
  private ensureGroundTexture(c: CanvasRenderingContext2D): CanvasPattern | null {
    if (this.groundTexture) return this.groundTexture;

    const tile = document.createElement("canvas");
    tile.width = 56;
    tile.height = 56;
    const tc = tile.getContext("2d");
    if (!tc) return null;

    const { brand } = this.ctx;
    const dark = shade(brand.foreground, 0.7);
    tc.strokeStyle = dark + "33";
    tc.lineWidth = 2;
    tc.beginPath();
    tc.moveTo(0, 18);
    tc.lineTo(56, 12);
    tc.moveTo(4, 44);
    tc.lineTo(50, 50);
    tc.stroke();

    tc.fillStyle = dark + "40";
    for (const [x, y, r] of [
      [10, 8, 2.4],
      [40, 20, 1.6],
      [22, 34, 2],
      [48, 42, 1.8],
    ] as const) {
      tc.beginPath();
      tc.arc(x, y, r, 0, Math.PI * 2);
      tc.fill();
    }

    this.groundTexture = c.createPattern(tile, "repeat");
    return this.groundTexture;
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
      if (occupant.asset) this.ctx.recordEngagement(occupant.asset.id);
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
    const cx = hole.cx;
    const cy = hole.cy + holeRadius * 0.2;

    // Depth, built from back to front, never asset-dependent so the grid
    // reads clearly even before anything has popped:
    //   1. a soft cast shadow (the mound blocking light behind it)
    //   2. a raised dirt mound around the hole
    //   3. the burrow interior, always much darker than the ground and
    //      lighter toward the near (bottom) lip where light spills in
    //   4. a lit highlight along the mound's back edge
    // Everything is derived from brand.background so the hole stays a dark
    // void on a light brand and clamps to black (against a lightened mound)
    // on a dark one — never a light disc that reads as a lid.
    const lightGround = brightness(brand.background) > 0.5;

    c.save();
    c.beginPath();
    c.ellipse(cx, cy + holeRadius * 0.3, holeRadius * 1.2, holeRadius * 0.45, 0, 0, Math.PI * 2);
    c.fillStyle = "rgba(0,0,0,0.16)";
    c.fill();
    c.restore();

    c.save();
    c.beginPath();
    c.ellipse(cx, cy, holeRadius * 1.14, holeRadius * 0.68, 0, 0, Math.PI * 2);
    c.fillStyle = shade(brand.background, lightGround ? -0.12 : 0.16);
    c.fill();
    c.restore();

    const burrowGradient = c.createRadialGradient(cx, cy + holeRadius * 0.22, holeRadius * 0.06, cx, cy, holeRadius);
    burrowGradient.addColorStop(0, shade(brand.background, lightGround ? -0.52 : -0.9));
    burrowGradient.addColorStop(1, shade(brand.background, lightGround ? -0.82 : -1));
    c.save();
    c.beginPath();
    c.ellipse(cx, cy, holeRadius, holeRadius * 0.55, 0, 0, Math.PI * 2);
    c.fillStyle = burrowGradient;
    c.fill();
    c.restore();

    c.save();
    c.beginPath();
    c.ellipse(cx, cy, holeRadius * 1.14, holeRadius * 0.68, 0, Math.PI, Math.PI * 2);
    c.strokeStyle = "#ffffff66";
    c.lineWidth = 2;
    c.stroke();
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
    const itemCy = hole.cy - holeRadius * 0.15;

    if (hole.occupant.asset?.image) {
      drawAssetContain(c, hole.occupant.asset, hole.cx - half, itemCy - half, size, size);
      this.drawPointBadge(c, hole.occupant.kind, hole.cx, itemCy - half, scale);
      return;
    }

    c.save();
    c.beginPath();
    if (hole.occupant.kind === "hazard") {
      c.fillStyle = brand.secondaryAccent || "#3a3a3a";
      roundedRect(c, hole.cx - half, itemCy - half, size, size, 10 * scale);
      c.fill();
    } else {
      c.fillStyle = brand.accent;
      c.arc(hole.cx, itemCy, half, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();

    this.drawPointBadge(c, hole.occupant.kind, hole.cx, itemCy - half, scale);
  }

  /** What this pop is worth, on a pill above it — so a player can read the
   * cost of a decoy before swinging rather than only after being penalised.
   * Rides the same pop-in/duck-out `scale` as the sprite it labels. */
  private drawPointBadge(
    c: CanvasRenderingContext2D,
    kind: "mole" | "hazard",
    cx: number,
    itemTop: number,
    scale: number,
  ): void {
    const { brand } = this.ctx;
    const text = kind === "mole" ? `+${POINTS_PER_WHACK}` : `-${HAZARD_PENALTY}`;
    const fill = kind === "mole" ? brand.accent : brand.secondaryAccent || "#c0392b";
    const fontSize = Math.max(11, this.cellSize * 0.13) * scale;
    if (fontSize < 6) return;

    c.save();
    c.font = `800 ${fontSize}px ${fontFamilyForCanvas(brand.fontFamily)}`;
    c.textAlign = "center";
    c.textBaseline = "middle";

    const padX = fontSize * 0.55;
    const width = c.measureText(text).width + padX * 2;
    const height = fontSize * 1.5;
    // Top-row pops sit close enough to the stage edge that the pill would
    // otherwise clip off-canvas.
    const cy = Math.max(height / 2 + 2, itemTop - height * 0.75);

    c.fillStyle = "rgba(0,0,0,0.18)";
    roundedRect(c, cx - width / 2, cy - height / 2 + 2, width, height, height / 2);
    c.fill();

    c.fillStyle = fill;
    roundedRect(c, cx - width / 2, cy - height / 2, width, height, height / 2);
    c.fill();

    c.fillStyle = brightness(fill) > 0.6 ? "#111111" : "#ffffff";
    c.fillText(text, cx, cy + fontSize * 0.05);
    c.restore();
  }

  /** A quick vector hammer — no image asset needed, matching the
   * generated-shape style already used for the burrow/hazard fallback.
   *
   * The sprite is a normal hammer: handle rising from the grip, head sitting
   * on top of it. The grip is a *fixed* point up and to the right of the
   * target, and the hammer pivots around it, so the head starts raised high
   * above the target and arcs down onto it — the head travels the whole
   * distance rather than the sprite just tilting in place. Impact is sold by
   * accelerating into it, squashing the head against the target, a burst on
   * the ground plane, and a small recoil as it lifts away. */
  private drawHammer(c: CanvasRenderingContext2D, hit: HammerHit): void {
    const t = 1 - hit.life / hit.maxLife;
    const swinging = t < HAMMER_SWING_FRACTION;
    const swingT = Math.min(1, t / HAMMER_SWING_FRACTION);
    const afterT = swinging ? 0 : (t - HAMMER_SWING_FRACTION) / (1 - HAMMER_SWING_FRACTION);

    const angleDeg = swinging
      ? HAMMER_START_DEG + (HAMMER_IMPACT_DEG - HAMMER_START_DEG) * swingT * swingT // accelerate into the hit
      : HAMMER_IMPACT_DEG + HAMMER_RECOIL_DEG * (1 - (1 - afterT) * (1 - afterT));
    const alpha = 1 - afterT * afterT;
    if (alpha <= 0) return;

    const headDist = this.cellSize * 0.72; // grip → head centre
    const headW = this.cellSize * 0.42;
    const headH = this.cellSize * 0.24;
    // The grip is fixed wherever the hand would have to be for the head to
    // land centred on the target at the impact angle.
    const impactAngle = (HAMMER_IMPACT_DEG * Math.PI) / 180;
    const gripX = hit.x - headDist * Math.sin(impactAngle);
    const gripY = hit.y + headDist * Math.cos(impactAngle);

    if (!swinging) this.drawImpactBurst(c, hit, afterT, alpha);

    c.save();
    c.globalAlpha = alpha;
    c.translate(gripX, gripY);
    c.rotate((angleDeg * Math.PI) / 180);

    c.fillStyle = "#8a5a34";
    roundedRect(c, -this.cellSize * 0.042, -headDist + headH * 0.2, this.cellSize * 0.084, headDist, 4);
    c.fill();

    // Head, flattening against the target on contact and relaxing over the hold.
    const squash = swinging ? 1 : 1 - 0.18 * Math.max(0, 1 - afterT * 4);
    c.translate(0, -headDist);
    c.scale(1 + (1 - squash) * 0.7, squash);

    c.fillStyle = this.ctx.brand.accent;
    roundedRect(c, -headW / 2, -headH / 2, headW, headH, 5);
    c.fill();
    c.fillStyle = "#ffffff38";
    roundedRect(c, -headW / 2 + 3, -headH / 2 + 3, headW - 6, headH * 0.3, 3);
    c.fill();

    c.restore();
  }

  /** The shock of the landing, spreading along the ground plane (same ellipse
   * squash as the holes) — full strength on a landed hit, faint dust on a whiff. */
  private drawImpactBurst(c: CanvasRenderingContext2D, hit: HammerHit, afterT: number, alpha: number): void {
    const burstT = Math.min(1, afterT * 2.2);
    const radius = this.cellSize * (hit.landed ? 0.5 : 0.32) * (0.35 + burstT * 0.65);

    c.save();
    c.globalAlpha = alpha * (1 - burstT) * (hit.landed ? 0.9 : 0.45);
    c.strokeStyle = hit.landed ? this.ctx.brand.accent : shade(this.ctx.brand.foreground, 0.45);
    c.lineWidth = hit.landed ? 3 : 2;
    c.lineCap = "round";

    c.beginPath();
    c.ellipse(hit.x, hit.y, radius, radius * 0.55, 0, 0, Math.PI * 2);
    c.stroke();

    for (let i = 0; i < 4; i++) {
      const a = (Math.PI / 4) * (i * 2 + 1);
      c.beginPath();
      c.moveTo(hit.x + Math.cos(a) * radius * 0.75, hit.y + Math.sin(a) * radius * 0.75 * 0.55);
      c.lineTo(hit.x + Math.cos(a) * radius * 1.15, hit.y + Math.sin(a) * radius * 1.15 * 0.55);
      c.stroke();
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

/** Perceived brightness (0..1) of a #rrggbb hex colour. */
function brightness(hex: string): number {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return 0.5;
  const num = parseInt(clean, 16);
  return (0.299 * ((num >> 16) & 0xff) + 0.587 * ((num >> 8) & 0xff) + 0.114 * (num & 0xff)) / 255;
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
