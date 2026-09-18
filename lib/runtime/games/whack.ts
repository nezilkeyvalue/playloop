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
import { drawAssetContain, drawBrandBackground, withDropShadow } from "@/lib/runtime/games/spriteRender";
import { drawHazardShape, drawMoleCreatureShape } from "@/lib/runtime/games/shapeLibrary";

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
// Both pairs are fractions of cellSize, sized so a hole's mound (the wider
// of the two) stays well under half the cell spacing — mound RADIUS 0.35
// means a 0.7*cellSize diameter, leaving a clear gap to its neighbours
// instead of adjacent mounds overlapping into one continuous ridge (the
// previous factors put the mound diameter at 1.28x cellSize, guaranteeing
// overlap regardless of grid spacing).
const HOLE_RADIUS_X_FACTOR = 0.21; // the dark opening
const HOLE_RADIUS_Y_FACTOR = 0.132;
const MOUND_RADIUS_X_FACTOR = 0.35; // the raised dirt rim around it
const MOUND_RADIUS_Y_FACTOR = 0.22;
const HIT_PAD_FACTOR = 1.15; // generous tap target for touch
const RISE_SEC = 0.22; // slide-up/down duration — was a flat 0.12s linear scale, no travel
const CLIP_UNTIL = 0.5; // below this fraction of rise, the mole is still clipped inside the hole
const HIT_SINK_SEC = 0.16; // bonk-and-sink duration once whacked, before the hole clears
const GRID_PADDING = 20;
const FLOATING_TEXT_LIFE = 0.6;
const FLOAT_RISE_PX = 26;
const PARTICLES_PER_HIT = 9;
const HAMMER_SWING_SEC = 0.4; // wind-up + strike + recoil + settle needs more room than a bare slam
const HAMMER_HEAD_SIZE = 46;

// Fixed, not brand-derived — a hole is dirt regardless of the brand's own
// palette, the same reasoning shooter.ts's starfield stays a fixed dark
// space palette instead of tinting with brand.background (a bright pink
// brand background forced onto "soil" would read as a bug, not a theme).
const DIRT_LIGHT = "#C9A063";
const DIRT_MID = "#9C7239";
const DIRT_DARK = "#5B3E22";
const HOLE_DEEP = "#1a1006";

interface Occupant {
  kind: "mole" | "hazard";
  asset: LoadedAsset | null;
  fullDuration: number;
  timer: number;
  /** Set the instant a player successfully taps this occupant — switches
   * drawHole into the short bonk-and-sink animation instead of the normal
   * rise/duck cycle, and update() clears the hole once it finishes. */
  hitT: number | null;
}

interface Hole {
  cx: number;
  cy: number;
  occupant: Occupant | null;
}

interface FloatingText {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  maxLife: number;
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

interface HammerSwing {
  x: number;
  y: number;
  t: number; // 0..1 through HAMMER_SWING_SEC
}

/** Standard "overshoot then settle" easing — used for the mole's rise so
 * popping up reads as a lively spring rather than a linear slide. */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}

function easeInQuad(t: number): number {
  return t * t;
}

// Hammer swing phases, as fractions of HAMMER_SWING_SEC — a real hammering
// motion is wind-up, strike, recoil, settle, not a single slam-and-retract
// (which read as a blip rather than a hit). `travel` follows the same
// convention drawHammer already used (0 = fully raised, 1 = at the target),
// but now ranges slightly negative during anticipation (raised even higher
// than idle rest, i.e. the wind-up) and dips back up after impact for the
// recoil bounce before settling back to idle-raised.
const HAMMER_PHASE_ANTICIPATE = 0.16;
const HAMMER_PHASE_STRIKE = 0.42;
const HAMMER_PHASE_RECOIL = 0.66;

