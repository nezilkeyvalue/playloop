// lib/runtime/games/guessPrice.ts
//
// Guess the Price: a hero product is shown, the player drags a slider (or
// nudges it with arrow keys) to guess its price, and scores by closeness
// within tuning.tolerancePercent. Runs tuning.roundCount rounds of
// tuning.roundSeconds each. Build spec §13 / capability schema §2
// (lib/capabilities/guess_price.json).
//
// Tuning knobs honored:
//   roundCount        — number of rounds
//   roundSeconds      — seconds allotted per round before auto-lock
//   tolerancePercent  — how close (as % of the true price) counts as "close"
//   durationSec       — safety cap on total play time (rounds should already
//                        sum close to this; guards a malformed spec)
//
// Roles honored:
//   hero            — required (fallback "none"); the product shown each round.
//                     Needs `data.priceMinor` (guess_price.json declares
//                     priceMinor as a *required* data field).
//   stageBackground — optional; brand gradient if unfilled.

import type { GameModule, RuntimeContext, LoadedAsset } from "@/lib/runtime/gameModule";
import {
  drawAssetContain,
  drawBrandBackground,
  fillGlossyCircle,
  shadeHex,
  withDropShadow,
  updateCelebrations,
  drawCelebration,
  type Celebration,
} from "@/lib/runtime/games/spriteRender";

// Scoring constants, chosen so maxRealisticScore() at the capability's
// default tuning (roundCount 6) lands close to guess_price.json's
// scoring.maxRealistic (1500):
//   6 rounds * BASE_POINTS_PER_ROUND(280) * REALISTIC_ROUND_FACTOR(0.9) ≈ 1512
const BASE_POINTS_PER_ROUND = 280;
const REALISTIC_ROUND_FACTOR = 0.9;

const SLIDER_MARGIN = 32;
const SLIDER_HEIGHT = 12;
const SLIDER_KNOB_RADIUS = 14;
const ROUND_INTRO_DURATION = 0.35;
const SCORE_FLASH_LIFE = 0.9;
const SCORE_FLASH_RISE_PX = 26;

export function maxRealisticScore(tuning: Record<string, number>): number {
  const roundCount = tuning.roundCount ?? 6;
  return Math.round(roundCount * BASE_POINTS_PER_ROUND * REALISTIC_ROUND_FACTOR);
}

function scoreRound(guessMinor: number, priceMinor: number, tolerancePercent: number): number {
  const priceBasis = Math.max(priceMinor, 1);
  const diffRatio = Math.abs(guessMinor - priceMinor) / priceBasis;
  const tol = Math.max(tolerancePercent, 1) / 100;

  if (diffRatio <= tol) {
    // Full credit at a perfect guess, decaying to 50% credit at the edge
    // of the tolerance band.
    const closeness = 1 - diffRatio / tol;
    return Math.round(BASE_POINTS_PER_ROUND * (0.5 + 0.5 * closeness));
  }

  // Outside tolerance: partial credit tapering to zero over the next
  // 2x-tolerance band, then nothing.
  const falloff = Math.max(0, 1 - (diffRatio - tol) / (tol * 2));
  return Math.round(BASE_POINTS_PER_ROUND * 0.5 * falloff);
}

interface RoundResult {
  asset: LoadedAsset;
  guessMinor: number;
  priceMinor: number;
  points: number;
}

class GuessPriceGame implements GameModule {
  id: "guess_price" = "guess_price";

  private ctx!: RuntimeContext;
  private heroes: LoadedAsset[] = [];
  private roundOrder: LoadedAsset[] = [];
  private roundIndex = 0;
  private roundTimeLeft = 0;
  private totalElapsed = 0;
  private guessMinor = 0;
  private sliderMax = 100_00; // minor units; recomputed in init()
  private results: RoundResult[] = [];
  private ended = false;
  private scoreFlash: { text: string; life: number } | null = null;
  private roundIntroT = 0; // seconds since the current round's hero appeared; drives its scale-in
  private celebrations: Celebration[] = [];

  init(ctx: RuntimeContext): void {
    this.ctx = ctx;
    this.heroes = (ctx.roles.hero?.assets ?? []).filter((a) => typeof a.data?.priceMinor === "number");
    this.roundIndex = 0;
    this.totalElapsed = 0;
    this.results = [];
    this.ended = false;

    const roundCount = Math.max(1, Math.round(ctx.tuning.roundCount ?? 6));

    // Build a round order that cycles through heroes without immediate
    // repeats when there are enough of them, and pads out with repeats if
    // roundCount exceeds the pool (a thin fixture with 1-2 hero assets
    // should still produce a full game).
    this.roundOrder = [];
    if (this.heroes.length > 0) {
      const shuffled = [...this.heroes].sort(() => ctx.random() - 0.5);
      for (let i = 0; i < roundCount; i++) {
        const chosen = shuffled[i % shuffled.length];
        if (chosen) this.roundOrder.push(chosen);
      }
    }

    const maxPrice = this.heroes.reduce((max, a) => Math.max(max, a.data?.priceMinor ?? 0), 100);
    this.sliderMax = Math.max(200, Math.round((maxPrice * 1.6) / 100) * 100);
    this.guessMinor = Math.round(this.sliderMax / 2);

    this.startRound();
  }

