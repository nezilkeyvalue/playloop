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
//   runner          — the jumper; brand logo per the capability's "logo"
//                     fallback, else a generated athlete silhouette
//   stageBackground — optional; brand gradient sky if unfilled

import type { GameModule, RuntimeContext, LoadedAsset } from "@/lib/runtime/gameModule";
import {
  drawAssetContain,
  updateCelebrations,
  drawCelebration,
  type Celebration,
} from "@/lib/runtime/games/spriteRender";

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
const GROUND_FRACTION = 0.82; // ground line as a fraction of stage height

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
const LANE_COUNT = 4;
const RUNNER_CADENCE_HZ = 9; // leg swings per second for the generated athlete

// The finish gate, once spawned, is a solid object in the world rather than
// a timer: `durationSec` is still what decides WHEN it spawns.
const FINISH_GATE_WIDTH = 18;
const FINISH_OVERRUN_GRACE_SEC = 3; // hard stop if the gate somehow never lands

interface Obstacle {
  x: number;
  width: number;
  height: number;
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
  private billboardOffset = 0;
  private groundOffset = 0;

  /** World x of the finish gate, or null while the round is still running.
   * Non-null also means both spawners are switched off. */
  private finishX: number | null = null;

  private pool: LoadedAsset[] = [];
  private runnerAsset: LoadedAsset | null = null;
  private backgroundAsset: LoadedAsset | null = null;

  init(ctx: RuntimeContext): void {
    this.ctx = ctx;
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
    this.billboardOffset = 0;
    this.groundOffset = 0;
    this.finishX = null;

    this.pool = ctx.roles.collectible?.assets ?? [];
    this.runnerAsset = ctx.roles.runner?.assets[0] ?? null;
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

    // --- decorative scroll layers ---
    this.billboardOffset += speed * BILLBOARD_PARALLAX * dt;
    this.groundOffset += speed * dt;

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
    const scale = stageScale(stage.height);

    // Sky
    if (this.backgroundAsset?.image) {
      c.drawImage(this.backgroundAsset.image, 0, 0, stage.width, stage.height);
    } else {
      const sky = c.createLinearGradient(0, 0, 0, stage.height);
      sky.addColorStop(0, brand.background);
      sky.addColorStop(1, shade(brand.background, -0.08));
      c.fillStyle = sky;
      c.fillRect(0, 0, stage.width, stage.height);
    }

    // Stadium wall — behind everything on the track, in front of the sky.
    this.drawBillboards(c, groundY);

    // Track surface + lanes
    this.drawTrack(c, groundY);

    // Hurdles — generated shapes only, never a product.
    for (const obstacle of this.obstacles) {
      this.drawHurdle(c, obstacle, groundY);
    }

    // Collectibles, framed in a brand-accent token so a non-isolated photo
    // still reads as a deliberate pickup rather than a floating rectangle.
    for (const item of this.collectibles) {
      this.drawCollectible(c, item, COLLECTIBLE_SIZE * scale);
    }

    if (this.finishX !== null) this.drawFinishGate(c, this.finishX, groundY);

    this.drawRunner(c, stage.width * 0.18, groundY + this.runnerY, RUNNER_SIZE * scale);
    this.drawLives(c);

    // Celebrations last, so the just-grabbed product is the focal point.
    for (const celebration of this.celebrations) {
      drawCelebration(c, celebration, COLLECTIBLE_SIZE * scale * 2.2, brand.accent);
    }
  }

