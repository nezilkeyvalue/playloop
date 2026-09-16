// lib/runtime/games/sweetSpot.ts
//
// Sweet Spot: a marker sweeps back and forth along a bar and the player taps
// to stop it inside a target zone. Every hit shrinks the zone and speeds the
// marker up; a miss costs a life. Capability schema: lib/capabilities/sweet_spot.json.
//
// Why this template exists: it is the only one with NO hard-required role.
// catch needs 4 isolatable collectibles and guess_price needs a priced hero,
// so both go ineligible on a site whose extraction yields almost nothing —
// a real run against deathwishcoffee.com produced exactly two usable assets
// and knocked both templates out. Sweet Spot plays correctly with zero
// assets (brand colour + the logo fallback), so it is always available as a
// floor. Keep it that way: never add a role with `fallback: "none"` here.
//
// Tuning knobs honored (all read from ctx.tuning, already clamped to the
// capability's ranges by mount.ts):
//   sweepSpeedHz — one-way traversals of the bar per second, at the start
//   zoneWidth    — target zone width as a fraction of the bar, at the start
//   zoneShrink   — multiplier applied to the zone width after each hit
//   lives        — misses allowed before the run ends
//   durationSec  — total run time
//
// Roles honored:
//   prize           — optional; the product shown above the bar, rotated on
//                     each hit. Falls back to the brand logo ("logo" per the
//                     capability), and to a plain brand-accent medallion when
//                     there is no logo either.
//   stageBackground — optional; brand gradient if unfilled

import type { GameModule, RuntimeContext, LoadedAsset } from "@/lib/runtime/gameModule";

// Scoring constants. Chosen so maxRealisticScore() at the capability's
// *default* tuning (sweepSpeedHz 0.7, zoneWidth 0.2, zoneShrink 0.9,
// durationSec 40) lands close to sweet_spot.json's scoring.maxRealistic (800):
//   hitsUntilTooSmall = ln(MIN_RELIABLE_ZONE / zoneWidth) / ln(zoneShrink)
//                     = ln(0.055 / 0.2) / ln(0.9)              ≈ 12.3
//   attemptsInTime    = durationSec * sweepSpeedHz * HIT_RATE
//                     = 40 * 0.7 * 0.75                        = 21
//   expectedHits      = min(12.3, 21)                          ≈ 12.3
//   pointsPerHit      = BASE + BONUS * AVG_ACCURACY = 40 + 40 * 0.6 = 64
//   maxRealisticScore ≈ 12.3 * 64                              ≈ 787
// The shrink term is what actually ends a default run — the player runs out
// of precision before they run out of clock, which is the intended shape.
const POINTS_PER_HIT = 40;
const ACCURACY_BONUS = 40;
const AVG_ACCURACY = 0.6; // mean centre-closeness a competent player lands
const REALISTIC_HIT_RATE = 0.75;
const MIN_RELIABLE_ZONE = 0.055; // zone fraction below which hits stop being repeatable

// Each hit also nudges the marker faster, so difficulty ramps on two axes.
const SPEEDUP_PER_HIT = 1.04;
const MAX_SPEED_MULTIPLIER = 2.6;

const FEEDBACK_SEC = 0.45; // how long a hit/miss flash stays up
const HUD_HEIGHT = 34; // reserved strip at the top for score + lives

export function maxRealisticScore(tuning: Record<string, number>): number {
  const sweepSpeedHz = tuning.sweepSpeedHz ?? 0.7;
  const zoneWidth = tuning.zoneWidth ?? 0.2;
  const zoneShrink = tuning.zoneShrink ?? 0.9;
  const durationSec = tuning.durationSec ?? 40;

  const attemptsInTime = durationSec * sweepSpeedHz * REALISTIC_HIT_RATE;

  // zoneShrink === 1 means the zone never shrinks, so precision never runs
  // out and the clock is the only limit. Guard the log explicitly rather
  // than letting ln(1) === 0 divide to Infinity.
  const hitsUntilTooSmall =
    zoneShrink >= 1 || zoneWidth <= MIN_RELIABLE_ZONE
      ? Number.POSITIVE_INFINITY
      : Math.log(MIN_RELIABLE_ZONE / zoneWidth) / Math.log(zoneShrink);

  const expectedHits = Math.max(1, Math.min(hitsUntilTooSmall, attemptsInTime));
  return Math.round(expectedHits * (POINTS_PER_HIT + ACCURACY_BONUS * AVG_ACCURACY));
}

