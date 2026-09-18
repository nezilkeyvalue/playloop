// lib/runtime/games/runner.ts
//
// Runner: the brand athlete runs right-to-left down a stadium track past
// hurdles; one input (tap / space / ArrowUp) jumps. Capability:
// lib/capabilities/runner.json.
//
// Three deliberate departures from the Chrome dinosaur it borrows from:
//
//   1. Obstacles are NEVER assets. They're generated brand-colour hurdles,
//      full stop — there is no hazard role in the capability. A product is
//      only ever a good thing to hit, so ctx.recordEngagement() can't leak
//      onto a hazard by construction.
//   2. It isn't one-hit-death. A round is `lives` hits OR the finish line,
//      whichever comes first, because a one-hit runner can end three
//      seconds in and hand the player a reward screen with zero products
//      engaged — the worst possible outcome for the thing this repo exists
//      to do.
//   3. The round ends on a finish line the player actually runs through,
//      not on a raw timer cut. The gate is spawned at the exact moment
//      `remainingTime * speed` equals the distance it has to travel, so it
//      arrives at the runner right as `durationSec` elapses — no magic
//      lead-time constant to keep in sync with the tuning ranges.
//
// Brand visibility, in priority order of screen time:
//   - The stadium billboard band runs the full width behind the track for
//     100% of the round, cycling the brand logo, a brand-colour wordmark
//     panel, and real product sprites. A side-scroller otherwise shows the
//     brand only on the runner sprite, which is ~5% of the frame.
//   - Grabbing a collectible fires a Celebration (spriteRender.ts): the
//     product grows and fades centre-stage for ~0.45s while the world keeps
//     scrolling. A side-scroller otherwise never lets a product sit still
//     long enough to read, which is the one real weakness of the genre.
//
// Billboard products are decoration, never interaction — they are NOT
// passed to ctx.recordEngagement(). Only a collectible the player actually
// catches counts (see CLAUDE.md's engagement rule).
//
// Tuning knobs honored (already clamped to capability ranges by mount.ts):
//   scrollSpeed        — px/sec the world moves at, ramped over the round
//   speedRamp          — scrollSpeed multiplier reached at the finish line
//   obstacleRateHz     — hurdle spawns per second
//   collectibleRateHz  — product spawns per second
//   lives              — hits allowed before the round ends early
//   durationSec        — total run time
//
// Roles honored:
//   collectible     — required (fallback "none"); the products to grab
//   (no runner role) — the athlete is drawn, never an asset and never the
//                     brand logo: see BRAND SKIN below
//   stageBackground — optional; the generated athletics sky if unfilled
//
// BRAND SKIN. This file holds no brand-specific colour and no brand name.
// Every colour it paints — sky, stands, hoarding, track, hurdles, the
// runner's kit, the UI — comes from `this.theme`, resolved once in init()
// by lib/runtime/games/runnerTheme.ts from (1) the spec's own BrandKit,
// (2) a named preset in spec.meta.theme, (3) the host's
// MountOptions.brandTheme. All the trackside advertising copy comes from
// theme.advertising, so a host reskins the event without touching gameplay.
//
// What is NOT themeable, deliberately: the character. Body, face, hair,
// proportions, silhouette, cadence and the whole jump/collision model are
// fixed here, so every brand's player is recognisably the same runner in
// different kit.

import type { GameModule, RuntimeContext, LoadedAsset } from "@/lib/runtime/gameModule";
import {
  drawAssetContain,
  updateCelebrations,
  drawCelebration,
  shadeHex,
  type Celebration,
} from "@/lib/runtime/games/spriteRender";
import {
  readableOn,
  resolveRunnerTheme,
  withAlpha,
  type AdPanel,
  type RunnerTheme,
} from "@/lib/runtime/games/runnerTheme";

// Scoring. maxRealisticScore() at the capability's default tuning
// (collectibleRateHz 0.7, durationSec 35) lands near runner.json's
// scoring.maxRealistic (280):
//   collectibleSpawns = 0.7 * 35                      = 24.5
//   grabbed           = 24.5 * REALISTIC_GRAB_RATE    = 17.15
//   score             = 17.15 * 10 + 35 * 1           ≈ 206
// plus the survival trickle for a player who never dies. Deliberately a
// small-number game: a runner's score reads as "things grabbed", not as an
// arcade counter. Spawning stops once the finish gate is out (roughly the
// last second of the round), which is inside the slack this estimate
// already carries.
const POINTS_PER_GRAB = 10;
const POINTS_PER_SECOND = 1;
const REALISTIC_GRAB_RATE = 0.7;

// Jump physics at REFERENCE_HEIGHT. Both are multiplied by the stage scale
// below, which scales the apex (v²/2g) with the stage while leaving the
// hang time identical — so the game feels the same in a 250px ad slot and a
// 540px section, and the tuned spawn rates stay meaningful in both.
const GRAVITY = 2000; // px/sec²
const JUMP_VELOCITY = -700; // px/sec, negative is up
const REFERENCE_HEIGHT = 420;
const INVULNERABLE_SEC = 1.2;
// Ground line (the lane the runner is in) as a fraction of stage height.
// Everything below it plus the receding far-lane band above it is track, so
// the track reads as the lower third-ish of the frame rather than a strip.
const GROUND_FRACTION = 0.76;

const RUNNER_SIZE = 52;
const COLLECTIBLE_SIZE = 46;
const OBSTACLE_WIDTH = 26;
const OBSTACLE_MIN_HEIGHT = 34;
const OBSTACLE_MAX_HEIGHT = 62;

// Stadium dressing.
const BILLBOARD_BAND_FRACTION = 0.13; // of stage height, sat on the ground line
const BILLBOARD_BAND_MIN = 38;
const BILLBOARD_BAND_MAX = 80;
const BILLBOARD_PARALLAX = 0.35; // fraction of world speed the wall scrolls at
const BILLBOARD_PRODUCT_PANELS = 3; // distinct product panels in the cycle
const LANE_COUNT = 6; // lane dividers drawn across the whole track, near + far
const LANE_CURVE = 1.9; // >1 bunches the far lanes toward the horizon
const RUNNER_CADENCE_HZ = 9; // leg swings per second for the generated athlete

// Character identity — NOT themeable. The runner is the same character for
// every brand (body, face, hair, proportions, animation); only the kit
// colours move, and those come from theme.character. See runnerTheme.ts.
const SKIN = "#e7b083";
const SKIN_SHADE = "#c9925f";
const HAIR = "#3b3029";

/** Far-lane band above the ground line, as a fraction of stage height. The
 * lanes "behind" the runner — what makes the surface read as a track with
 * depth instead of a horizontal stripe. */
const FAR_BAND_FRACTION = 0.11;
const FAR_BAND_MIN = 22;
const FAR_BAND_MAX = 74;

/** Clouds: fixed layout, scrolled and wrapped. No per-frame allocation, no
 * randomness, so the sky is identical every round on every device. */
const CLOUDS: ReadonlyArray<{ x: number; y: number; scale: number }> = [
  { x: 0.08, y: 0.14, scale: 1 },
  { x: 0.42, y: 0.08, scale: 0.7 },
  { x: 0.68, y: 0.2, scale: 1.15 },
  { x: 1.02, y: 0.11, scale: 0.85 },
];
const CLOUD_PARALLAX = 0.05; // fraction of world speed — barely moving, far away