  teardown(): void {
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

  private billboardBandHeight(): number {
    return Math.max(
      BILLBOARD_BAND_MIN,
      Math.min(BILLBOARD_BAND_MAX, this.ctx.stage.height * BILLBOARD_BAND_FRACTION),
    );
  }

  /**
   * The perimeter advertising hoarding every real stadium has. Panels are
   * drawn straight from the scroll offset with a modulo — no per-panel
   * state, no array, nothing to allocate or garbage-collect per frame.
   *
   * `panelIndex` advances in lockstep with the offset, so a panel's content
   * stays attached to it as it scrolls off rather than flickering between
   * cycle slots.
   */
  private drawBillboards(c: CanvasRenderingContext2D, groundY: number): void {
    const { stage, brand } = this.ctx;
    const bandH = this.billboardBandHeight();
    const bandY = groundY - bandH;
    const panelW = bandH * 1.9;
    if (panelW <= 0) return;

    // Wall behind the panels, so the gaps read as structure rather than sky.
    c.fillStyle = shade(brand.background, -0.12);
    c.fillRect(0, bandY, stage.width, bandH);

    const gap = Math.max(4, panelW * 0.05);
    const innerW = panelW - gap;
    const innerH = bandH * 0.74;
    const innerY = bandY + (bandH - innerH) / 2;

    const shift = this.billboardOffset % panelW;
    let panelIndex = Math.floor(this.billboardOffset / panelW);
    for (let x = -shift; x < stage.width; x += panelW, panelIndex++) {
      this.drawBillboardPanel(c, panelIndex, x, innerY, innerW, innerH);
    }

    // Hoarding lip — a thin bright line reads as the top edge of a board.
    c.fillStyle = withAlpha(brand.foreground, 0.18);
    c.fillRect(0, bandY, stage.width, 2);
  }

  private drawBillboardPanel(
    c: CanvasRenderingContext2D,
    index: number,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    const { brand, brandLogo } = this.ctx;
    // Cycle: logo panel, wordmark panel, then up to three product panels.
    // Products on a hoarding are decoration — never recordEngagement().
    const productPanels = Math.min(BILLBOARD_PRODUCT_PANELS, this.pool.length);
    const slots = 2 + productPanels;
    const slot = ((index % slots) + slots) % slots;

    c.save();
    c.beginPath();
    roundedRect(c, x, y, w, h, Math.min(6, h * 0.12));
    c.fillStyle = slot === 1 ? brand.accent : shade(brand.background, 0.06);
    c.fill();
    c.clip();

    const pad = h * 0.16;
    if (slot === 0 && brandLogo) {
      drawImageContain(c, brandLogo, x + pad, y + pad, w - pad * 2, h - pad * 2);
    } else if (slot === 1) {
      const label = (brand.name || "").toUpperCase();
      if (label) {
        c.fillStyle = contrastOn(brand.accent, brand.foreground, brand.background);
        c.font = `700 ${Math.round(h * 0.34)}px ${brand.fontFamily}, system-ui, sans-serif`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(truncate(c, label, w - pad * 2), x + w / 2, y + h / 2);
      }
    } else if (productPanels > 0) {
      const asset = this.pool[(slot - 2) % this.pool.length];
      if (asset?.image) {
        drawAssetContain(c, asset, x + pad, y + pad, w - pad * 2, h - pad * 2);
      }
    }
    c.restore();

    c.strokeStyle = withAlpha(brand.accent, 0.55);
    c.lineWidth = 1.5;
    roundedRect(c, x, y, w, h, Math.min(6, h * 0.12));
    c.stroke();
  }

  /**
   * Track surface with lane markings. The lanes are decoration, not a
   * movement axis: this template is deliberately one-input (tap to jump) so
   * it stays playable in a 300x250 ad slot, and real lane-switching would
   * need a second axis. Dashes scroll via lineDashOffset — the cheapest way
   * to sell motion on a flat fill.
   */
  private drawTrack(c: CanvasRenderingContext2D, groundY: number): void {
    const { stage, brand } = this.ctx;
    const trackH = stage.height - groundY;

    c.fillStyle = shade(brand.background, -0.16);
    c.fillRect(0, groundY, stage.width, trackH);

    c.fillStyle = brand.foreground;
    c.globalAlpha = 0.25;
    c.fillRect(0, groundY, stage.width, 2);
    c.globalAlpha = 1;

    c.save();
    c.strokeStyle = brand.foreground;
    c.setLineDash([26, 20]);
    c.lineDashOffset = -this.groundOffset;
    for (let lane = 1; lane < LANE_COUNT; lane++) {
      const t = lane / LANE_COUNT;
      const y = groundY + trackH * t;
      // Nearer lanes (lower on screen) read brighter and heavier — a cheap
      // depth cue without any actual perspective transform.
      c.globalAlpha = 0.1 + 0.16 * t;
      c.lineWidth = 1 + 1.6 * t;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(stage.width, y);
      c.stroke();
    }
    c.restore();
  }

  /**
   * A hurdle, not a block. Same collision box as before (the caller passes
   * the unchanged obstacle rect) — this is purely how it reads, so nothing
   * about the difficulty or the score ceiling moves.
   *
   * Deliberately ONE thick top bar and two thin uprights, with no middle
   * rail: the obstacle box is taller than it is wide, and a second rail
   * across it made the whole thing read as a ladder rather than something
   * to clear. The bar is where the collision top actually is, so making it
   * the heaviest element is also the honest one.
   */
  private drawHurdle(c: CanvasRenderingContext2D, obstacle: Obstacle, groundY: number): void {
    const { brand } = this.ctx;
    const colour = brand.secondaryAccent || shade(brand.accent, -0.25);
    const top = groundY - obstacle.height;
    const postW = Math.max(1.5, obstacle.width * 0.1);
    const barH = Math.max(5, obstacle.height * 0.26);

    // Uprights, inset so the bar visibly overhangs them.
    c.fillStyle = colour;
    c.fillRect(obstacle.x + obstacle.width * 0.18, top + barH, postW, obstacle.height - barH);
    c.fillRect(obstacle.x + obstacle.width * 0.82 - postW, top + barH, postW, obstacle.height - barH);

    // Feet, splayed along the ground — inside the box, so nothing the
    // player can see sticks out past what the collision actually covers.
    c.fillRect(obstacle.x, groundY - Math.max(1.5, postW), obstacle.width, Math.max(1.5, postW));

    // The bar to clear: full width, accent-capped so it stays legible
    // against a billboard panel behind it.
    c.fillStyle = colour;
    roundedRect(c, obstacle.x, top, obstacle.width, barH, Math.min(3, barH / 2));
    c.fill();
    c.fillStyle = brand.accent;
    roundedRect(c, obstacle.x, top, obstacle.width, Math.max(2, barH * 0.4), Math.min(3, barH / 2));
    c.fill();
  }

  private drawFinishGate(c: CanvasRenderingContext2D, x: number, groundY: number): void {
    const { stage, brand, brandLogo } = this.ctx;
    const gantryY = groundY - this.billboardBandHeight() * 1.45;
    const postTop = Math.max(0, gantryY);

    // Chequered post.
    const square = 10;
    for (let y = groundY - square; y > postTop; y -= square) {
      const dark = Math.floor((groundY - y) / square) % 2 === 0;
      c.fillStyle = dark ? brand.foreground : brand.background;
      c.fillRect(x, y, FINISH_GATE_WIDTH, square);
    }

    // Gantry banner across the top of the post, carrying the logo.
    const bannerH = Math.max(22, this.billboardBandHeight() * 0.45);
    const bannerW = Math.min(stage.width * 0.55, bannerH * 5);
    const bannerX = x - bannerW / 2 + FINISH_GATE_WIDTH / 2;
    c.fillStyle = brand.accent;
    roundedRect(c, bannerX, postTop, bannerW, bannerH, 6);
    c.fill();

    // The logo takes the left third when there is one; without it the word
    // centres on the whole banner rather than sitting off to one side with
    // dead space where the logo would have been.
    const pad = bannerH * 0.2;
    const logoW = brandLogo ? bannerW * 0.3 : 0;
    if (brandLogo) {
      drawImageContain(c, brandLogo, bannerX + pad, postTop + pad, logoW, bannerH - pad * 2);
    }
    c.fillStyle = contrastOn(brand.accent, brand.foreground, brand.background);
    c.font = `700 ${Math.round(bannerH * 0.48)}px ${brand.fontFamily}, system-ui, sans-serif`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText("FINISH", bannerX + logoW + (bannerW - logoW) / 2, postTop + bannerH / 2);
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
    c.fillStyle = item.asset.backgroundColor || brand.accent;
    c.fill();
    c.clip();
    if (item.asset.image) {
      drawAssetContain(c, item.asset, item.x - half, item.y - half, size, size);
    }
    c.restore();

    c.save();
    c.strokeStyle = brand.accent;
    c.lineWidth = Math.max(2, size * 0.06);
    c.beginPath();
    c.arc(item.x, item.y, half, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }

  private drawRunner(c: CanvasRenderingContext2D, x: number, feetY: number, size: number): void {
    const { brand, brandLogo } = this.ctx;
    const left = x - size / 2;
    const top = feetY - size;

    c.save();
    // Blink while invulnerable so a hit is legible without a HUD message.
    if (this.invulnerableFor > 0 && Math.floor(this.invulnerableFor * 8) % 2 === 0) {
      c.globalAlpha = 0.35;
    }

    if (this.runnerAsset?.image) {
      drawAssetContain(c, this.runnerAsset, left, top, size, size);
    } else if (brandLogo) {
      // "logo" fallback per the capability. Never recorded as engagement —
      // it's brand identity, not a product the player succeeded against.
      c.drawImage(brandLogo, left, top, size, size);
    } else {
      this.drawAthlete(c, x, feetY, size);
    }
    c.restore();
  }

  /**
   * Generated-shape fallback: a running athlete built from primitives in
   * brand.accent. Replaces the plain rounded square this used to draw — on
   * a sports brand the avatar IS the theme, and a square reads as a
   * placeholder. Legs swing on a sine when grounded and tuck when airborne,
   * which is enough motion to read as running without a sprite sheet.
   */
  private drawAthlete(c: CanvasRenderingContext2D, x: number, feetY: number, size: number): void {
    const { brand } = this.ctx;
    const airborne = this.runnerY < 0;
    const swing = airborne ? 0.75 : Math.sin(this.elapsed * RUNNER_CADENCE_HZ);

    const headR = size * 0.13;
    const headY = feetY - size * 0.86;
    const shoulderY = feetY - size * 0.7;
    const hipY = feetY - size * 0.42;
    const stride = size * 0.3;
    const lift = airborne ? size * 0.16 : 0;

    c.save();
    c.strokeStyle = brand.accent;
    c.fillStyle = brand.accent;
    c.lineWidth = Math.max(2, size * 0.13);
    c.lineCap = "round";
    c.lineJoin = "round";

    c.beginPath();
    c.arc(x, headY, headR, 0, Math.PI * 2);
    c.fill();

    // Torso, leant forward into the run.
    c.beginPath();
    c.moveTo(x - size * 0.05, shoulderY);
    c.lineTo(x + size * 0.03, hipY);
    c.stroke();

    // Legs: one forward, one trailing, mirrored on the swing.
    c.beginPath();
    c.moveTo(x + size * 0.03, hipY);
    c.lineTo(x + swing * stride, feetY - lift);
    c.moveTo(x + size * 0.03, hipY);
    c.lineTo(x - swing * stride, feetY - lift * 1.6);
    c.stroke();

    // Arms, counter-swinging.
    c.lineWidth = Math.max(1.5, size * 0.1);
    c.beginPath();
    c.moveTo(x - size * 0.05, shoulderY);
    c.lineTo(x - swing * stride * 0.8, shoulderY + size * 0.18);
    c.moveTo(x - size * 0.05, shoulderY);
    c.lineTo(x + swing * stride * 0.8, shoulderY + size * 0.12);
    c.stroke();
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
        c.fillStyle = brand.accent;
        c.fill();
      } else {
        c.strokeStyle = brand.foreground;
        c.globalAlpha = 0.35;
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

/** Picks whichever of two brand colours is more readable on `background`.
 * brand.foreground is contrast-forced against brand.background, not against
 * brand.accent, so text on an accent-filled panel needs its own check. */
function contrastOn(background: string, a: string, b: string): string {
  const bg = relativeLuminance(background);
  return Math.abs(relativeLuminance(a) - bg) >= Math.abs(relativeLuminance(b) - bg) ? a : b;
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return 0.5;
  const num = parseInt(clean, 16);
  const r = ((num >> 16) & 0xff) / 255;
  const g = ((num >> 8) & 0xff) / 255;
  const b = (num & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** #rrggbb -> rgba() at the given alpha; returns the input unchanged if it
 * isn't a 6-digit hex, so a malformed brand colour degrades visibly rather
 * than painting transparent. */
function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return hex;
  const num = parseInt(clean, 16);
  return `rgba(${(num >> 16) & 0xff}, ${(num >> 8) & 0xff}, ${num & 0xff}, ${alpha})`;
}

/** Darkens (negative amt) or lightens a #rrggbb hex colour by `amt` (-1..1). */
function shade(hex: string, amt: number): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return hex;
  const num = parseInt(clean, 16);
  const adjust = (channel: number) => Math.min(255, Math.max(0, Math.round(channel + 255 * amt)));
  const r = adjust((num >> 16) & 0xff);
  const g = adjust((num >> 8) & 0xff);
  const b = adjust(num & 0xff);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function createRunnerGame(): GameModule {
  return new RunnerGame();
}