class SweetSpotGame implements GameModule {
  id: "sweet_spot" = "sweet_spot";

  private ctx!: RuntimeContext;

  private markerPos = 0; // 0..1 along the bar
  private direction: 1 | -1 = 1;
  private speedMultiplier = 1;
  private zoneCenter = 0.5; // 0..1
  private zoneWidth = 0.2; // fraction of the bar
  private livesLeft = 3;
  private elapsed = 0;
  private hits = 0;
  private streak = 0;
  private feedback: { kind: "hit" | "miss"; t: number; at: number } | null = null;
  private prizePool: LoadedAsset[] = [];
  private prizeIndex = 0;
  private ended = false;

  init(ctx: RuntimeContext): void {
    this.ctx = ctx;
    this.markerPos = 0;
    this.direction = 1;
    this.speedMultiplier = 1;
    this.zoneWidth = ctx.tuning.zoneWidth ?? 0.2;
    this.livesLeft = Math.max(1, Math.round(ctx.tuning.lives ?? 3));
    this.elapsed = 0;
    this.hits = 0;
    this.streak = 0;
    this.feedback = null;
    this.ended = false;
    this.prizePool = ctx.roles.prize?.assets ?? [];
    this.prizeIndex = 0;
    this.zoneCenter = this.pickZoneCenter();
  }

  /** Keeps the zone clear of the bar ends, where a sweeping marker spends
   * the least predictable time (it reverses there). */
  private pickZoneCenter(): number {
    const margin = this.zoneWidth / 2 + 0.06;
    const span = Math.max(0, 1 - margin * 2);
    return margin + this.ctx.random() * span;
  }

  update(dt: number): void {
    if (this.ended) return;
    const { input, tuning } = this.ctx;

    this.elapsed += dt;
    if (this.feedback) {
      this.feedback.t -= dt;
      if (this.feedback.t <= 0) this.feedback = null;
    }

    // Advance the marker, bouncing at both ends.
    const baseHz = tuning.sweepSpeedHz ?? 0.7;
    this.markerPos += this.direction * baseHz * this.speedMultiplier * dt;
    if (this.markerPos >= 1) {
      this.markerPos = 1;
      this.direction = -1;
    } else if (this.markerPos <= 0) {
      this.markerPos = 0;
      this.direction = 1;
    }

    if (input.justPressed || input.confirmPressed) this.lockIn();

    const durationSec = tuning.durationSec ?? 40;
    if (this.elapsed >= durationSec) this.finish();
  }

  private lockIn(): void {
    const half = this.zoneWidth / 2;
    const distance = Math.abs(this.markerPos - this.zoneCenter);

    if (distance <= half) {
      // Closeness to the centre, 0..1 — dead centre is worth the full bonus.
      const closeness = half > 0 ? 1 - distance / half : 1;
      const points = Math.round(POINTS_PER_HIT + ACCURACY_BONUS * closeness);
      this.ctx.addScore(points);
      this.hits += 1;
      this.streak += 1;
      this.feedback = { kind: "hit", t: FEEDBACK_SEC, at: this.markerPos };

      // Ramp: tighter zone, faster sweep, new target position.
      this.zoneWidth = Math.max(
        MIN_RELIABLE_ZONE * 0.6,
        this.zoneWidth * (this.ctx.tuning.zoneShrink ?? 0.9),
      );
      this.speedMultiplier = Math.min(MAX_SPEED_MULTIPLIER, this.speedMultiplier * SPEEDUP_PER_HIT);
      if (this.prizePool.length > 0) {
        this.prizeIndex = (this.prizeIndex + 1) % this.prizePool.length;
      }
    } else {
      this.streak = 0;
      this.livesLeft -= 1;
      this.feedback = { kind: "miss", t: FEEDBACK_SEC, at: this.markerPos };
    }

    this.zoneCenter = this.pickZoneCenter();
    if (this.livesLeft <= 0) this.finish();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.ctx.complete();
  }