// The finish gate, once spawned, is a solid object in the world rather than
// a timer: `durationSec` is still what decides WHEN it spawns.
const FINISH_GATE_WIDTH = 18;
const FINISH_OVERRUN_GRACE_SEC = 3; // hard stop if the gate somehow never lands

interface Obstacle {
  x: number;
  width: number;
  height: number;
}

/** One measured advertising board on the hoarding. Built once per band
 * height by buildAdLayout(); `width` is the board's own measured width, so
 * boards differ in size the way real sponsor boards do. */
interface AdBoard {
  art: "logo" | "product" | "none";
  asset: LoadedAsset | null;
  label: string;
  message: string;
  labelSize: number;
  messageSize: number;
  artW: number;
  width: number;
  brandFilled: boolean;
}

interface AdLayout {
  bandH: number;
  boards: AdBoard[];
  gap: number;
  /** Sum of every board plus its gap — the scroll period of the wall. */
  cycleWidth: number;
}

interface Collectible {
  x: number;
  y: number;
  asset: LoadedAsset;
}

export function maxRealisticScore(tuning: Record<string, number>): number {
  const collectibleRateHz = tuning.collectibleRateHz ?? 0.7;
  const durationSec = tuning.durationSec ?? 35;
  const grabs = collectibleRateHz * durationSec * REALISTIC_GRAB_RATE;
  return Math.round(grabs * POINTS_PER_GRAB + durationSec * POINTS_PER_SECOND);
}

/** Everything is sized off the stage height so the same tuning plays the
 * same way in a short ad slot and a tall section. Clamped so a very small
 * or very large stage stays playable rather than microscopic/absurd. */
function stageScale(stageHeight: number): number {
  return Math.min(1.4, Math.max(0.5, stageHeight / REFERENCE_HEIGHT));
}

class RunnerGame implements GameModule {
  id: "runner" = "runner";

  private ctx!: RuntimeContext;
  /** The brand skin for this mount. Derived from spec.brand, then the named
   * preset in spec.meta.theme, then the host's MountOptions.brandTheme —
   * see runnerTheme.ts. Every colour this file paints comes from here. */
  private theme!: RunnerTheme;
  private obstacles: Obstacle[] = [];
  private collectibles: Collectible[] = [];
  private celebrations: Celebration[] = [];

  private runnerY = 0; // offset above the ground line, 0 = standing
  private velocityY = 0;
  private elapsed = 0;
  private scoreFraction = 0; // sub-point survival accumulator
  private obstacleTimer = 0;
  private collectibleTimer = 0;
  private livesLeft = 3;
  private invulnerableFor = 0;
  private ended = false;

  /** Scroll accumulators for the two decorative layers. Kept separate from
   * world position because they move at different speeds (parallax) and are
   * only ever read modulo their own tile width. */
  private adLayoutCache: AdLayout | null = null;
  private billboardOffset = 0;
  private groundOffset = 0;
  private skyOffset = 0;

  /** World x of the START gantry, or null once it has scrolled off. Pure
   * dressing — it carries no collision and ends nothing. */
  private startX: number | null = null;

  /** World x of the finish gate, or null while the round is still running.
   * Non-null also means both spawners are switched off. */
  private finishX: number | null = null;

  private pool: LoadedAsset[] = [];
  private backgroundAsset: LoadedAsset | null = null;

  init(ctx: RuntimeContext): void {
    this.ctx = ctx;
    this.theme = resolveRunnerTheme(ctx.brand, ctx.spec.meta.theme, ctx.brandTheme);
    this.obstacles = [];
    this.collectibles = [];
    this.celebrations = [];
    this.runnerY = 0;
    this.velocityY = 0;
    this.elapsed = 0;
    this.scoreFraction = 0;
    // Stagger the two spawners so the first obstacle and the first product
    // don't arrive on the same frame every single round.
    // Lead with a product, then the first obstacle — an empty opening
    // second reads as "is this broken?" rather than as a run-up.
    this.obstacleTimer = intervalFor(ctx.tuning.obstacleRateHz ?? 0.55) * 0.35;
    this.collectibleTimer = intervalFor(ctx.tuning.collectibleRateHz ?? 0.7) * 0.7;
    this.livesLeft = Math.max(1, Math.round(ctx.tuning.lives ?? 3));
    this.invulnerableFor = 0;
    this.ended = false;
    this.adLayoutCache = null;
    this.billboardOffset = 0;
    this.groundOffset = 0;
    this.skyOffset = 0;
    // Far enough right that the runner visibly passes under it, not so far
    // that it is still on screen when the first hurdle arrives.
    this.startX = ctx.stage.width * 0.72;
    this.finishX = null;

    this.pool = ctx.roles.collectible?.assets ?? [];
    this.backgroundAsset = ctx.roles.stageBackground?.assets[0] ?? null;
  }

