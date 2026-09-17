// lib/runtime/games/pour.ts
//
// Perfect Pour: liquid rises in a branded cup and the player taps to stop
// it inside a fill band near the rim. Land in the band and the cup is
// served onto a tray; let it run past and the cup overflows, costing a
// life. Every serve tightens the band and speeds the pour up.
// Capability: lib/capabilities/pour.json.
//
// Why this exists as its own template rather than a sweet_spot reskin: the
// mechanic is sweet_spot's timing check, but the fail state is different in
// a way that matters. sweet_spot's miss is "you tapped outside the zone",
// which needs a written prompt to explain; an overflowing cup explains
// itself, and it is the failure a real pour actually has. The scoring math
// IS sweet_spot's, deliberately — same constants, same derivation — because
// re-deriving a second timing-accuracy curve would just be two numbers to
// keep in sync.
//
// Like sweet_spot, this template has NO role with `fallback: "none"`, so it
// stays eligible on a site whose extraction yields almost nothing. That is
// not incidental: coffee and beverage sites — exactly the merchants this
// template suits — are routinely the low-asset case (deathwishcoffee.com
// yields two usable assets). Don't add a hard-required role here.
//
// Brand surfaces, in order of screen time:
//   - The cup's sleeve carries the brand logo and is on screen every frame
//     of every cup, dead centre.
//   - The liquid takes the poured product's own sampled background colour
//     where it has one, so the cup fills with something that looks like
//     what is being poured rather than a generic accent wash.
//   - The product itself sits tipped above the cup as the visible source of
//     the pour, and gets a Celebration on a successful serve.
//
// Tuning knobs honored (already clamped to capability ranges by mount.ts):
//   fillSpeed    — fraction of the cup filled per second, at the start
//   bandWidth    — fill band height as a fraction of the cup, at the start
//   bandShrink   — multiplier applied to the band after each serve
//   lives        — overflows allowed before the run ends
//   cupsToServe  — serves that end the run early (a "full tray")
//   durationSec  — total run time
//
// Roles honored:
//   prize           — optional; the product being poured, rotated per cup.
//                     Falls back to the brand logo per the capability, and
//                     to a plain accent bottle when there is no logo either.
//   stageBackground — optional; brand gradient if unfilled

import type { GameModule, RuntimeContext, LoadedAsset } from "@/lib/runtime/gameModule";
import {
  drawAssetContain,
  drawBrandBackground,
  shadeHex,
  withDropShadow,
  updateCelebrations,
  drawCelebration,
  isBrandLogoUrl,
  type Celebration,
} from "@/lib/runtime/games/spriteRender";

// Scoring constants, lifted from sweetSpot.ts on purpose (see the header).
// maxRealisticScore() at the capability's default tuning (fillSpeed 0.5,
// bandWidth 0.18, bandShrink 0.88, cupsToServe 12, durationSec 40) lands
// close to pour.json's scoring.maxRealistic (640):
//   secondsPerCup    = MEAN_BAND_CENTRE / fillSpeed = 0.7 / 0.5   = 1.4
//   attemptsInTime   = (40 / 1.4) * REALISTIC_SERVE_RATE          ≈ 21.4
//   servesUntilTight = ln(MIN_RELIABLE_BAND / bandWidth) / ln(bandShrink)
//                    = ln(0.05 / 0.18) / ln(0.88)                 ≈ 10.0
//   expectedServes   = min(12, 21.4, 10.0)                        ≈ 10.0
//   pointsPerServe   = BASE + BONUS * AVG_ACCURACY = 40 + 40 * 0.6 = 64
//   maxRealisticScore ≈ 10.0 * 64                                 ≈ 640
// As with sweet_spot, the shrink term is what ends a default run: the
// player runs out of precision before the clock or the tray runs out.
const POINTS_PER_SERVE = 40;
const ACCURACY_BONUS = 40;
const AVG_ACCURACY = 0.6;
const REALISTIC_SERVE_RATE = 0.75;
const MIN_RELIABLE_BAND = 0.05;
const MEAN_BAND_CENTRE = 0.7; // see pickBandCentre() — the mean of its range