  update(dt: number): void {
    if (this.ended) return;
    const { input, tuning } = this.ctx;

    this.totalElapsed += dt;
    this.roundTimeLeft -= dt;
    this.roundIntroT += dt;
    if (this.scoreFlash) {
      this.scoreFlash.life -= dt;
      if (this.scoreFlash.life <= 0) this.scoreFlash = null;
    }
    this.celebrations = updateCelebrations(this.celebrations, dt);

    // --- slider control: drag or arrow keys ---
    const track = this.sliderTrackRect();
    if (input.pointerDown && input.pointerY >= track.y - 24 && input.pointerY <= track.y + track.height + 24) {
      const t = clamp01((input.pointerX - track.x) / track.width);
      this.guessMinor = Math.round(t * this.sliderMax);
    }
    const keyStep = this.sliderMax * 0.35 * dt; // reach either end in ~3s of holding
    if (input.keysDown.has("ArrowLeft") || input.keysDown.has("ArrowDown")) {
      this.guessMinor = Math.max(0, this.guessMinor - keyStep);
    }
    if (input.keysDown.has("ArrowRight") || input.keysDown.has("ArrowUp")) {
      this.guessMinor = Math.min(this.sliderMax, this.guessMinor + keyStep);
    }

    if (input.confirmPressed) {
      this.lockInRound();
    }

    const durationSafetyCap = (tuning.durationSec ?? 40) + 5;
    if (this.roundTimeLeft <= 0) {
      this.lockInRound();
    } else if (this.totalElapsed >= durationSafetyCap) {
      this.finish();
    }
  }

  render(c: CanvasRenderingContext2D): void {
    const { stage, brand } = this.ctx;

    // Background
    if (!this.ctx.roles.stageBackground?.assets.length) {
      drawBrandBackground(c, stage.width, stage.height, brand.background, brand.accent);
    } else {
      const bg = this.ctx.roles.stageBackground!.assets[0]?.image ?? null;
      if (bg) c.drawImage(bg, 0, 0, stage.width, stage.height);
    }

    const hero = this.roundOrder[this.roundIndex];
    let heroCx = stage.width / 2;
    let heroCy = stage.height * 0.16;
    if (hero?.image) {
      const size = Math.min(stage.width, stage.height) * 0.5;
      // A quick ease-out scale-in when a round's hero first appears, so a
      // fresh round reads as a small reveal rather than an abrupt swap.
      const introProgress = Math.min(1, this.roundIntroT / ROUND_INTRO_DURATION);
      const scale = 0.85 + 0.15 * (1 - Math.pow(1 - introProgress, 3));
      const drawSize = size * scale;
      heroCx = stage.width / 2;
      heroCy = stage.height * 0.16 + size / 2;
      withDropShadow(c, () =>
        drawAssetContain(c, hero, heroCx - drawSize / 2, heroCy - drawSize / 2, drawSize, drawSize),
      );
    }

    this.drawSlider(c);

    if (hero?.data?.name) {
      c.save();
      c.fillStyle = brand.foreground;
      c.font = `600 16px ${fontFamilyForCanvas(brand.fontFamily)}`;
      c.textAlign = "center";
      c.fillText(hero.data.name, stage.width / 2, stage.height * 0.14);
      c.restore();
    }

    if (this.scoreFlash) {
      const lifeRatio = clamp01(this.scoreFlash.life / SCORE_FLASH_LIFE);
      let alpha = 1;
      if (lifeRatio > 0.85) alpha = (1 - lifeRatio) / 0.15;
      else if (lifeRatio < 0.4) alpha = lifeRatio / 0.4;

      c.save();
      c.globalAlpha = clamp01(alpha);
      c.fillStyle = brand.accent;
      c.font = `800 24px ${fontFamilyForCanvas(brand.fontFamily)}`;
      c.textAlign = "center";
      c.fillText(this.scoreFlash.text, stage.width / 2, heroCy - 20 - (1 - lifeRatio) * SCORE_FLASH_RISE_PX);
      c.restore();
    }

    for (const cel of this.celebrations) {
      drawCelebration(c, cel, Math.min(stage.width, stage.height) * 0.22, brand.accent);
    }
  }

  teardown(): void {
    this.roundOrder = [];
    this.results = [];
    this.celebrations = [];
  }