  update(dt: number): void {
    if (this.ended) return;
    const { tuning, input, stage } = this.ctx;

    this.elapsed += dt;
    const durationSec = tuning.durationSec ?? 35;

    // Survival trickle, banked as whole points so getScore() stays integral.
    this.scoreFraction += dt * POINTS_PER_SECOND;
    const whole = Math.floor(this.scoreFraction);
    if (whole > 0) {
      this.scoreFraction -= whole;
      this.ctx.addScore(whole);
    }

    // --- jump: one action, any input ---
    const jumpPressed =
      input.justPressed || input.confirmPressed || input.keysDown.has("ArrowUp");
    const scale = stageScale(stage.height);
    const grounded = this.runnerY >= 0;
    if (jumpPressed && grounded) {
      this.velocityY = JUMP_VELOCITY * scale;
    }
    this.velocityY += GRAVITY * scale * dt;
    this.runnerY += this.velocityY * dt;
    if (this.runnerY > 0) {
      this.runnerY = 0;
      this.velocityY = 0;
    }

    if (this.invulnerableFor > 0) this.invulnerableFor -= dt;

    // --- speed ramp ---
    const progress = durationSec > 0 ? Math.min(1, this.elapsed / durationSec) : 0;
    const ramp = tuning.speedRamp ?? 1.4;
    const speed = (tuning.scrollSpeed ?? 260) * (1 + (ramp - 1) * progress);
    const runnerX = stage.width * 0.18;

    // --- finish gate ---
    // Spawn the instant the remaining time is exactly the travel time, so
    // the gate reaches the runner as durationSec elapses. Solving for a
    // fixed lead constant instead would have to be correct across the whole
    // scrollSpeed range (180..420) and every stage width, which it can't be.
    if (this.finishX === null && speed > 0) {
      const travelDistance = stage.width - runnerX;
      const remaining = durationSec - this.elapsed;
      if (remaining * speed <= travelDistance) {
        this.finishX = stage.width + FINISH_GATE_WIDTH;
      }
    }

    // --- spawning (stops once the gate is out — nothing should out-run it) ---
    if (this.finishX === null) {
      this.obstacleTimer += dt;
      const obstacleInterval = intervalFor(tuning.obstacleRateHz ?? 0.55);
      while (this.obstacleTimer >= obstacleInterval) {
        this.obstacleTimer -= obstacleInterval;
        this.spawnObstacle();
      }

      this.collectibleTimer += dt;
      const collectibleInterval = intervalFor(tuning.collectibleRateHz ?? 0.7);
      while (this.collectibleTimer >= collectibleInterval && this.pool.length > 0) {
        this.collectibleTimer -= collectibleInterval;
        this.spawnCollectible();
      }
    } else {
      this.finishX -= speed * dt;
    }

    // --- start gantry, purely decorative, scrolls away with the world ---
    if (this.startX !== null) {
      this.startX -= speed * dt;
      if (this.startX < -stage.width * 0.6) this.startX = null;
    }

    // --- decorative scroll layers ---
    this.billboardOffset += speed * BILLBOARD_PARALLAX * dt;
    this.groundOffset += speed * dt;
    this.skyOffset += speed * CLOUD_PARALLAX * dt;

    // --- movement + collision ---
    const groundY = stage.height * GROUND_FRACTION;
    const runnerSize = RUNNER_SIZE * scale;
    const collectibleSize = COLLECTIBLE_SIZE * scale;
    const runnerBox = {
      left: runnerX - runnerSize / 2,
      right: runnerX + runnerSize / 2,
      top: groundY + this.runnerY - runnerSize,
      bottom: groundY + this.runnerY,
    };

    const liveObstacles: Obstacle[] = [];
    for (const obstacle of this.obstacles) {
      obstacle.x -= speed * dt;
      if (obstacle.x + obstacle.width < -obstacle.width) continue;

      const hit =
        this.invulnerableFor <= 0 &&
        overlaps(runnerBox, {
          left: obstacle.x,
          right: obstacle.x + obstacle.width,
          top: groundY - obstacle.height,
          bottom: groundY,
        });
      if (hit) {
        this.livesLeft -= 1;
        this.ctx.sound.play("fail");
        this.invulnerableFor = INVULNERABLE_SEC;
      }
      liveObstacles.push(obstacle);
    }
    this.obstacles = liveObstacles;

    const liveCollectibles: Collectible[] = [];
    for (const item of this.collectibles) {
      item.x -= speed * dt;
      if (item.x + collectibleSize < 0) continue;

      const grabbed = overlaps(runnerBox, {
        left: item.x - collectibleSize / 2,
        right: item.x + collectibleSize / 2,
        top: item.y - collectibleSize / 2,
        bottom: item.y + collectibleSize / 2,
      });
      if (grabbed) {
        this.ctx.addScore(POINTS_PER_GRAB);
        this.ctx.sound.play("success");
        // Every collectible here is a real asset from the role pool (the
        // role's fallback is "none", so there is no generated stand-in to
        // guard against) — but the image can still have failed to load.
        if (item.asset.image) {
          this.ctx.recordEngagement(item.asset.id);
          this.celebrations.push({
            asset: item.asset,
            x: stage.width / 2,
            y: stage.height * 0.42,
            t: 0,
          });
        }
        continue;
      }
      liveCollectibles.push(item);
    }
    this.collectibles = liveCollectibles;
    this.celebrations = updateCelebrations(this.celebrations, dt);

    // The gate reaching the runner is the normal end. The elapsed check is
    // a backstop only — if scrollSpeed were somehow zero the gate would
    // never arrive, and a game that never ends is worse than one that ends
    // a little late.
    const crossedFinish = this.finishX !== null && this.finishX <= runnerX;
    const overran = this.elapsed >= durationSec + FINISH_OVERRUN_GRACE_SEC;
    if (this.livesLeft <= 0 || crossedFinish || overran) {
      this.ended = true;
      this.ctx.complete();
    }
  }

  render(c: CanvasRenderingContext2D): void {
    const { stage, brand } = this.ctx;
    const groundY = stage.height * GROUND_FRACTION;
    const trackTop = groundY - this.farBandHeight();
    const scale = stageScale(stage.height);

    // Sky (or the optional stageBackground photo, which replaces it whole).
    if (this.backgroundAsset?.image) {
      c.drawImage(this.backgroundAsset.image, 0, 0, stage.width, stage.height);
    } else {
      this.drawSky(c, trackTop);
    }

    // Distance, back to front: seating tiers, hoarding, grass apron.
    this.drawStands(c, trackTop);
    this.drawBillboards(c, trackTop);

    // Track surface + lanes, from the far band down to the bottom edge.
    this.drawTrack(c, trackTop, groundY);

    // Hurdles — generated shapes only, never a product.
    for (const obstacle of this.obstacles) {
      this.drawHurdle(c, obstacle, groundY);
    }
    this.drawJumpCue(c, stage.width * 0.18, groundY);

    // Collectibles, framed in a brand-accent token so a non-isolated photo
    // still reads as a deliberate pickup rather than a floating rectangle.
    for (const item of this.collectibles) {
      this.drawCollectible(c, item, COLLECTIBLE_SIZE * scale);
    }

    if (this.startX !== null) this.drawGate(c, this.startX, groundY, "START");
    if (this.finishX !== null) this.drawGate(c, this.finishX, groundY, "FINISH");

    this.drawRunner(c, stage.width * 0.18, groundY, RUNNER_SIZE * scale);
    this.drawLives(c);

    // Celebrations last, so the just-grabbed product is the focal point.
    for (const celebration of this.celebrations) {
      drawCelebration(c, celebration, COLLECTIBLE_SIZE * scale * 2.2, this.theme.ui.primary);
    }
  }

  teardown(): void {
    this.adLayoutCache = null;
    this.obstacles = [];
    this.collectibles = [];
    this.celebrations = [];
  }

  maxRealisticScore(tuning: Record<string, number>): number {
    return maxRealisticScore(tuning);
  }

  private spawnObstacle(): void {
    const { stage, random } = this.ctx;
    const scale = stageScale(stage.height);
    const height =
      (OBSTACLE_MIN_HEIGHT + random() * (OBSTACLE_MAX_HEIGHT - OBSTACLE_MIN_HEIGHT)) * scale;
    const width = OBSTACLE_WIDTH * (0.8 + random() * 0.6) * scale;
    this.obstacles.push({ x: stage.width + width, width, height });
  }

  private spawnCollectible(): void {
    const { stage, random } = this.ctx;
    const asset = this.pool[Math.floor(random() * this.pool.length)];
    if (!asset) return;
    const groundY = stage.height * GROUND_FRACTION;
    const scale = stageScale(stage.height);
    // Sit inside the jump arc: apex is (v*scale)²/(2*g*scale) = apex*scale.
    // Deliberately only the lower 60% of that arc — a collectible placed at
    // the true apex is reachable in theory and frustrating in practice,
    // since it needs the jump timed to the exact frame. The point is for
    // the tap that clears an obstacle to also collect the product.
    const apex = ((JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY)) * scale;
    const lift = RUNNER_SIZE * scale * 0.35 + random() * apex * 0.6;
    this.collectibles.push({
      x: stage.width + COLLECTIBLE_SIZE * scale,
      y: groundY - lift - COLLECTIBLE_SIZE / 2,
      asset,
    });
  }

  /** Height of the receding lane band drawn ABOVE the ground line. */
  private farBandHeight(): number {
    return Math.max(
      FAR_BAND_MIN,
      Math.min(FAR_BAND_MAX, this.ctx.stage.height * FAR_BAND_FRACTION),
    );
  }

