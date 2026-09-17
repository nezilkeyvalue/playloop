// lib/runtime/games/runner.ts
//
// Runner: the brand mascot runs right-to-left past obstacles; one input
// (tap / space / ArrowUp) jumps. Capability: lib/capabilities/runner.json.
//
// Two deliberate departures from the Chrome dinosaur it borrows from:
//
//   1. Obstacles are NEVER assets. They're generated brand-colour blocks,
//      full stop — there is no hazard role in the capability. A product is
//      only ever a good thing to hit, so ctx.recordEngagement() can't leak
//      onto a hazard by construction.
//   2. It isn't one-hit-death. A round is `lives` hits OR `durationSec`,
//      whichever comes first, because a one-hit runner can end three
//      seconds in and hand the player a reward screen with zero products
//      engaged — the worst possible outcome for the thing this repo exists
//      to do.
//
// Grabbing a collectible fires a Celebration (spriteRender.ts): the product
// grows and fades centre-stage for ~0.45s while the world keeps scrolling.
// A side-scroller otherwise never lets a product sit still long enough to
// read, which is the one real weakness of the genre here.
//
// Tuning knobs honored (already clamped to capability ranges by mount.ts):
//   scrollSpeed        — px/sec the world moves at, ramped over the round
//   obstacleRateHz     — obstacle spawns per second
//   collectibleRateHz  — product spawns per second
//   lives              — hits allowed before the round ends early
//   durationSec        — total run time
//
// Roles honored:
//   collectible     — required (fallback "none"); the products to grab
//   runner          — the jumper; brand logo per the capability's "logo"
//                     fallback, else a brand-accent rounded square
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
// arcade counter.
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
const SPEED_RAMP = 1.4; // scrollSpeed multiplier reached at the end of the round
const INVULNERABLE_SEC = 1.2;
const GROUND_FRACTION = 0.82; // ground line as a fraction of stage height

const RUNNER_SIZE = 52;
const COLLECTIBLE_SIZE = 46;
const OBSTACLE_WIDTH = 26;
const OBSTACLE_MIN_HEIGHT = 34;
const OBSTACLE_MAX_HEIGHT = 62;

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

    // --- spawning ---
    const progress = durationSec > 0 ? Math.min(1, this.elapsed / durationSec) : 0;
    const speed = (tuning.scrollSpeed ?? 260) * (1 + (SPEED_RAMP - 1) * progress);

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

    // --- movement + collision ---
    const groundY = stage.height * GROUND_FRACTION;
    const runnerX = stage.width * 0.18;
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

    if (this.livesLeft <= 0 || this.elapsed >= durationSec) {
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

    // Ground line + dirt
    c.fillStyle = shade(brand.background, -0.16);
    c.fillRect(0, groundY, stage.width, stage.height - groundY);
    c.fillStyle = brand.foreground;
    c.globalAlpha = 0.25;
    c.fillRect(0, groundY, stage.width, 2);
    c.globalAlpha = 1;

    // Obstacles — generated shapes only, never a product.
    c.fillStyle = brand.secondaryAccent || shade(brand.accent, -0.25);
    for (const obstacle of this.obstacles) {
      roundedRect(c, obstacle.x, groundY - obstacle.height, obstacle.width, obstacle.height, 6);
      c.fill();
    }

    // Collectibles, framed in a brand-accent token so a non-isolated photo
    // still reads as a deliberate pickup rather than a floating rectangle.
    for (const item of this.collectibles) {
      this.drawCollectible(c, item, COLLECTIBLE_SIZE * scale);
    }

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
      c.fillStyle = brand.accent;
      roundedRect(c, left, top, size, size, 12 * (size / RUNNER_SIZE));
      c.fill();
    }
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