// Each serve also speeds the pour up, so difficulty ramps on two axes.
const SPEEDUP_PER_SERVE = 1.05;
const MAX_SPEED_MULTIPLIER = 2.4;

const FEEDBACK_SEC = 0.5;
const OVERFLOW_HOLD_SEC = 0.45; // how long a spilling cup stays up before it resets
const HUD_HEIGHT = 34;
const TRAY_MAX_CUPS = 8; // how many served cups the tray shows before it stops growing

type Phase = "pouring" | "served" | "overflowing";

export function maxRealisticScore(tuning: Record<string, number>): number {
  const fillSpeed = tuning.fillSpeed ?? 0.5;
  const bandWidth = tuning.bandWidth ?? 0.18;
  const bandShrink = tuning.bandShrink ?? 0.88;
  const cupsToServe = tuning.cupsToServe ?? 12;
  const durationSec = tuning.durationSec ?? 40;

  const secondsPerCup = fillSpeed > 0 ? MEAN_BAND_CENTRE / fillSpeed : Number.POSITIVE_INFINITY;
  const attemptsInTime = secondsPerCup > 0 ? (durationSec / secondsPerCup) * REALISTIC_SERVE_RATE : 0;

  // bandShrink === 1 means the band never tightens, so precision never runs
  // out and only the clock and the tray bound the run. Guard the log
  // explicitly rather than letting ln(1) === 0 divide to Infinity.
  const servesUntilTight =
    bandShrink >= 1 || bandWidth <= MIN_RELIABLE_BAND
      ? Number.POSITIVE_INFINITY
      : Math.log(MIN_RELIABLE_BAND / bandWidth) / Math.log(bandShrink);

  const expected = Math.max(1, Math.min(cupsToServe, attemptsInTime, servesUntilTight));
  return Math.round(expected * (POINTS_PER_SERVE + ACCURACY_BONUS * AVG_ACCURACY));
}

class PourGame implements GameModule {
  id: "pour" = "pour";

  private ctx!: RuntimeContext;

  private fill = 0; // 0..1 up the cup
  private bandCentre = 0.7; // 0..1
  private bandWidth = 0.18; // fraction of the cup
  private speedMultiplier = 1;
  private phase: Phase = "pouring";
  private phaseT = 0;
  private livesLeft = 3;
  private served = 0;
  private streak = 0;
  private elapsed = 0;
  private feedback: { kind: "serve" | "spill"; t: number } | null = null;
  private celebrations: Celebration[] = [];
  private prizePool: LoadedAsset[] = [];
  private prizeIndex = 0;
  private ended = false;

  init(ctx: RuntimeContext): void {
    this.ctx = ctx;
    this.fill = 0;
    this.bandWidth = ctx.tuning.bandWidth ?? 0.18;
    this.speedMultiplier = 1;
    this.phase = "pouring";
    this.phaseT = 0;
    this.livesLeft = Math.max(1, Math.round(ctx.tuning.lives ?? 3));
    this.served = 0;
    this.streak = 0;
    this.elapsed = 0;
    this.feedback = null;
    this.celebrations = [];
    this.prizePool = ctx.roles.prize?.assets ?? [];
    this.prizeIndex = 0;
    this.ended = false;
    this.bandCentre = this.pickBandCentre();
  }

  /** Keeps the band clear of both the bottom of the cup (where there is no
   * run-up and the tap would be immediate) and the very rim (where it would
   * be indistinguishable from an overflow). The midpoint of this range is
   * MEAN_BAND_CENTRE, which maxRealisticScore() relies on. */
  private pickBandCentre(): number {
    const low = 0.5;
    const high = 0.9 - this.bandWidth / 2;
    if (high <= low) return low;
    return low + this.ctx.random() * (high - low);
  }