  /**
   * Sky: a vertical gradient that lightens toward the horizon, plus a few
   * wrapping clouds. Kept deliberately empty otherwise — the runner and the
   * hurdles are the only things in this frame that should pull the eye.
   */
  private drawSky(c: CanvasRenderingContext2D, horizonY: number): void {
    const { stage } = this.ctx;
    const sky = c.createLinearGradient(0, 0, 0, horizonY);
    sky.addColorStop(0, this.theme.environment.skyTop);
    sky.addColorStop(1, this.theme.environment.skyBottom);
    c.fillStyle = sky;
    c.fillRect(0, 0, stage.width, horizonY);

    const span = stage.width * 1.3;
    const drift = this.skyOffset % span;
    c.save();
    c.fillStyle = this.theme.environment.cloud;
    for (const cloud of CLOUDS) {
      // Two passes so a cloud leaving the left edge reappears on the right
      // without any per-cloud bookkeeping.
      const base = cloud.x * span - drift;
      for (const x of [base, base + span]) {
        if (x < -span * 0.2 || x > stage.width + span * 0.2) continue;
        this.drawCloud(c, x, cloud.y * horizonY, horizonY * 0.085 * cloud.scale);
      }
    }
    c.restore();
  }

  private drawCloud(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    c.globalAlpha = 0.85;
    c.beginPath();
    c.arc(x, y, r * 0.6, 0, Math.PI * 2);
    c.arc(x + r * 0.62, y - r * 0.2, r * 0.45, 0, Math.PI * 2);
    c.arc(x + r * 1.15, y + r * 0.05, r * 0.5, 0, Math.PI * 2);
    c.arc(x + r * 0.55, y + r * 0.3, r * 0.55, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = 1;
  }

  /**
   * Two seating tiers and a scoreboard, all low contrast — this is depth,
   * not content. The crowd is drawn as fixed-size rects on a stride rather
   * than arcs: hundreds of arcs per frame is the one cheap-looking detail
   * that actually costs something on a mid-range phone.
   */
  private drawStands(c: CanvasRenderingContext2D, horizonY: number): void {
    const { stage } = this.ctx;
    const tierH = Math.max(16, Math.min(56, stage.height * 0.1));
    const backY = horizonY - tierH * 1.9;
    const frontY = horizonY - tierH;

    c.fillStyle = this.theme.environment.standBack;
    c.fillRect(0, backY, stage.width, tierH * 0.7);
    c.fillStyle = this.theme.environment.standFront;
    c.fillRect(0, frontY, stage.width, tierH);

    // Aisles: evenly spaced vertical breaks are what make a pale band read
    // as seating rather than haze. Drifting with the world, like the crowd.
    const aisle = Math.max(38, stage.width * 0.16);
    const aisleShift = (this.billboardOffset * 0.5) % aisle;
    c.fillStyle = this.theme.environment.standBack;
    c.globalAlpha = 0.7;
    for (let x = -aisleShift; x < stage.width; x += aisle) {
      c.fillRect(x, backY, Math.max(2, aisle * 0.035), tierH * 1.9);
    }
    c.globalAlpha = 1;

    // Crowd speckle, drifting with the world so the stands aren't static.
    const stride = Math.max(7, tierH * 0.34);
    const dot = Math.max(2, stride * 0.32);
    const shift = (this.billboardOffset * 0.5) % stride;
    c.fillStyle = this.theme.environment.crowd;
    c.globalAlpha = 0.8;
    for (let row = 0; row < 3; row++) {
      const y = backY + tierH * 0.25 + row * stride * 0.62;
      if (y > frontY + tierH - dot) break;
      const rowShift = row % 2 === 0 ? shift : shift + stride / 2;
      for (let x = -rowShift; x < stage.width; x += stride) {
        c.fillRect(x, y, dot, dot);
      }
    }
    c.globalAlpha = 1;

    this.drawScoreboard(c, backY, tierH);
  }

  /** A distant scoreboard showing the live score. Low contrast on purpose —
   * mount.ts's HUD is the readable one; this is set dressing that happens
   * to be honest. */
  private drawScoreboard(c: CanvasRenderingContext2D, backY: number, tierH: number): void {
    const { stage, brand } = this.ctx;
    const w = Math.min(stage.width * 0.2, tierH * 2.6);
    const h = w * 0.42;
    if (h < 14) return;
    const x = stage.width * 0.7;
    const y = backY - h - tierH * 0.15;
    if (y < 2) return;

    c.save();
    c.globalAlpha = 0.55;
    c.fillStyle = this.theme.environment.wall;
    // Pylon, so the board is mounted on something rather than hovering.
    c.fillRect(x + w * 0.46, y + h, Math.max(2, w * 0.07), backY - y - h + tierH * 0.2);
    roundedRect(c, x, y, w, h, 4);
    c.fill();
    c.fillStyle = this.theme.ui.primary;
    c.fillRect(x, y, w, Math.max(2, h * 0.12));

    c.fillStyle = this.theme.environment.laneMarking;
    c.font = `700 ${Math.round(h * 0.45)}px ${brand.fontFamily}, system-ui, sans-serif`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(String(this.ctx.getScore()), x + w / 2, y + h * 0.6);
    c.restore();
  }

  private billboardBandHeight(): number {
    return Math.max(
      BILLBOARD_BAND_MIN,
      Math.min(BILLBOARD_BAND_MAX, this.ctx.stage.height * BILLBOARD_BAND_FRACTION),
    );
  }

  /**
   * The perimeter advertising hoarding every real stadium has, plus the
   * grass apron and the trackside flags in front of it.
   *
   * Boards are VARIABLE WIDTH: each one is measured to its own content in
   * buildAdLayout() and drawn at that width, so a long product name makes a
   * long board instead of being cut off by a fixed panel. The whole cycle
   * repeats on `cycleWidth`, which is just the sum of the boards, so the
   * wall still scrolls off a single modulo with no per-board state.
   *
   * Parallax, back to front: stands 0.175x world speed (drawn earlier at
   * half the hoarding's), hoarding 0.35x, flags 0.6x, track and everything
   * standing on it 1x.
   */
  private drawBillboards(c: CanvasRenderingContext2D, trackTop: number): void {
    const { stage } = this.ctx;
    const { advertising, environment } = this.theme;

    // Grass apron between the hoarding and the outside lane.
    const grassH = Math.max(4, Math.min(16, stage.height * 0.022));
    c.fillStyle = environment.grass;
    c.fillRect(0, trackTop - grassH, stage.width, grassH);

    const bandH = this.billboardBandHeight();
    const bandY = trackTop - grassH - bandH;

    // Wall behind the boards, so the gaps read as structure rather than sky.
    c.fillStyle = environment.wall;
    c.fillRect(0, bandY, stage.width, bandH);
    c.fillStyle = shadeHex(environment.wall, -0.06);
    c.fillRect(0, bandY + bandH - Math.max(2, bandH * 0.08), stage.width, Math.max(2, bandH * 0.08));

    if (advertising.enabled) {
      const layout = this.adLayout(c, bandH);
      if (layout && layout.cycleWidth > 0) {
        const boardH = bandH * 0.78;
        const boardY = bandY + (bandH - boardH) / 2;
        let x = -(this.billboardOffset % layout.cycleWidth);
        for (let i = 0; x < stage.width; i++) {
          const board = layout.boards[i % layout.boards.length]!;
          if (x + board.width > 0) this.drawAdBoard(c, board, x, boardY, board.width, boardH);
          x += board.width + layout.gap;
        }
      }
    }

    // Hoarding lip — a thin bright line reads as the top edge of a board.
    c.fillStyle = withAlpha(environment.laneMarking, 0.3);
    c.fillRect(0, bandY, stage.width, 2);

    if (this.theme.branding.flags) this.drawFlags(c, trackTop - grassH);
  }

  /** Cached board layout, rebuilt only when the band height changes (i.e.
   * on a resize). Measuring text every frame for every board would be the
   * one genuinely expensive thing on this wall. */
  private adLayout(c: CanvasRenderingContext2D, bandH: number): AdLayout | null {
    if (this.adLayoutCache && this.adLayoutCache.bandH === bandH) return this.adLayoutCache;
    this.adLayoutCache = this.buildAdLayout(c, bandH);
    return this.adLayoutCache;
  }

  /**
   * Turns theme.advertising.panels into measured boards.
   *
   * Copy is the brand's own, never invented here: a panel's `message`, then
   * a host-supplied slogan, then (product boards) the real product name,
   * then the brand wordmark. With no slogans configured — the default — the
   * wall is logo boards, product boards and wordmark boards, which is what
   * a sponsor wall is when the sponsor hasn't written a tagline.
   */
  private buildAdLayout(c: CanvasRenderingContext2D, bandH: number): AdLayout {
    const { brand, brandLogo } = this.ctx;
    const { advertising, branding } = this.theme;
    const boardH = bandH * 0.78;
    const pad = boardH * 0.2;
    const gap = Math.max(6, bandH * 0.22);
    const logoAllowed = branding.logoPosition === "banner" && brandLogo;
    const wordmark = (brand.name || "").toUpperCase();
    const panels = advertising.panels.length > 0 ? advertising.panels : [{ type: "logo" } as AdPanel];

    const boards: AdBoard[] = [];
    // A brand with no logo and no slogans has only its wordmark to say, and
    // a wall of identical wordmark boards reads as a bug. The first one
    // stays; later ones become product boards when there's a pool to draw
    // from, which is real content rather than a repeat.
    let wordmarkBoards = 0;
    for (let i = 0; i < panels.length; i++) {
      const panel = panels[i]!;
      const slogan = advertising.slogans.length > 0
        ? advertising.slogans[i % advertising.slogans.length]!
        : "";

      let art: AdBoard["art"] = "none";
      let asset: LoadedAsset | null = null;
      let message = panel.message ?? slogan;
      let label = "";

      if (panel.type === "product" && this.pool.length > 0) {
        asset = this.pool[i % this.pool.length] ?? null;
        if (asset?.image) {
          art = "product";
          message = message || asset.data?.name || wordmark;
          // The sponsor's name sits above a product shot, the way a real
          // product board is laid out. Skipped when it IS the message.
          if (wordmark && message.toUpperCase() !== wordmark) label = wordmark;
        }
      }
      if (art === "none" && logoAllowed && (panel.type === "logo" || panel.type === "product")) {
        art = "logo";
        message = message || advertising.primaryMessage || "";
      }
      if (art === "none" && !message) {
        const asAsset = this.pool[i % Math.max(1, this.pool.length)];
        if (wordmarkBoards > 0 && asAsset?.image) {
          art = "product";
          asset = asAsset;
          message = asAsset.data?.name?.toUpperCase() || wordmark;
          if (wordmark && message !== wordmark) label = wordmark;
        } else {
          // Type-only board: the wordmark IS the ad.
          message = advertising.primaryMessage || wordmark;
          wordmarkBoards++;
        }
      }

      message = message.toUpperCase();
      const messageSize = Math.round(boardH * (label ? 0.34 : 0.42));
      const labelSize = Math.round(boardH * 0.24);

      c.font = `800 ${messageSize}px ${brand.fontFamily}, system-ui, sans-serif`;
      let textW = message ? c.measureText(message).width : 0;
      if (label) {
        c.font = `700 ${labelSize}px ${brand.fontFamily}, system-ui, sans-serif`;
        textW = Math.max(textW, c.measureText(label).width);
      }

      const artW = art === "none" ? 0 : boardH * 0.62;
      const contentW = artW + (artW > 0 && textW > 0 ? pad * 0.8 : 0) + textW;
      // pad*2.6: a full pad each side plus breathing room on the right, so
      // the last glyph never sits on the board edge.
      const width = Math.max(bandH * 1.3, contentW + pad * 2.6);

      boards.push({
        art,
        asset,
        label,
        message,
        labelSize,
        messageSize,
        artW,
        width,
        // Every other type-only board is filled with the brand, so a run of
        // boards reads as a wall rather than a repeating texture.
        brandFilled: art === "none" && i % 2 === 0,
      });
    }

    const cycleWidth = boards.reduce((sum, b) => sum + b.width + gap, 0);
    return { bandH, boards, gap, cycleWidth };
  }

  /**
   * One trackside advertising board: a physical object on the hoarding, not
   * a UI card. Every board gets a base shadow, legs, and a sponsor stripe;
   * the content is laid out horizontally (art left, type right) at the size
   * the board was measured for, so nothing is ever clipped or ellipsised.
   *
   * Products shown here are decoration — never ctx.recordEngagement().
   */
  private drawAdBoard(
    c: CanvasRenderingContext2D,
    board: AdBoard,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    const { brand, brandLogo } = this.ctx;
    const { advertising, colors } = this.theme;
    const radius = Math.min(5, h * 0.1);
    const boardColor = board.brandFilled ? advertising.accentColor : advertising.wallBackground;
    const ink = board.brandFilled
      ? readableOn(advertising.accentColor, colors.onPrimary, advertising.wallText)
      : advertising.wallText;

    // Shadow the board casts on the wall behind it.
    c.fillStyle = withAlpha("#000000", 0.18);
    roundedRect(c, x + 2, y + 3, w, h, radius);
    c.fill();

    c.save();
    roundedRect(c, x, y, w, h, radius);
    c.fillStyle = boardColor;
    c.fill();
    c.clip();

    // Sponsor stripe along the top edge of the board.
    const stripeH = Math.max(2, h * 0.1);
    c.fillStyle = board.brandFilled ? withAlpha(colors.onPrimary, 0.5) : advertising.accentColor;
    c.fillRect(x, y, w, stripeH);

    const pad = h * 0.2;
    const innerY = y + stripeH;
    const innerH = h - stripeH;
    let cursor = x + pad;

    if (board.art === "product" && board.asset?.image) {
      drawAssetContain(c, board.asset, cursor, innerY + innerH * 0.12, board.artW, innerH * 0.76);
      cursor += board.artW + pad * 0.8;
    } else if (board.art === "logo" && brandLogo) {
      drawImageContain(c, brandLogo, cursor, innerY + innerH * 0.14, board.artW, innerH * 0.72);
      cursor += board.artW + pad * 0.8;
    }

    c.textAlign = "left";
    c.textBaseline = "middle";
    if (board.label) {
      c.fillStyle = withAlpha(ink, 0.75);
      c.font = `700 ${board.labelSize}px ${brand.fontFamily}, system-ui, sans-serif`;
      c.fillText(board.label, cursor, innerY + innerH * 0.32);
    }
    if (board.message) {
      c.fillStyle = ink;
      c.font = `800 ${board.messageSize}px ${brand.fontFamily}, system-ui, sans-serif`;
      c.fillText(board.message, cursor, innerY + innerH * (board.label ? 0.68 : 0.5));
    }
    c.restore();

    c.strokeStyle = withAlpha(advertising.accentColor, 0.5);
    c.lineWidth = 1.5;
    roundedRect(c, x, y, w, h, radius);
    c.stroke();

    // Two short legs, so the board stands on the wall base.
    c.fillStyle = shadeHex(advertising.wallBackground, -0.18);
    const legW = Math.max(2, w * 0.03);
    const legH = h * 0.12;
    c.fillRect(x + w * 0.2, y + h, legW, legH);
    c.fillRect(x + w * 0.8 - legW, y + h, legW, legH);
  }

  /**
   * Trackside pennants on the grass apron — secondary event branding, at a
   * parallax between the hoarding and the track so the apron has depth.
   * Flags flutter off the same elapsed clock as the runner's cadence; no
   * per-flag state.
   */
  private drawFlags(c: CanvasRenderingContext2D, baseY: number): void {
    const { stage } = this.ctx;
    const { colors, environment } = this.theme;
    const spacing = Math.max(90, stage.width * 0.34);
    const poleH = Math.max(14, stage.height * 0.055);
    const shift = (this.billboardOffset / BILLBOARD_PARALLAX) * 0.6 % spacing;

    c.save();
    for (let x = stage.width - shift; x > -spacing; x -= spacing) {
      const wave = Math.sin(this.elapsed * 3 + x * 0.02);
      c.strokeStyle = withAlpha(environment.laneMarking, 0.8);
      c.lineWidth = Math.max(1, poleH * 0.06);
      c.beginPath();
      c.moveTo(x, baseY);
      c.lineTo(x, baseY - poleH);
      c.stroke();

      c.fillStyle = colors.primary;
      c.beginPath();
      c.moveTo(x, baseY - poleH);
      c.lineTo(x + poleH * 0.55, baseY - poleH + poleH * 0.14 + wave * poleH * 0.05);
      c.lineTo(x, baseY - poleH + poleH * 0.3);
      c.closePath();
      c.fill();
    }
    c.restore();
  }

  /**
   * The track: a terracotta surface spanning the far band (above the ground
   * line) and the near band (below it), with white lane dividers.
   *
   * The perspective is fake and cheap: lane boundaries are placed on
   * `u ** LANE_CURVE` across the band, so they bunch up toward the top and
   * open out toward the bottom, and their width/alpha grow the same way.
   * That's enough for the surface to read as receding without a transform,
   * and it costs one pow() per line per frame.
   *
   * The lanes are decoration, not a movement axis: this template is
   * deliberately one-input (tap to jump) so it stays playable in a 300x250
   * ad slot, and real lane-switching would need a second axis. The runner's
   * own lane — the one straddling the ground line — is left clean, and the
   * scrolling motion streaks live there to sell the direction of travel.
   */
  private drawTrack(c: CanvasRenderingContext2D, trackTop: number, groundY: number): void {
    const { stage } = this.ctx;
    const span = stage.height - trackTop;
    if (span <= 0) return;

    const surface = c.createLinearGradient(0, trackTop, 0, stage.height);
    surface.addColorStop(0, this.theme.environment.trackFar);
    surface.addColorStop(1, this.theme.environment.trackNear);
    c.fillStyle = surface;
    c.fillRect(0, trackTop, stage.width, span);

    // Kerb: the white rim at the inside edge of a real track.
    c.fillStyle = this.theme.environment.trackKerb;
    c.fillRect(0, trackTop, stage.width, Math.max(2, span * 0.02));

    c.save();
    c.strokeStyle = this.theme.environment.laneMarking;
    for (let lane = 1; lane < LANE_COUNT; lane++) {
      const u = lane / LANE_COUNT;
      const y = trackTop + span * Math.pow(u, LANE_CURVE);
      c.globalAlpha = 0.3 + 0.45 * u;
      c.lineWidth = Math.max(1, (1 + 2.2 * u) * (span / 120));
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(stage.width, y);
      c.stroke();
    }
    c.restore();

    this.drawMotionStreaks(c, groundY, span);
  }

  /** Scrolling streaks in the runner's own lane. The one thing in the scene
   * that moves at full world speed, so the direction of travel is obvious
   * even in a still frame of the trailing dust. */
  private drawMotionStreaks(c: CanvasRenderingContext2D, groundY: number, span: number): void {
    const { stage } = this.ctx;
    const stride = Math.max(60, stage.width * 0.22);
    const length = stride * 0.32;
    const shift = this.groundOffset % stride;

    c.save();
    c.strokeStyle = this.theme.environment.laneMarking;
    c.lineCap = "round";
    for (let row = 0; row < 2; row++) {
      const y = groundY + span * (row === 0 ? 0.12 : 0.34);
      if (y > stage.height) break;
      c.globalAlpha = row === 0 ? 0.16 : 0.22;
      c.lineWidth = Math.max(1.5, span * 0.02 * (row + 1));
      const rowShift = row === 0 ? shift : (shift + stride / 2) % stride;
      for (let x = stage.width - rowShift; x > -length; x -= stride) {
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x - length, y);
        c.stroke();
      }
    }
    c.restore();
  }