function hammerPose(t: number): { travel: number; angle: number; squash: number } {
  const IDLE_TILT = -0.06;
  let travel: number;
  let angle: number;

  if (t < HAMMER_PHASE_ANTICIPATE) {
    // Wind-up: lift higher than rest and lean back, gathering to strike.
    const p = t / HAMMER_PHASE_ANTICIPATE;
    const eased = 1 - Math.pow(1 - p, 2);
    travel = -0.18 * eased;
    angle = IDLE_TILT + -0.22 * eased;
  } else if (t < HAMMER_PHASE_STRIKE) {
    // Strike: fast, accelerating drop from the wind-up to full contact.
    const p = (t - HAMMER_PHASE_ANTICIPATE) / (HAMMER_PHASE_STRIKE - HAMMER_PHASE_ANTICIPATE);
    const eased = p * p;
    travel = -0.18 + 1.18 * eased;
    angle = IDLE_TILT + -0.22 * (1 - eased);
  } else if (t < HAMMER_PHASE_RECOIL) {
    // Recoil: a small bounce back up off the impact, like a real mallet
    // rebounding rather than freezing on contact.
    const p = (t - HAMMER_PHASE_STRIKE) / (HAMMER_PHASE_RECOIL - HAMMER_PHASE_STRIKE);
    const eased = 1 - Math.pow(1 - p, 2);
    travel = 1 - 0.82 * eased;
    angle = IDLE_TILT + 0.08 * eased;
  } else {
    // Settle: ease the recoil bounce back down to the raised idle pose.
    const p = (t - HAMMER_PHASE_RECOIL) / (1 - HAMMER_PHASE_RECOIL);
    const eased = p * p * (3 - 2 * p);
    travel = 0.18 * (1 - eased);
    angle = IDLE_TILT + 0.08 * (1 - eased);
  }

  // A sharp squash right at the impact instant (t crossing HAMMER_PHASE_STRIKE),
  // independent of the travel curve's own post-impact bounce.
  const squash = Math.max(0, 1 - Math.abs(t - HAMMER_PHASE_STRIKE) / 0.05);
  return { travel, angle, squash };
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
  private particles: Particle[] = [];
  private hammer: HammerSwing | null = null;
  /** A hole tapped this swing, not yet resolved — resolves (score, particles,
   * the mole's own bonk reaction) once the hammer's animation actually
   * reaches HAMMER_PHASE_STRIKE, not at the instant of the tap. Without
   * this, the score/particle burst fired the moment you tapped, while the
   * hammer was still mid wind-up — the mole looked hit before the hammer
   * ever arrived. */
  private pendingWhack: Hole | null = null;

  private moles: LoadedAsset[] = [];
  private hazards: LoadedAsset[] = [];
  private hasStageBackgroundFallback = false;

  init(ctx: RuntimeContext): void {
    this.ctx = ctx;
    this.spawnTimer = 0;
    this.elapsed = 0;
    this.ended = false;
    this.floatingTexts = [];
    this.particles = [];
    this.hammer = null;
    this.pendingWhack = null;

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
      const occupant = hole.occupant;
      if (!occupant) continue;
      if (occupant.hitT !== null) {
        // Already whacked — sinking through the short bonk animation
        // (drawHole handles the visual), not the normal duck-away timer.
        occupant.hitT += dt;
        if (occupant.hitT >= HIT_SINK_SEC) hole.occupant = null;
        continue;
      }
      occupant.timer -= dt;
      if (occupant.timer <= 0) hole.occupant = null; // ducked away unmissed, no penalty
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
      const hitRadius = (this.cellSize * HOLE_RADIUS_X_FACTOR + HOLE_ITEM_SIZE / 2) * 0.5 * HIT_PAD_FACTOR;
      let hitHole: Hole | null = null;
      for (const hole of this.holes) {
        if (!hole.occupant || hole.occupant.hitT !== null) continue;
        const dx = input.pointerX - hole.cx;
        const dy = input.pointerY - hole.cy;
        if (dx * dx + dy * dy <= hitRadius * hitRadius) {
          hitHole = hole;
          break; // one tap hits at most one hole
        }
      }
      // The hammer slams down wherever the player tapped, hit or miss — a
      // whiffed swing is still feedback that the tap registered. A landed
      // hit snaps the slam to the hole's centre instead of the raw tap
      // point, so the hammer visually lands square on the mole rather than
      // wherever inside the generous touch-friendly hit pad the tap fell.
      // A fast double-tap can land before the previous swing ever reaches
      // HAMMER_PHASE_STRIKE — resolve it now rather than silently dropping
      // that hit when this new swing overwrites pendingWhack below.
      if (this.pendingWhack) this.whack(this.pendingWhack);
      this.hammer = { x: hitHole?.cx ?? input.pointerX, y: hitHole?.cy ?? input.pointerY, t: 0 };
      this.pendingWhack = hitHole;
    }

    if (this.hammer) {
      const wasBeforeStrike = this.hammer.t < HAMMER_PHASE_STRIKE;
      this.hammer.t += dt / HAMMER_SWING_SEC;
      // Resolve the actual hit exactly when the hammer's own animation
      // reaches the target, not at the instant of the tap — see
      // pendingWhack's doc comment.
      if (this.pendingWhack && wasBeforeStrike && this.hammer.t >= HAMMER_PHASE_STRIKE) {
        this.whack(this.pendingWhack);
        this.pendingWhack = null;
      }
      if (this.hammer.t >= 1) this.hammer = null;
    }

    this.particles = this.particles.filter((p) => {
      p.vy += 360 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      return p.life > 0;
    });

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
      drawBrandBackground(c, stage.width, stage.height, brand.background, brand.accent);
    } else {
      const bg = this.ctx.roles.stageBackground?.assets[0]?.image ?? null;
      if (bg) c.drawImage(bg, 0, 0, stage.width, stage.height);
    }

    for (const hole of this.holes) {
      this.drawHole(c, hole);
    }

    for (const p of this.particles) {
      c.save();
      c.globalAlpha = Math.max(0, p.life / p.maxLife);
      c.fillStyle = p.color;
      c.beginPath();
      c.arc(p.x, p.y, 3, 0, Math.PI * 2);
      c.fill();
      c.restore();
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

    if (this.hammer) this.drawHammer(c, this.hammer);
  }

  teardown(): void {
    this.holes = [];
    this.floatingTexts = [];
    this.particles = [];
    this.hammer = null;
    this.pendingWhack = null;
  }

  timeRemaining(): { secondsLeft: number; totalSeconds: number } | null {
    const total = this.ctx.tuning.durationSec ?? 40;
    return { secondsLeft: Math.max(0, total - this.elapsed), totalSeconds: total };
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
    hole.occupant = { kind, asset: asset ?? null, fullDuration: upTimeSec, timer: upTimeSec, hitT: null };
  }

  private whack(hole: Hole): void {
    const occupant = hole.occupant;
    if (!occupant || occupant.hitT !== null) return;
    // Don't clear the hole yet — drawHole plays a brief bonk-and-sink
    // animation first (update()'s hitT-driven branch clears it once that
    // finishes), so a successful tap reads as an impact, not a disappearance.
    occupant.hitT = 0;

    if (occupant.kind === "mole") {
      this.ctx.addScore(POINTS_PER_WHACK);
      this.ctx.sound.play("success");
      // A generated-shape fallback (no real asset) is never "engaged with" —
      // same rule as every other template's hazards/decoys/synthesized-
      // filler exclusion (see CLAUDE.md).
      if (occupant.asset) this.ctx.recordEngagement(occupant.asset.id);
      this.spawnParticles(hole.cx, hole.cy - this.cellSize * 0.2, this.ctx.brand.accent);
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
      this.ctx.sound.play("fail");
      this.spawnParticles(hole.cx, hole.cy - this.cellSize * 0.2, "#c94b4b");
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

  private spawnParticles(x: number, y: number, color: string): void {
    const { random } = this.ctx;
    for (let i = 0; i < PARTICLES_PER_HIT; i++) {
      const angle = (i / PARTICLES_PER_HIT) * Math.PI * 2 + random() * 0.4;
      const speed = 70 + random() * 110;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 70,
        life: 0.3 + random() * 0.25,
        maxLife: 0.55,
        color,
      });
    }
  }

  /** Draws one hole: a raised dirt mound with a dark opening (the "3D
   * burrow"), then whatever's currently occupying it. An occupant's
   * vertical position — not just its scale — animates: it slides up out
   * of the dark opening as it pops (clipped to the opening while still
   * mostly below ground, per CLIP_UNTIL, so it genuinely looks like it's
   * emerging rather than fading in above the hole), and slides back down
   * into it when it ducks away or gets whacked. */
  private drawHole(c: CanvasRenderingContext2D, hole: Hole): void {
    const holeRadiusX = this.cellSize * HOLE_RADIUS_X_FACTOR;
    const holeRadiusY = this.cellSize * HOLE_RADIUS_Y_FACTOR;
    const moundRadiusX = this.cellSize * MOUND_RADIUS_X_FACTOR;
    const moundRadiusY = this.cellSize * MOUND_RADIUS_Y_FACTOR;

    // Ambient contact shadow, grounding the mound against the backdrop.
    c.save();
    c.globalAlpha = 0.18;
    c.fillStyle = "#000000";
    c.beginPath();
    c.ellipse(hole.cx, hole.cy + moundRadiusY * 0.35, moundRadiusX * 1.05, moundRadiusY * 0.7, 0, 0, Math.PI * 2);
    c.fill();
    c.restore();

    // Raised dirt mound — a radial gradient standing in for a directional
    // light hitting a bump, so the ring around the opening reads as raised
    // ground rather than a flat coloured halo.
    const moundGrad = c.createRadialGradient(
      hole.cx - moundRadiusX * 0.25,
      hole.cy - moundRadiusY * 0.3,
      moundRadiusX * 0.1,
      hole.cx,
      hole.cy,
      moundRadiusX,
    );
    moundGrad.addColorStop(0, DIRT_LIGHT);
    moundGrad.addColorStop(0.6, DIRT_MID);
    moundGrad.addColorStop(1, DIRT_DARK);
    c.fillStyle = moundGrad;
    c.beginPath();
    c.ellipse(hole.cx, hole.cy, moundRadiusX, moundRadiusY, 0, 0, Math.PI * 2);
    c.fill();

    // The dark opening — a radial gradient sinking to near-black at the
    // centre, the actual "looking down into a hole" cue.
    const holeGrad = c.createRadialGradient(
      hole.cx,
      hole.cy - holeRadiusY * 0.2,
      1,
      hole.cx,
      hole.cy,
      holeRadiusX,
    );
    holeGrad.addColorStop(0, HOLE_DEEP);
    holeGrad.addColorStop(1, DIRT_DARK);
    c.fillStyle = holeGrad;
    c.beginPath();
    c.ellipse(hole.cx, hole.cy, holeRadiusX, holeRadiusY, 0, 0, Math.PI * 2);
    c.fill();

    // A thin lit lip along the near (bottom) rim of the opening — the
    // single highlight that sells the opening as having depth/a raised
    // edge, rather than being a flat dark ellipse painted on the mound.
    c.save();
    c.globalAlpha = 0.5;
    c.strokeStyle = DIRT_LIGHT;
    c.lineWidth = Math.max(1, holeRadiusY * 0.16);
    c.beginPath();
    c.ellipse(hole.cx, hole.cy, holeRadiusX * 0.96, holeRadiusY * 0.96, 0, Math.PI * 0.08, Math.PI * 0.92);
    c.stroke();
    c.restore();

    const occupant = hole.occupant;
    if (!occupant) return;

    if (occupant.hitT !== null) {
      this.drawBonkedOccupant(c, hole, occupant, holeRadiusX, holeRadiusY);
      return;
    }

    // linearProgress drives the clip cutoff (still emerging vs. fully out);
    // eased drives the actual scale/position, so the pop has a lively
    // spring to it instead of a linear slide.
    const elapsedSinceSpawn = occupant.fullDuration - occupant.timer;
    const rising = elapsedSinceSpawn < RISE_SEC;
    const linearProgress = rising
      ? clamp01(elapsedSinceSpawn / RISE_SEC)
      : clamp01(occupant.timer / RISE_SEC);
    if (linearProgress <= 0 && !rising) return;
    const eased = rising ? easeOutBack(linearProgress) : easeInQuad(linearProgress);

    this.drawOccupant(c, hole, occupant, eased, linearProgress, holeRadiusX, holeRadiusY);
  }

  private drawOccupant(
    c: CanvasRenderingContext2D,
    hole: Hole,
    occupant: Occupant,
    eased: number,
    linearProgress: number,
    holeRadiusX: number,
    holeRadiusY: number,
  ): void {
    const restY = hole.cy - holeRadiusY * 1.05;
    const hiddenY = hole.cy + holeRadiusY * 0.6;
    const itemCy = hiddenY + (restY - hiddenY) * eased;
    const scale = Math.max(0.15, 0.5 + 0.5 * eased);
    const size = HOLE_ITEM_SIZE * scale;
    const half = size / 2;

    // Contact shadow on the mound, fading in as the occupant rises clear
    // of the opening — otherwise a fully-popped mole looks like it's
    // floating above the ground instead of standing on it.
    if (linearProgress > CLIP_UNTIL) {
      const shadowAlpha = ((linearProgress - CLIP_UNTIL) / (1 - CLIP_UNTIL)) * 0.28;
      c.save();
      c.globalAlpha = shadowAlpha;
      c.fillStyle = "#000000";
      c.beginPath();
      c.ellipse(hole.cx, hole.cy - holeRadiusY * 0.1, holeRadiusX * 0.7, holeRadiusY * 0.5, 0, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }

    const stillEmerging = linearProgress < CLIP_UNTIL;
    if (stillEmerging) {
      c.save();
      c.beginPath();
      c.ellipse(hole.cx, hole.cy, holeRadiusX, holeRadiusY, 0, 0, Math.PI * 2);
      c.clip();
    }

    this.drawOccupantSprite(c, occupant, hole.cx, itemCy, half, scale);

    if (stillEmerging) c.restore();
  }

  /** The short "bonk" reaction once a hole's occupant has been tapped: an
   * instant squash-flat (wide/short instead of the round resting pose) that
   * sinks straight down into the opening — the visual payoff for a
   * successful hit, instead of the occupant just vanishing on contact. */
  private drawBonkedOccupant(
    c: CanvasRenderingContext2D,
    hole: Hole,
    occupant: Occupant,
    holeRadiusX: number,
    holeRadiusY: number,
  ): void {
    const t = clamp01((occupant.hitT ?? 0) / HIT_SINK_SEC);
    const restY = hole.cy - holeRadiusY * 1.05;
    const itemCy = restY + (hole.cy - restY) * t;
    const scaleY = Math.max(0.25, 1 - t * 0.9);
    const scaleX = 1 + (1 - scaleY) * 0.5;
    const half = HOLE_ITEM_SIZE / 2;

    c.save();
    c.beginPath();
    c.ellipse(hole.cx, hole.cy, holeRadiusX, holeRadiusY, 0, 0, Math.PI * 2);
    c.clip();
    c.translate(hole.cx, itemCy);
    c.scale(scaleX, scaleY);
    c.translate(-hole.cx, -itemCy);
    this.drawOccupantSprite(c, occupant, hole.cx, itemCy, half, 1);
    c.restore();
  }

  private drawOccupantSprite(
    c: CanvasRenderingContext2D,
    occupant: Occupant,
    cx: number,
    cy: number,
    half: number,
    scale: number,
  ): void {
    const { brand } = this.ctx;
    const size = half * 2;

    if (occupant.asset?.image) {
      withDropShadow(c, () => drawAssetContain(c, occupant.asset!, cx - half, cy - half, size, size), {
        blur: 10 * scale,
        offsetY: 5 * scale,
      });
      return;
    }

    if (occupant.kind === "hazard") {
      drawHazardShape(c, cx, cy, size, brand.secondaryAccent || "#3a3a3a");
    } else {
      drawMoleCreatureShape(c, cx, cy, size, brand.accent);
    }
  }

  /** A stylised mallet that slams straight down at the last tap location
   * (hit or miss — a whiff is still feedback the tap registered) and
   * retracts. Purely procedural: this template has no `hammer` role/asset,
   * and a real hammer prop wouldn't come from product extraction anyway.
   *
   * Local coordinate space is built around the head's CONTACT point (its
   * bottom face) sitting at the origin: the head occupies y in
   * [-headH, 0] and the handle extends further up from there, so
   * translating the origin straight up/down (raised <-> swing.y) alone
   * produces a believable vertical slam. An earlier version centred the
   * head on the origin and rotated the whole assembly around it — with the
   * handle hanging off one side, that rotation swung the handle out at a
   * disconnected diagonal instead of reading as a downward hit. */
  private drawHammer(c: CanvasRenderingContext2D, swing: HammerSwing): void {
    const liftDistance = HAMMER_HEAD_SIZE * 2.6;
    const { travel, angle, squash } = hammerPose(swing.t);
    const contactY = swing.y - liftDistance * (1 - travel);

    c.save();
    c.translate(swing.x, contactY);
    c.scale(1 + squash * 0.12, 1 - squash * 0.12);
    c.rotate(angle);

    withDropShadow(
      c,
      () => {
        const headW = HAMMER_HEAD_SIZE;
        const headH = HAMMER_HEAD_SIZE * 0.62;
        const handleLen = HAMMER_HEAD_SIZE * 1.9;

        // Handle — extends upward from the top of the head toward the
        // (implied, off-frame) hand.
        const handleGrad = c.createLinearGradient(0, -headH - handleLen, 0, -headH);
        handleGrad.addColorStop(0, "#8A5F31");
        handleGrad.addColorStop(1, "#C9975A");
        c.fillStyle = handleGrad;
        roundedRect(c, -headW * 0.07, -headH - handleLen, headW * 0.14, handleLen, headW * 0.07);
        c.fill();

        // Head — a wooden/rubber mallet block, bottom face at the origin
        // (the actual contact point), with a lighter top face for a
        // simple two-tone 3D read.
        const headGrad = c.createLinearGradient(-headW / 2, -headH, -headW / 2, 0);
        headGrad.addColorStop(0, "#E8A24A");
        headGrad.addColorStop(1, "#B9702B");
        c.fillStyle = headGrad;
        roundedRect(c, -headW / 2, -headH, headW, headH, headH * 0.28);
        c.fill();

        c.fillStyle = "rgba(255,255,255,0.35)";
        roundedRect(c, -headW / 2 + headW * 0.08, -headH + headH * 0.1, headW * 0.5, headH * 0.28, headH * 0.14);
        c.fill();

        // Metal collar band, just below the handle / above the head base.
        c.fillStyle = "#8B8F98";
        c.fillRect(-headW * 0.12, -headH * 0.34, headW * 0.24, headH * 0.22);
      },
      { blur: 8, offsetY: 4 },
    );

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

function fontFamilyForCanvas(fontFamily: string): string {
  return fontFamily || "system-ui, sans-serif";
}

export function createWhackGame(): GameModule {
  return new WhackGame();
}