  update(dt: number): void {
    if (this.ended) return;
    const { input, tuning } = this.ctx;

    this.elapsed += dt;
    this.celebrations = updateCelebrations(this.celebrations, dt);
    if (this.feedback) {
      this.feedback.t -= dt;
      if (this.feedback.t <= 0) this.feedback = null;
    }

    if (this.phase === "pouring") {
      this.fill += (tuning.fillSpeed ?? 0.5) * this.speedMultiplier * dt;
      if (input.justPressed || input.confirmPressed) {
        this.lockIn();
      } else if (this.fill >= 1) {
        this.spill();
      }
    } else {
      // A served or spilling cup holds on screen briefly so the player can
      // read the result, then the next cup starts.
      this.phaseT += dt;
      if (this.phaseT >= OVERFLOW_HOLD_SEC) this.nextCup();
    }

    const durationSec = tuning.durationSec ?? 40;
    const trayFull = this.served >= Math.round(tuning.cupsToServe ?? 12);
    if (this.elapsed >= durationSec || trayFull) this.finish();
  }

  private lockIn(): void {
    const half = this.bandWidth / 2;
    const distance = Math.abs(this.fill - this.bandCentre);

    if (distance > half) {
      // Tapped below the band — under-poured. Same cost as an overflow:
      // both are "this cup can't be served".
      this.spill();
      return;
    }

    const closeness = half > 0 ? 1 - distance / half : 1;
    this.ctx.addScore(Math.round(POINTS_PER_SERVE + ACCURACY_BONUS * closeness));
    this.served += 1;
    this.streak += 1;
    this.phase = "served";
    this.phaseT = 0;
    this.feedback = { kind: "serve", t: FEEDBACK_SEC };

    // The moment of success: the product on screen is what was just poured.
    // Guard on a real loaded image that isn't the brand's own logo — the
    // `prize` role's `fallback: "logo"` (and no subjectTypeIn restriction)
    // means this pool can genuinely contain the logo asset itself, which is
    // brand identity, not a product (see CLAUDE.md's hazards list, and
    // sweetSpot.ts, which hit exactly this).
    const poured = this.prizePool[this.prizeIndex];
    if (poured?.image && !isBrandLogoUrl(poured.image.src, this.ctx.brand.logoUrl)) {
      this.ctx.recordEngagement(poured.id);
      this.celebrations.push({
        asset: poured,
        x: this.ctx.stage.width / 2,
        y: this.ctx.stage.height * 0.34,
        t: 0,
      });
    }

    this.bandWidth = Math.max(MIN_RELIABLE_BAND * 0.6, this.bandWidth * (this.ctx.tuning.bandShrink ?? 0.88));
    this.speedMultiplier = Math.min(MAX_SPEED_MULTIPLIER, this.speedMultiplier * SPEEDUP_PER_SERVE);
  }

  private spill(): void {
    this.streak = 0;
    this.livesLeft -= 1;
    this.phase = "overflowing";
    this.phaseT = 0;
    this.fill = Math.min(1, this.fill);
    this.feedback = { kind: "spill", t: FEEDBACK_SEC };
  }

  private nextCup(): void {
    if (this.livesLeft <= 0) {
      this.finish();
      return;
    }
    this.fill = 0;
    this.phase = "pouring";
    this.phaseT = 0;
    this.bandCentre = this.pickBandCentre();
    if (this.prizePool.length > 0) {
      this.prizeIndex = (this.prizeIndex + 1) % this.prizePool.length;
    }
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

    // Layout, sized off BOTH axes: the product sits above the cup, the tray
    // below it, and the whole block centres. This template declares the ad
    // placement, so it has to stay composed in a 300x250 as well as a
    // 320x480.
    const trayH = Math.max(18, Math.min(34, h * 0.07));
    const available = h - HUD_HEIGHT - trayH - 16;
    const cupH = Math.max(90, Math.min(260, available * 0.62));
    const cupW = Math.max(70, Math.min(w * 0.46, cupH * 0.78));
    const bottleH = Math.max(40, Math.min(available - cupH - 12, cupH * 0.6));

    const cupX = (w - cupW) / 2;
    const bottleY = HUD_HEIGHT + 6;
    const cupY = bottleY + bottleH + 10;

    this.renderSource(c, w, bottleY, bottleH, cupY);
    this.renderCup(c, cupX, cupY, cupW, cupH);
    this.renderTray(c, w, h - trayH - 6, trayH);
    this.renderHud(c, w, h);

    // Last, so the product just poured is the clear focal point.
    for (const cel of this.celebrations) {
      drawCelebration(c, cel, cupW * 0.7, brand.accent);
    }
  }