  /**
   * A track hurdle: white crossbar, brand-accent uprights and feet, sitting
   * on its own contact shadow so it reads as an object ON the track rather
   * than a decal painted into it. Same collision box as before (the caller
   * passes the unchanged obstacle rect) — this is purely how it reads, so
   * nothing about the difficulty or the score ceiling moves.
   *
   * Deliberately ONE thick top bar and two thin uprights, with no middle
   * rail: the obstacle box is taller than it is wide, and a second rail
   * across it made the whole thing read as a ladder rather than something
   * to clear. The bar is where the collision top actually is, so making it
   * the heaviest element is also the honest one.
   */
  private drawHurdle(c: CanvasRenderingContext2D, obstacle: Obstacle, groundY: number): void {
    const { brand } = this.ctx;
    const { frame, accent, stripe } = this.theme.hurdle;
    const top = groundY - obstacle.height;
    const postW = Math.max(2, obstacle.width * 0.12);
    const barH = Math.max(6, obstacle.height * 0.24);

    // Contact shadow, splayed along the track under the frame.
    c.save();
    c.fillStyle = this.theme.environment.shadow;
    c.beginPath();
    c.ellipse(
      obstacle.x + obstacle.width / 2,
      groundY + Math.max(2, obstacle.width * 0.12),
      obstacle.width * 0.78,
      Math.max(2.5, obstacle.width * 0.18),
      0,
      0,
      Math.PI * 2,
    );
    c.fill();
    c.restore();

    // Uprights, inset so the bar visibly overhangs them.
    c.fillStyle = accent;
    c.fillRect(obstacle.x + obstacle.width * 0.18, top + barH, postW, obstacle.height - barH);
    c.fillRect(obstacle.x + obstacle.width * 0.82 - postW, top + barH, postW, obstacle.height - barH);

    // Feet, splayed along the ground — inside the box, so nothing the
    // player can see sticks out past what the collision actually covers.
    c.fillRect(obstacle.x, groundY - Math.max(2, postW), obstacle.width, Math.max(2, postW));

    // The bar to clear: white, the way a real hurdle's top board is, with a
    // thin accent stripe along its lower edge to tie it to the brand.
    c.fillStyle = frame;
    roundedRect(c, obstacle.x, top, obstacle.width, barH, Math.min(3, barH / 2));
    c.fill();
    c.fillStyle = stripe;
    c.fillRect(obstacle.x, top + barH - Math.max(2, barH * 0.26), obstacle.width, Math.max(2, barH * 0.26));
  }