  render(c: CanvasRenderingContext2D): void {
    const { stage, brand } = this.ctx;
    const w = stage.width;
    const h = stage.height;

    this.renderBackground(c, w, h);

    // Layout: the prize medallion, its name, and the bar are one block,
    // centred vertically. Sizing off BOTH axes matters — this template
    // declares the `ad` placement, so it has to stay composed in a 728x90
    // as well as a 300x600.
    const barH = 14;
    const nameGap = 36; // medallion -> bar, leaves room for the product name
    const prizeSize = Math.max(56, Math.min(170, Math.min(w * 0.42, h * 0.34)));
    const groupH = prizeSize + nameGap + barH;
    const prizeY = Math.max(HUD_HEIGHT, (h - groupH) / 2);
    const barY = prizeY + prizeSize + nameGap;

    const barMargin = Math.max(20, Math.min(48, w * 0.08));
    const barX = barMargin;
    const barW = Math.max(40, w - barMargin * 2);

    this.renderPrize(c, w, prizeY, prizeSize);
    this.renderBar(c, barX, barY, barW, barH);
    this.renderHud(c, w, h, barY + barH);

    // Feedback flash over the tapped position.
    if (this.feedback) {
      const alpha = Math.max(0, this.feedback.t / FEEDBACK_SEC);
      const fx = barX + this.feedback.at * barW;
      c.globalAlpha = alpha;
      c.fillStyle = this.feedback.kind === "hit" ? brand.accent : "#d14343";
      c.beginPath();
      c.arc(fx, barY + barH / 2, 18 + (1 - alpha) * 22, 0, Math.PI * 2);
      c.fill();
      c.globalAlpha = 1;
    }
  }