  private renderBackground(c: CanvasRenderingContext2D, w: number, h: number): void {
    const { brand, roles } = this.ctx;
    const bg = roles.stageBackground?.assets[0];
    if (bg?.image) {
      // Cover-fit. This is the one place a crop is correct: it is a
      // blurred/darkened backdrop, not a product being presented.
      const scale = Math.max(w / bg.width, h / bg.height);
      const dw = bg.width * scale;
      const dh = bg.height * scale;
      c.drawImage(bg.image, (w - dw) / 2, (h - dh) / 2, dw, dh);
      c.fillStyle = "rgba(0,0,0,0.45)";
      c.fillRect(0, 0, w, h);
      return;
    }
    drawBrandBackground(c, w, h, brand.background, brand.accent);
  }

  /** The product doing the pouring, tipped over the cup, plus the stream
   * falling from it while the cup is filling. */
  private renderSource(
    c: CanvasRenderingContext2D,
    w: number,
    y: number,
    height: number,
    cupTop: number,
  ): void {
    const { brand, brandLogo } = this.ctx;
    const asset = this.prizePool[this.prizeIndex] ?? null;
    const size = Math.min(height, w * 0.42);
    const cx = w / 2;

    c.save();
    // Tip toward the cup. The whole sprite rotates, so a bottle, a bag or a
    // tin all read as "pouring" without knowing which one it is.
    c.translate(cx + size * 0.18, y + size / 2);
    c.rotate(0.42);
    withDropShadow(c, () => {
      if (asset?.image) {
        drawAssetContain(c, asset, -size / 2, -size / 2, size, size);
      } else if (brandLogo) {
        // "logo" fallback per the capability — brand identity, never
        // recorded as engagement (see lockIn()).
        drawImageContain(c, brandLogo, -size / 2, -size / 2, size, size);
      } else {
        // No prize and no logo: a plain accent vessel, so the source of the
        // pour is still legible.
        c.fillStyle = brand.accent;
        roundedRect(c, -size * 0.2, -size / 2, size * 0.4, size * 0.9, size * 0.1);
        c.fill();
      }
    });
    c.restore();

    if (this.phase === "pouring") {
      const streamW = Math.max(3, size * 0.06);
      c.save();
      c.fillStyle = this.liquidColor();
      c.globalAlpha = 0.85;
      c.fillRect(cx - streamW / 2, y + size * 0.62, streamW, cupTop - (y + size * 0.62) + 4);
      c.restore();
    }

    const name = asset?.data?.name;
    if (name) {
      c.fillStyle = withAlpha(brand.foreground, 0.7);
      c.font = `600 13px ${brand.fontFamily}, system-ui, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "top";
      c.fillText(truncate(c, name, w - 32), cx, y + height - 12);
    }
  }

  /** The liquid takes the poured product's own sampled backdrop colour when
   * it has one, so the cup fills with something that looks like the thing
   * being poured rather than a generic accent wash. */
  private liquidColor(): string {
    const asset = this.prizePool[this.prizeIndex];
    return asset?.backgroundColor || shadeHex(this.ctx.brand.accent, -0.1);
  }

  private renderCup(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    const { brand, brandLogo } = this.ctx;
    const taper = w * 0.13; // narrower at the base, like a real paper cup
    const innerTop = y + h * 0.06;
    const innerH = h * 0.94;

    // Cup body. Clipped to the tapered silhouette so the liquid, the band
    // and the sleeve all stop at the cup's real edge.
    const cupPath = () => {
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + w, y);
      c.lineTo(x + w - taper, y + h);
      c.lineTo(x + taper, y + h);
      c.closePath();
    };

    withDropShadow(c, () => {
      c.save();
      cupPath();
      c.fillStyle = brand.background;
      c.fill();
      c.restore();
    });

    c.save();
    cupPath();
    c.clip();

    // Liquid, rising from the base.
    const level = Math.max(0, Math.min(1, this.fill));
    const liquidTop = innerTop + innerH * (1 - level);
    c.fillStyle = this.liquidColor();
    c.fillRect(x, liquidTop, w, y + h - liquidTop);
    // Surface highlight, so the level has a readable edge.
    c.fillStyle = "rgba(255,255,255,0.35)";
    c.fillRect(x, liquidTop, w, Math.max(2, h * 0.012));

    // Sleeve — the cup's permanent brand surface, carrying the logo. It is
    // opaque, so it sits LOW on the cup and stays clear of where the fill
    // band can ever be: pickBandCentre() never goes below 0.5 of the cup,
    // which is the upper half of the drawn silhouette, and the sleeve
    // starts below that. A sleeve across the middle hid the band and the
    // liquid level at exactly the moment the player needs to read them.
    const sleeveH = h * 0.17;
    const sleeveY = y + h * 0.71;
    c.fillStyle = brand.accent;
    c.fillRect(x - 2, sleeveY, w + 4, sleeveH);
    // The cup narrows toward the base, so text has to fit the width THERE,
    // not the width at the rim, or it runs out past the silhouette.
    const sleeveW = w - taper * 2;
    if (brandLogo) {
      const pad = sleeveH * 0.16;
      drawImageContain(c, brandLogo, x + (w - sleeveW) / 2, sleeveY + pad, sleeveW, sleeveH - pad * 2);
    } else if (brand.name) {
      c.fillStyle = contrastOn(brand.accent, brand.foreground, brand.background);
      c.font = `700 ${Math.round(sleeveH * 0.62)}px ${brand.fontFamily}, system-ui, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(truncate(c, brand.name.toUpperCase(), sleeveW), x + w / 2, sleeveY + sleeveH / 2);
    }

    // The fill band the player is aiming for — drawn last inside the cup so
    // it is never occluded by the liquid or the sleeve.
    const bandTop = innerTop + innerH * (1 - (this.bandCentre + this.bandWidth / 2));
    const bandH = Math.max(3, innerH * this.bandWidth);
    c.fillStyle = withAlpha(brand.accent, 0.3);
    c.fillRect(x, bandTop, w, bandH);
    c.strokeStyle = brand.accent;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x, bandTop);
    c.lineTo(x + w, bandTop);
    c.moveTo(x, bandTop + bandH);
    c.lineTo(x + w, bandTop + bandH);
    c.stroke();
    c.restore();