  /** "Jump this one" — a bobbing arrow over the nearest hurdle still ahead
   * of the runner. Only ever one on screen: a cue over every hurdle is
   * noise, and the one that matters is the next one. */
  private drawJumpCue(c: CanvasRenderingContext2D, runnerX: number, groundY: number): void {
    const { stage, brand } = this.ctx;
    const reach = stage.width * 0.55;
    let next: Obstacle | null = null;
    for (const obstacle of this.obstacles) {
      if (obstacle.x < runnerX) continue;
      if (obstacle.x - runnerX > reach) continue;
      if (!next || obstacle.x < next.x) next = obstacle;
    }
    if (!next) return;

    // Fade in as it approaches, so it doesn't pop into existence.
    const closeness = 1 - (next.x - runnerX) / reach;
    const size = Math.max(8, stage.height * 0.035);
    const bob = Math.sin(this.elapsed * 6) * size * 0.2;
    const cx = next.x + next.width / 2;
    const cy = groundY - next.height - size * 1.5 + bob;

    c.save();
    c.globalAlpha = Math.min(0.85, closeness * 1.2);
    c.fillStyle = this.theme.ui.primary;
    c.strokeStyle = this.theme.environment.laneMarking;
    c.lineWidth = Math.max(1, size * 0.12);
    c.lineJoin = "round";
    c.beginPath();
    c.moveTo(cx, cy - size * 0.55);
    c.lineTo(cx + size * 0.5, cy + size * 0.2);
    c.lineTo(cx + size * 0.2, cy + size * 0.2);
    c.lineTo(cx + size * 0.2, cy + size * 0.6);
    c.lineTo(cx - size * 0.2, cy + size * 0.6);
    c.lineTo(cx - size * 0.2, cy + size * 0.2);
    c.lineTo(cx - size * 0.5, cy + size * 0.2);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
  }