  timeRemaining(): { secondsLeft: number; totalSeconds: number } | null {
    // The PER-ROUND clock, not the run total: roundSeconds is what actually
    // pressures the player into locking a guess, while durationSec is only
    // a safety cap on the whole session (see this file's header).
    const total = this.ctx.tuning.roundSeconds ?? 7;
    return { secondsLeft: Math.max(0, this.roundTimeLeft), totalSeconds: total };
  }

  maxRealisticScore(tuning: Record<string, number>): number {
    return maxRealisticScore(tuning);
  }

  private startRound(): void {
    const roundSeconds = this.ctx.tuning.roundSeconds ?? 7;
    this.roundTimeLeft = roundSeconds;
    this.guessMinor = Math.round(this.sliderMax / 2);
    this.roundIntroT = 0;

    // Every round shows a real hero regardless of guess accuracy, so
    // showing it at all is a genuine engagement — not gated on scoring.
    const hero = this.roundOrder[this.roundIndex];
    if (hero) this.ctx.recordEngagement(hero.id);
  }

  private lockInRound(): void {
    if (this.ended) return;
    const hero = this.roundOrder[this.roundIndex];
    if (hero && typeof hero.data?.priceMinor === "number") {
      const tolerancePercent = this.ctx.tuning.tolerancePercent ?? 15;
      const points = scoreRound(this.guessMinor, hero.data.priceMinor, tolerancePercent);
      this.ctx.addScore(points);
      // Closer guess -> higher ping; a zero-point guess reads as a miss.
      if (points <= 0) this.ctx.sound.play("fail");
      else this.ctx.sound.play("success", { semitones: Math.round((points / BASE_POINTS_PER_ROUND) * 7) });
      this.results.push({ asset: hero, guessMinor: this.guessMinor, priceMinor: hero.data.priceMinor, points });
      this.scoreFlash = { text: `+${points}`, life: SCORE_FLASH_LIFE };
      // The moment of success: locking in a guess on a real hero is worth
      // the same brief "look at this" beat every other template gives its
      // catch/pop/hit — this template never used the Celebration primitive
      // before despite showing a real product every single round.
      if (hero.image) {
        this.celebrations.push({
          asset: hero,
          x: this.ctx.stage.width / 2,
          y: this.ctx.stage.height * 0.16 + (Math.min(this.ctx.stage.width, this.ctx.stage.height) * 0.5) / 2,
          t: 0,
        });
      }
    }

    this.roundIndex += 1;
    if (this.roundIndex >= this.roundOrder.length) {
      this.finish();
    } else {
      this.startRound();
    }
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.ctx.complete();
  }

  private sliderTrackRect() {
    const { stage } = this.ctx;
    const y = stage.height - 56;
    return { x: SLIDER_MARGIN, y, width: stage.width - SLIDER_MARGIN * 2, height: SLIDER_HEIGHT };
  }

  private drawSlider(c: CanvasRenderingContext2D): void {
    const { brand } = this.ctx;
    const track = this.sliderTrackRect();
    const t = clamp01(this.guessMinor / this.sliderMax);
    const knobX = track.x + t * track.width;
    const knobY = track.y + track.height / 2;

    c.save();
    c.fillStyle = brand.foreground + "18";
    roundedRect(c, track.x, track.y, track.width, track.height, track.height / 2);
    c.fill();

    const fillGrad = c.createLinearGradient(track.x, 0, knobX, 0);
    fillGrad.addColorStop(0, shadeHex(brand.accent, -0.1));
    fillGrad.addColorStop(1, brand.accent);
    c.fillStyle = fillGrad;
    roundedRect(c, track.x, track.y, Math.max(track.height, knobX - track.x), track.height, track.height / 2);
    c.fill();
    c.restore();

    withDropShadow(
      c,
      () => fillGlossyCircle(c, knobX, knobY, SLIDER_KNOB_RADIUS, brand.accent),
      { blur: 8, offsetY: 3 },
    );

    c.save();
    c.fillStyle = brand.foreground;
    c.font = `700 24px ${fontFamilyForCanvas(brand.fontFamily)}`;
    c.textAlign = "center";
    c.fillText(formatMinor(this.guessMinor), track.x + track.width / 2, track.y - 20);
    c.restore();
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function roundedRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  if (w <= 0 || h <= 0) return;
  c.beginPath();
  c.moveTo(x + radius, y);
  c.arcTo(x + w, y, x + w, y + h, radius);
  c.arcTo(x + w, y + h, x, y + h, radius);
  c.arcTo(x, y + h, x, y, radius);
  c.arcTo(x, y, x + w, y, radius);
  c.closePath();
}

function formatMinor(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

function fontFamilyForCanvas(fontFamily: string): string {
  return fontFamily || "system-ui, sans-serif";
}

export function createGuessPriceGame(): GameModule {
  return new GuessPriceGame();
}