  private renderBackground(c: CanvasRenderingContext2D, w: number, h: number): void {
    const { brand, roles } = this.ctx;
    const bg = roles.stageBackground?.assets[0];
    if (bg?.image) {
      // Cover-fit the backdrop. This is the one place a crop is correct:
      // it is a blurred/darkened backdrop, not a product being presented.
      const scale = Math.max(w / bg.width, h / bg.height);
      const dw = bg.width * scale;
      const dh = bg.height * scale;
      c.drawImage(bg.image, (w - dw) / 2, (h - dh) / 2, dw, dh);
      c.fillStyle = "rgba(0,0,0,0.45)";
      c.fillRect(0, 0, w, h);
      return;
    }
    // brandGradient fallback.
    const grad = c.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, brand.background);
    grad.addColorStop(1, mix(brand.background, brand.accent, 0.18));
    c.fillStyle = grad;
    c.fillRect(0, 0, w, h);
  }

  /** The product (or logo) being played for. Scaled to CONTAIN inside its
   * frame and matted with the asset's own background colour — never cropped.
   * See CLAUDE.md: cropping a photographic asset to fill a frame cuts into
   * the subject, and we have no subjectBounds to crop toward here. */
  private renderPrize(
    c: CanvasRenderingContext2D,
    w: number,
    y: number,
    size: number,
  ): void {
    const { brand } = this.ctx;
    const x = (w - size) / 2;
    const asset = this.prizePool[this.prizeIndex] ?? null;
    const radius = size / 2;

    c.save();
    c.beginPath();
    roundRect(c, x, y, size, size, radius);
    c.closePath();
    c.clip();

    c.fillStyle = asset?.backgroundColor ?? mix(brand.background, brand.accent, 0.1);
    c.fillRect(x, y, size, size);

    if (asset?.image) {
      const scale = Math.min(size / asset.width, size / asset.height);
      const dw = asset.width * scale;
      const dh = asset.height * scale;
      c.drawImage(asset.image, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
    } else {
      // "logo" fallback had nothing to give — a plain accent medallion.
      c.fillStyle = brand.accent;
      c.beginPath();
      c.arc(x + size / 2, y + size / 2, size * 0.28, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();

    c.strokeStyle = withAlpha(brand.foreground, 0.16);
    c.lineWidth = 2;
    c.beginPath();
    roundRect(c, x, y, size, size, radius);
    c.stroke();

    const name = asset?.data?.name;
    if (name) {
      c.fillStyle = withAlpha(brand.foreground, 0.85);
      c.font = `600 15px ${brand.fontFamily}, system-ui, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "top";
      c.fillText(truncate(c, name, w - 40), w / 2, y + size + 10);
    }
  }

  private renderBar(
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    const { brand } = this.ctx;

    // Track.
    c.fillStyle = withAlpha(brand.foreground, 0.12);
    c.beginPath();
    roundRect(c, x, y, w, h, h / 2);
    c.fill();

    // Target zone.
    const zoneW = Math.max(4, this.zoneWidth * w);
    const zoneX = x + this.zoneCenter * w - zoneW / 2;
    c.fillStyle = brand.accent;
    c.beginPath();
    roundRect(c, zoneX, y, zoneW, h, h / 2);
    c.fill();

    // Marker.
    const mx = x + this.markerPos * w;
    c.fillStyle = brand.foreground;
    c.beginPath();
    roundRect(c, mx - 2.5, y - 9, 5, h + 18, 2.5);
    c.fill();
  }

  private renderHud(
    c: CanvasRenderingContext2D,
    w: number,
    h: number,
    promptY: number,
  ): void {
    const { brand, tuning } = this.ctx;
    const pad = 16;

    c.textBaseline = "top";
    c.font = `600 14px ${brand.fontFamily}, system-ui, sans-serif`;

    c.textAlign = "left";
    c.fillStyle = withAlpha(brand.foreground, 0.75);
    c.fillText(`${this.ctx.getScore()}`, pad, pad);

    // Lives as dots, top-right.
    const maxLives = Math.max(1, Math.round(tuning.lives ?? 3));
    for (let i = 0; i < maxLives; i++) {
      const cx = w - pad - i * 16 - 5;
      c.beginPath();
      c.arc(cx, pad + 7, 5, 0, Math.PI * 2);
      c.fillStyle =
        i < this.livesLeft ? brand.accent : withAlpha(brand.foreground, 0.18);
      c.fill();
    }

    // Prompt, centred just under the bar.
    c.textAlign = "center";
    c.fillStyle = withAlpha(brand.foreground, 0.55);
    c.font = `500 13px ${brand.fontFamily}, system-ui, sans-serif`;
    const prompt =
      this.hits === 0 ? "Tap when the marker hits the coloured zone" : `Streak ${this.streak}`;
    c.fillText(prompt, w / 2, Math.min(h - 20, promptY + 20));
  }

  teardown(): void {
    this.prizePool = [];
    this.feedback = null;
  }

  maxRealisticScore(tuning: Record<string, number>): number {
    return maxRealisticScore(tuning);
  }
}

// ---------------------------------------------------------------------------
// Small local drawing helpers. Kept here rather than shared because each game
// module owns its own look; nothing else needs these.
// ---------------------------------------------------------------------------

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + radius, y);
  c.arcTo(x + w, y, x + w, y + h, radius);
  c.arcTo(x + w, y + h, x, y + h, radius);
  c.arcTo(x, y + h, x, y, radius);
  c.arcTo(x, y, x + w, y, radius);
  c.closePath();
}

/** #rrggbb -> rgba() at the given alpha. Falls back to the input string if it
 * isn't a 6-digit hex, so a malformed brand colour degrades instead of
 * painting transparent. */
function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const m = ca.map((v, i) => Math.round(v + ((cb[i] ?? v) - v) * t));
  return `rgb(${m[0]}, ${m[1]}, ${m[2]})`;
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function truncate(c: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (c.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && c.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

export function createSweetSpotGame(): GameModule {
  return new SweetSpotGame();
}