  /**
   * Event infrastructure: a chequered post with a sponsor gantry across the
   * top, used for both the start and the finish. The banner carries the
   * logo (only when the theme allows one), the event name from
   * theme.branding, and the gate's own label — which is what makes it read
   * as a race gantry rather than a HUD element pinned to the screen.
   */
  private drawGate(c: CanvasRenderingContext2D, x: number, groundY: number, label: string): void {
    const { stage, brand, brandLogo } = this.ctx;
    const { branding, ui, colors, environment } = this.theme;
    const gantryY = groundY - this.billboardBandHeight() * 1.45;
    const postTop = Math.max(0, gantryY);

    // Chequered post.
    const square = 10;
    for (let y = groundY - square; y > postTop; y -= square) {
      const dark = Math.floor((groundY - y) / square) % 2 === 0;
      c.fillStyle = dark ? environment.wall : environment.laneMarking;
      c.fillRect(x, y, FINISH_GATE_WIDTH, square);
    }

    // Gantry banner across the top of the post, carrying the logo.
    const bannerH = Math.max(22, this.billboardBandHeight() * 0.45);
    const bannerW = Math.min(stage.width * 0.55, bannerH * 5);
    const bannerX = x - bannerW / 2 + FINISH_GATE_WIDTH / 2;
    c.fillStyle = this.theme.ui.primary;
    roundedRect(c, bannerX, postTop, bannerW, bannerH, 6);
    c.fill();

    // The logo takes the left third when there is one; without it the word
    // centres on the whole banner rather than sitting off to one side with
    // dead space where the logo would have been.
    const pad = bannerH * 0.2;
    const showLogo = branding.logoPosition === "banner" && brandLogo;
    const logoW = showLogo ? bannerW * 0.26 : 0;
    if (showLogo && brandLogo) {
      drawImageContain(c, brandLogo, bannerX + pad, postTop + pad, logoW, bannerH - pad * 2);
    }

    const ink = readableOn(ui.primary, colors.onPrimary, colors.text);
    const textX = bannerX + logoW + (bannerW - logoW) / 2;
    c.textAlign = "center";
    c.fillStyle = ink;
    c.font = `800 ${Math.round(bannerH * 0.42)}px ${brand.fontFamily}, system-ui, sans-serif`;
    c.textBaseline = "alphabetic";
    c.fillText(label, textX, postTop + bannerH * 0.46);
    // Event name under the label — the small line every real race gantry
    // carries. Dropped on a short banner rather than crushed into it.
    if (bannerH >= 26 && branding.eventName) {
      c.fillStyle = withAlpha(ink, 0.8);
      c.font = `600 ${Math.round(bannerH * 0.24)}px ${brand.fontFamily}, system-ui, sans-serif`;
      c.fillText(truncate(c, branding.eventName, bannerW - logoW - pad * 2), textX, postTop + bannerH * 0.8);
    }
    c.textBaseline = "middle";
  }