    // Rim on top of everything, and the cup outline.
    c.save();
    c.fillStyle = shadeHex(brand.background, -0.12);
    roundedRect(c, x - w * 0.03, y - h * 0.02, w * 1.06, h * 0.07, h * 0.035);
    c.fill();
    c.strokeStyle = withAlpha(brand.foreground, 0.18);
    c.lineWidth = 2;
    cupPath();
    c.stroke();
    c.restore();

    // Spill: liquid running down both sides of the cup.
    if (this.phase === "overflowing") {
      const spillProgress = Math.min(1, this.phaseT / OVERFLOW_HOLD_SEC);
      c.save();
      c.fillStyle = this.liquidColor();
      c.globalAlpha = 0.8;
      const runH = h * 0.9 * spillProgress;
      c.fillRect(x - w * 0.02, y + h * 0.04, w * 0.09, runH);
      c.fillRect(x + w * 0.93, y + h * 0.04, w * 0.09, runH);
      c.restore();
    }
  }

  /** Served cups line up along the bottom — the run's progress bar, made of
   * the thing the player is actually doing. */
  private renderTray(c: CanvasRenderingContext2D, w: number, y: number, h: number): void {
    const { brand } = this.ctx;
    const goal = Math.round(this.ctx.tuning.cupsToServe ?? 12);
    const slots = Math.min(TRAY_MAX_CUPS, goal);
    const gap = 6;
    const cupW = Math.max(8, (Math.min(w - 32, slots * 26) - gap * (slots - 1)) / slots);
    const totalW = cupW * slots + gap * (slots - 1);
    let x = (w - totalW) / 2;

    c.save();
    c.fillStyle = withAlpha(brand.foreground, 0.1);
    c.fillRect((w - totalW) / 2 - 8, y + h - 3, totalW + 16, 3);
    for (let i = 0; i < slots; i++) {
      // With a goal bigger than the tray, each slot stands for a share of
      // it, so a 20-cup goal still reads on an 8-slot tray.
      const filledAt = Math.ceil(((i + 1) * goal) / slots);
      const done = this.served >= filledAt;
      c.fillStyle = done ? brand.accent : withAlpha(brand.foreground, 0.14);
      roundedRect(c, x, y, cupW, h - 4, 3);
      c.fill();
      x += cupW + gap;
    }
    c.restore();
  }

  private renderHud(c: CanvasRenderingContext2D, w: number, h: number): void {
    const { brand, tuning } = this.ctx;
    const pad = 16;

    c.save();
    c.textBaseline = "top";
    c.font = `600 14px ${brand.fontFamily}, system-ui, sans-serif`;
    c.textAlign = "left";
    c.fillStyle = withAlpha(brand.foreground, 0.75);
    c.fillText(`${this.ctx.getScore()}`, pad, pad);

    const maxLives = Math.max(1, Math.round(tuning.lives ?? 3));
    for (let i = 0; i < maxLives; i++) {
      const cx = w - pad - i * 16 - 5;
      c.beginPath();
      c.arc(cx, pad + 7, 5, 0, Math.PI * 2);
      c.fillStyle = i < this.livesLeft ? brand.accent : withAlpha(brand.foreground, 0.18);
      c.fill();
    }

    c.textAlign = "center";
    c.font = `500 13px ${brand.fontFamily}, system-ui, sans-serif`;
    if (this.feedback) {
      c.fillStyle = this.feedback.kind === "serve" ? brand.accent : "#d14343";
      c.fillText(this.feedback.kind === "serve" ? "Perfect pour" : "Overflowed", w / 2, pad);
    } else {
      c.fillStyle = withAlpha(brand.foreground, 0.55);
      c.fillText(
        this.served === 0 ? "Tap to stop the pour on the line" : `Streak ${this.streak}`,
        w / 2,
        pad,
      );
    }
    c.restore();
  }

  teardown(): void {
    this.prizePool = [];
    this.celebrations = [];
    this.feedback = null;
  }

  maxRealisticScore(tuning: Record<string, number>): number {
    return maxRealisticScore(tuning);
  }
}

// ---------------------------------------------------------------------------
// Local drawing helpers. Kept here rather than shared because each game
// module owns its own look; nothing else needs these.
// ---------------------------------------------------------------------------

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

/** #rrggbb -> rgba() at the given alpha; returns the input unchanged if it
 * isn't a 6-digit hex, so a malformed brand colour degrades visibly rather
 * than painting transparent. */
function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(clean)) return hex;
  const num = parseInt(clean, 16);
  return `rgba(${(num >> 16) & 0xff}, ${(num >> 8) & 0xff}, ${num & 0xff}, ${alpha})`;
}

/** Picks whichever of two brand colours is more readable on `background`.
 * brand.foreground is contrast-forced against brand.background, not against
 * brand.accent, so text on an accent-filled sleeve needs its own check. */
function contrastOn(background: string, a: string, b: string): string {
  const bg = relativeLuminance(background);
  return Math.abs(relativeLuminance(a) - bg) >= Math.abs(relativeLuminance(b) - bg) ? a : b;
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(clean)) return 0.5;
  const num = parseInt(clean, 16);
  const r = ((num >> 16) & 0xff) / 255;
  const g = ((num >> 8) & 0xff) / 255;
  const b = (num & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function createPourGame(): GameModule {
  return new PourGame();
}