  private drawCollectible(c: CanvasRenderingContext2D, item: Collectible, size: number): void {
    const { brand } = this.ctx;
    const half = size / 2;

    // A round token: disc, sprite clipped into it, accent ring on top. The
    // clip is what makes a full-bleed photo read as a deliberate pickup
    // rather than a rectangle with corners poking out of a circle — and it
    // costs nothing for a transparent cutout, which just keeps its disc.
    c.save();
    c.beginPath();
    c.arc(item.x, item.y, half, 0, Math.PI * 2);
    c.fillStyle = item.asset.backgroundColor || this.theme.ui.primary;
    c.fill();
    c.clip();
    if (item.asset.image) {
      drawAssetContain(c, item.asset, item.x - half, item.y - half, size, size);
    }
    c.restore();

    c.save();
    c.strokeStyle = this.theme.ui.primary;
    c.lineWidth = Math.max(2, size * 0.06);
    c.beginPath();
    c.arc(item.x, item.y, half, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }

  private drawRunner(c: CanvasRenderingContext2D, x: number, groundY: number, size: number): void {
    const feetY = groundY + this.runnerY;

    // Contact shadow: stays on the ground line and shrinks with height, so
    // a jump reads as leaving the track rather than the whole sprite just
    // sliding up the screen.
    const lift = Math.min(1, -this.runnerY / (size * 2));
    c.save();
    c.globalAlpha = 0.55 * (1 - lift * 0.7);
    c.fillStyle = this.theme.environment.shadow;
    c.beginPath();
    c.ellipse(x, groundY + size * 0.05, size * 0.42 * (1 - lift * 0.35), size * 0.12, 0, 0, Math.PI * 2);
    c.fill();
    c.restore();

    c.save();
    // Blink while invulnerable so a hit is legible without a HUD message.
    if (this.invulnerableFor > 0 && Math.floor(this.invulnerableFor * 8) % 2 === 0) {
      c.globalAlpha = 0.35;
    }

    // Always the athlete. The capability declares no `runner` role, so
    // there is no asset and no "logo" fallback that could stand in for the
    // character — swapping in a logo (or a product) made a different game
    // per brand, which is exactly what the theme system exists to avoid.
    this.drawAthlete(c, x, feetY, size);
    c.restore();
  }

  /**
   * The player character: a track athlete in the theme's kit, leaning into
   * the run. The SAME character for every brand — body, face, hair,
   * proportions, silhouette and cadence are fixed here; only the kit
   * colours come from the theme.
   *
   * Legs swing on a sine when grounded and tuck when airborne, which is
   * enough motion to read as running without a sprite sheet. Everything is
   * proportional to `size`, so the same figure works at 26px in an ad slot
   * and at 73px in a tall section.
   */
  private drawAthlete(c: CanvasRenderingContext2D, x: number, feetY: number, size: number): void {
    const { brand } = this.ctx;
    const airborne = this.runnerY < 0;
    const swing = airborne ? 0.75 : Math.sin(this.elapsed * RUNNER_CADENCE_HZ);
    const kit = this.theme.character;

    const headR = size * 0.13;
    const headY = feetY - size * 0.86;
    const shoulderY = feetY - size * 0.7;
    const hipY = feetY - size * 0.44;
    const stride = size * 0.32;
    // Airborne: front knee drives up, trailing leg stretches back — a
    // standing pose in mid-air is what makes a jump read as a lift-and-slide.
    const lift = airborne ? size * 0.3 : 0;
    const limb = Math.max(2, size * 0.11);

    // Forward lean grows with the leg swing — the figure drives rather than
    // bobbing in place.
    const lean = size * 0.04;

    c.save();
    c.lineCap = "round";
    c.lineJoin = "round";

    // Back arm and back leg first, dimmed, so the figure has a near/far side.
    c.globalAlpha = 0.75;
    c.strokeStyle = SKIN_SHADE;
    c.lineWidth = limb;
    c.beginPath();
    c.moveTo(x + lean, hipY);
    c.lineTo(x - swing * stride * (airborne ? 1.5 : 1), feetY - lift * 0.45);
    c.moveTo(x - size * 0.05 + lean, shoulderY);
    c.lineTo(x + swing * stride * 0.8, shoulderY + size * 0.14);
    c.stroke();
    c.globalAlpha = 1;

    // Head, with a short hair cap so it isn't a featureless ball.
    c.fillStyle = SKIN;
    c.beginPath();
    c.arc(x + lean, headY, headR, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = HAIR;
    c.beginPath();
    c.arc(x + lean, headY, headR, Math.PI * 1.05, Math.PI * 2.1);
    c.fill();
    // Optional accessory — absent from the theme means no headband, and
    // the same character without one.
    if (kit.headband) {
      c.fillStyle = kit.headband;
      c.beginPath();
      c.arc(x + lean, headY, headR, Math.PI * 1.12, Math.PI * 1.95);
      c.lineWidth = headR * 0.45;
      c.strokeStyle = kit.headband;
      c.stroke();
    }

    // Singlet: shoulders down to the hip, in the brand's shirt colour.
    c.fillStyle = kit.shirt;
    c.beginPath();
    c.moveTo(x - size * 0.16 + lean, shoulderY - size * 0.04);
    c.lineTo(x + size * 0.15 + lean, shoulderY - size * 0.04);
    c.lineTo(x + size * 0.12 + lean, hipY);
    c.lineTo(x - size * 0.13 + lean, hipY);
    c.closePath();
    c.fill();

    // Shorts.
    c.fillStyle = kit.shorts;
    c.beginPath();
    c.moveTo(x - size * 0.13 + lean, hipY - size * 0.02);
    c.lineTo(x + size * 0.12 + lean, hipY - size * 0.02);
    c.lineTo(x + size * 0.1 + lean, hipY + size * 0.14);
    c.lineTo(x - size * 0.12 + lean, hipY + size * 0.14);
    c.closePath();
    c.fill();

    // Front leg + front arm.
    c.strokeStyle = SKIN;
    c.lineWidth = limb;
    c.beginPath();
    c.moveTo(x + lean, hipY + size * 0.1);
    c.lineTo(x + swing * stride, feetY - lift - size * 0.06);
    c.stroke();
    c.lineWidth = Math.max(1.5, size * 0.09);
    c.beginPath();
    c.moveTo(x - size * 0.05 + lean, shoulderY);
    c.lineTo(x - swing * stride * 0.85, shoulderY + size * 0.2);
    c.stroke();

    // Shoes: white with an accent flash, pointing the way he's running.
    this.drawShoe(c, x + swing * stride, feetY - lift, size, 1);
    this.drawShoe(c, x - swing * stride * (airborne ? 1.5 : 1), feetY - lift * 0.45, size, 0.85);
    c.restore();
  }

  /** Sock + shoe. Same geometry for every brand; three themed colours. */
  private drawShoe(c: CanvasRenderingContext2D, x: number, y: number, size: number, alpha: number): void {
    const { socks, shoes, shoeAccent } = this.theme.character;
    const w = size * 0.26;
    const h = size * 0.1;
    c.save();
    c.globalAlpha = alpha;
    c.fillStyle = socks;
    c.fillRect(x - w * 0.12, y - h * 2.1, Math.max(2, w * 0.3), h * 1.3);
    c.fillStyle = shoes;
    roundedRect(c, x - w * 0.35, y - h, w, h, h * 0.45);
    c.fill();
    c.fillStyle = shoeAccent;
    c.fillRect(x - w * 0.35, y - h * 0.38, w, Math.max(1, h * 0.28));
    c.restore();
  }

  private drawLives(c: CanvasRenderingContext2D): void {
    const { brand, stage } = this.ctx;
    const total = Math.max(1, Math.round(this.ctx.tuning.lives ?? 3));
    const radius = 5;
    const gap = 16;
    const y = 16;
    for (let i = 0; i < total; i++) {
      const cx = stage.width - 16 - i * gap;
      c.beginPath();
      c.arc(cx, y, radius, 0, Math.PI * 2);
      if (i < this.livesLeft) {
        c.fillStyle = this.theme.ui.primary;
        c.fill();
        c.strokeStyle = this.theme.environment.laneMarking;
        c.lineWidth = 1.5;
        c.stroke();
      } else {
        // Spent lives read against the sky, so the ring is white rather
        // than brand.foreground (contrast-forced against brand.background,
        // which is no longer what's behind the HUD).
        c.strokeStyle = this.theme.environment.laneMarking;
        c.lineWidth = 1.5;
        c.globalAlpha = 0.6;
        c.stroke();
        c.globalAlpha = 1;
      }
    }
  }
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function intervalFor(rateHz: number): number {
  return rateHz > 0 ? 1 / rateHz : Infinity;
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

/** "Contain" draw for a plain HTMLImageElement (the pre-loaded brand logo),
 * which has no LoadedAsset wrapper and so can't go through
 * spriteRender.ts's drawAssetContain. */
function drawImageContain(
  c: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const srcW = image.naturalWidth || w;
  const srcH = image.naturalHeight || h;
  const scale = Math.min(w / srcW, h / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  c.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function truncate(c: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (c.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && c.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

export function createRunnerGame(): GameModule {
  return new RunnerGame();
}
