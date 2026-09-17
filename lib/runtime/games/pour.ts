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
// The cup, the stream and the splash are drawn with real (if cheap) physics
// rather than as flat shapes, because this template's entire screen is one
// object and a flat trapezoid full of a flat rectangle reads as a wireframe:
//
//   - Depth comes from ellipses, the standard way a cylinder is drawn: a
//     rim ellipse you can see INTO, a narrower base ellipse, and a liquid
//     surface that is itself an ellipse rather than a straight line. The
//     body carries a horizontal gradient (dark edges, light centre) so it
//     reads as curved, plus a specular stripe.
//   - The stream is solved analytically from projectile motion, not drawn
//     as a constant-width bar: vy grows as v0 + g*t, and mass continuity
//     (A*v = const) then forces the width to narrow as 1/v — which is why
//     a real pour is thin at the bottom and fat at the spout.
//   - Splash droplets are semi-implicit Euler particles (v += g*dt;
//     p += v*dt), spawned at the impact point while the stream is landing.
//   - The surface sloshes: the impact feeds a damped sine whose amplitude
//     decays once the pour stops.
//
// None of it is a fluid simulation and none of it needs to be — see
// docs/ARCHITECTURE.md on keeping runtime modules cheap enough for a
// third-party storefront's main thread.
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
import { drawBottleShape } from "@/lib/runtime/games/shapeLibrary";

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

// Stream + splash physics. These are visual-scale constants in px/sec, not
// real-world gravity — the stage is only a few hundred pixels tall, so a
// true 9.8 m/s^2 mapped to any sane pixels-per-metre either falls too fast
// to see or too slow to believe. Tuned by eye against the default fillSpeed.
const STREAM_GRAVITY = 900;
const STREAM_EXIT_SPEED = 120; // vertical speed leaving the spout
const STREAM_SAMPLES = 14; // polygon segments down the stream
const STREAM_WOBBLE_HZ = 5.5;
const DROPLET_GRAVITY = 1500;
const DROPLETS_PER_SEC = 26;
const DROPLET_LIFE_SEC = 0.5;
const MAX_DROPLETS = 36;
const SLOSH_HZ = 5.2;
const SLOSH_DECAY_PER_SEC = 3.2;
const SLOSH_MAX = 1;

const FEEDBACK_SEC = 0.5;
const OVERFLOW_HOLD_SEC = 0.45; // how long a spilling cup stays up before it resets
const HUD_HEIGHT = 34;
const TRAY_MAX_CUPS = 8; // how many served cups the tray shows before it stops growing

type Phase = "pouring" | "served" | "overflowing";

interface Droplet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  radius: number;
}

/** Everything the renderer and the physics both need to agree about. */
interface Layout {
  cupX: number;
  cupY: number;
  cupW: number;
  cupH: number;
  topRx: number;
  topRy: number;
  topCy: number;
  baseRx: number;
  baseRy: number;
  baseCy: number;
  bottleY: number;
  bottleH: number;
  trayY: number;
  trayH: number;
  spoutX: number;
  spoutY: number;
  impactX: number;
  impactY: number;
}

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

  /** Splash particles thrown off where the stream lands. Plain semi-implicit
   * Euler; capped at MAX_DROPLETS so a long round can't grow the array. */
  private droplets: Droplet[] = [];
  private dropletCarry = 0; // fractional spawns banked between frames
  /** Damped sine on the liquid surface: the impact feeds `sloshAmp`, which
   * decays once the pour stops. */
  private sloshAmp = 0;
  private sloshPhase = 0;

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
    this.droplets = [];
    this.dropletCarry = 0;
    this.sloshAmp = 0;
    this.sloshPhase = 0;
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

    this.stepPhysics(dt);

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

  /**
   * Splash droplets and surface slosh. Both run off the layout the renderer
   * computes, so they share layout() rather than the update path guessing
   * where the stream lands — a frame-stale impact point would drift visibly
   * on a resize.
   */
  private stepPhysics(dt: number): void {
    const pouring = this.phase === "pouring";
    const { impactX, impactY } = this.layout();

    if (pouring) {
      // The stream is landing, so it keeps feeding both the splash and the
      // surface. A fuller cup means a shorter drop, so it splashes less.
      const energy = 1 - Math.min(1, this.fill) * 0.55;
      this.sloshAmp = Math.min(SLOSH_MAX, this.sloshAmp + dt * 4.5 * energy);

      this.dropletCarry += DROPLETS_PER_SEC * energy * dt;
      while (this.dropletCarry >= 1) {
        this.dropletCarry -= 1;
        this.spawnDroplet(impactX, impactY, energy);
      }
    } else {
      this.dropletCarry = 0;
    }

    this.sloshPhase += SLOSH_HZ * dt;
    this.sloshAmp *= Math.exp(-SLOSH_DECAY_PER_SEC * dt);

    const alive: Droplet[] = [];
    for (const d of this.droplets) {
      // Semi-implicit (symplectic) Euler: velocity first, then position.
      d.vy += DROPLET_GRAVITY * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.life -= dt;
      if (d.life > 0) alive.push(d);
    }
    this.droplets = alive;
  }

  private spawnDroplet(x: number, y: number, energy: number): void {
    if (this.droplets.length >= MAX_DROPLETS) return;
    const r = this.ctx.random;
    // Thrown up and out from the impact, mostly sideways — a vertical
    // fountain reads as a geyser, not a splash.
    const spread = 150 * energy;
    this.droplets.push({
      x: x + (r() - 0.5) * 6,
      y,
      vx: (r() - 0.5) * 2 * spread,
      vy: -60 - r() * 170 * energy,
      life: DROPLET_LIFE_SEC * (0.6 + r() * 0.6),
      maxLife: DROPLET_LIFE_SEC,
      radius: 1.2 + r() * 1.8,
    });
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

  /**
   * Cup/bottle/tray geometry for the current stage. Called by both render()
   * and the physics step so the splash lands exactly where the stream is
   * drawn, including mid-round after a resize. Pure arithmetic — cheap
   * enough to call twice a frame and far safer than caching it.
   *
   * Sized off BOTH axes: this template declares the ad placement, so it has
   * to stay composed in a 300x250 as well as a 320x480.
   */
  private layout(): Layout {
    const { width: w, height: h } = this.ctx.stage;

    const trayH = Math.max(18, Math.min(34, h * 0.07));
    const available = h - HUD_HEIGHT - trayH - 16;
    const cupH = Math.max(90, Math.min(260, available * 0.62));
    const cupW = Math.max(70, Math.min(w * 0.46, cupH * 0.78));
    const bottleH = Math.max(40, Math.min(available - cupH - 12, cupH * 0.6));

    const cupX = (w - cupW) / 2;
    const bottleY = HUD_HEIGHT + 6;
    const cupY = bottleY + bottleH + 10;

    // The rim ellipse is what sells the depth: you see INTO the cup. The
    // base ellipse is shallower AND narrower, which is both the real
    // taper of a paper cup and correct perspective for something below
    // eye level.
    const topRx = cupW / 2;
    const topRy = cupW * 0.11;
    const topCy = cupY + topRy;
    const baseRx = topRx * 0.76;
    const baseRy = topRy * 0.66;
    const baseCy = cupY + cupH - baseRy;

    const cx = cupX + cupW / 2;
    const level = Math.max(0, Math.min(1, this.fill));
    const impactY = this.surfaceCy(topCy, baseCy, level);
    // The spout is the tipped product's lower-right lip, which is where the
    // sprite is rotated to point.
    const spoutSize = Math.min(bottleH, w * 0.42);
    const spoutX = cx + spoutSize * 0.1;
    const spoutY = bottleY + spoutSize * 0.66;

    return {
      cupX, cupY, cupW, cupH,
      topRx, topRy, topCy,
      baseRx, baseRy, baseCy,
      bottleY, bottleH,
      trayY: h - trayH - 6, trayH,
      spoutX, spoutY,
      impactX: cx, impactY,
    };
  }

  /** Screen y of the liquid surface for a 0..1 fill. */
  private surfaceCy(topCy: number, baseCy: number, level: number): number {
    return baseCy - (baseCy - topCy) * level;
  }

  /** Frustum half-width at a given screen y — everything drawn on the cup
   * (sleeve, liquid surface, band) has to follow the taper or it floats off
   * the silhouette. */
  private rxAt(l: Layout, y: number): number {
    const span = l.baseCy - l.topCy;
    const t = span > 0 ? Math.max(0, Math.min(1, (y - l.topCy) / span)) : 0;
    return l.topRx + (l.baseRx - l.topRx) * t;
  }

  render(c: CanvasRenderingContext2D): void {
    const { stage, brand } = this.ctx;
    const l = this.layout();

    this.renderBackground(c, stage.width, stage.height);
    this.renderSource(c, stage.width, l);
    if (this.phase === "pouring") this.renderStream(c, l);
    this.renderCup(c, l);
    this.renderDroplets(c);
    this.renderTray(c, stage.width, l.trayY, l.trayH);
    this.renderHud(c, stage.width, stage.height);

    // Last, so the product just poured is the clear focal point.
    for (const cel of this.celebrations) {
      drawCelebration(c, cel, l.cupW * 0.7, brand.accent);
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

  /** The product doing the pouring, tipped over the cup. */
  private renderSource(c: CanvasRenderingContext2D, w: number, l: Layout): void {
    const { brand, brandLogo } = this.ctx;
    const asset = this.prizePool[this.prizeIndex] ?? null;
    const size = Math.min(l.bottleH, w * 0.42);
    const cx = w / 2;

    c.save();
    // Tip toward the cup. The whole sprite rotates, so a bottle, a bag or a
    // tin all read as "pouring" without knowing which one it is.
    c.translate(cx + size * 0.18, l.bottleY + size / 2);
    c.rotate(0.42);
    withDropShadow(c, () => {
      if (asset?.image) {
        drawAssetContain(c, asset, -size / 2, -size / 2, size, size);
      } else if (brandLogo) {
        // "logo" fallback per the capability — brand identity, never
        // recorded as engagement (see lockIn()).
        drawImageContain(c, brandLogo, -size / 2, -size / 2, size, size);
      } else {
        // No prize and no logo: a modelled bottle, so the source of the
        // pour still has the same volume as everything else on screen.
        drawBottleShape(c, -size * 0.26, -size * 0.5, size * 0.52, size * 0.95, brand.accent, this.liquidColor());
      }
    });
    c.restore();

    const name = asset?.data?.name;
    if (name) {
      c.fillStyle = withAlpha(brand.foreground, 0.7);
      c.font = `600 13px ${brand.fontFamily}, system-ui, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "top";
      c.fillText(truncate(c, name, w - 32), cx, l.bottleY + l.bottleH - 12);
    }
  }

  /**
   * The falling stream, solved rather than drawn as a bar.
   *
   * Vertical speed is projectile motion, vy(t) = v0 + g*t. Mass continuity
   * for an incompressible stream says area * speed is constant along it, so
   * the width has to go as w0 * v0 / vy(t): fat at the spout, thin where it
   * lands. That single relation is the whole reason a real pour looks the
   * way it does, and it costs one divide per sample.
   */
  private renderStream(c: CanvasRenderingContext2D, l: Layout): void {
    const drop = l.impactY - l.spoutY;
    if (drop <= 2) return;

    const v0 = STREAM_EXIT_SPEED;
    const flight = (Math.sqrt(v0 * v0 + 2 * STREAM_GRAVITY * drop) - v0) / STREAM_GRAVITY;
    const w0 = Math.max(3, l.cupW * 0.055);
    // Lateral drift from the tipped spout, plus a slow wobble so the column
    // isn't a dead straight line.
    const driftX = -l.cupW * 0.04;

    const left: [number, number][] = [];
    const right: [number, number][] = [];
    for (let i = 0; i <= STREAM_SAMPLES; i++) {
      const t = (i / STREAM_SAMPLES) * flight;
      const vy = v0 + STREAM_GRAVITY * t;
      const y = l.spoutY + v0 * t + 0.5 * STREAM_GRAVITY * t * t;
      const wobble = Math.sin(this.elapsed * Math.PI * 2 * STREAM_WOBBLE_HZ - t * 9) * w0 * 0.35 * (t / Math.max(flight, 1e-4));
      const x = l.spoutX + driftX * (t / Math.max(flight, 1e-4)) + wobble;
      const halfW = (w0 * v0) / vy / 2;
      left.push([x - halfW, y]);
      right.push([x + halfW, y]);
    }

    c.save();
    c.beginPath();
    c.moveTo(left[0]![0], left[0]![1]);
    for (const [x, y] of left.slice(1)) c.lineTo(x, y);
    for (let i = right.length - 1; i >= 0; i--) c.lineTo(right[i]![0], right[i]![1]);
    c.closePath();
    c.fillStyle = this.liquidColor();
    c.fill();

    // A lit edge down the left of the column — the same light source the
    // cup's specular stripe uses.
    c.strokeStyle = "rgba(255,255,255,0.4)";
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(left[0]![0], left[0]![1]);
    for (const [x, y] of left.slice(1)) c.lineTo(x, y);
    c.stroke();
    c.restore();
  }

  private renderDroplets(c: CanvasRenderingContext2D): void {
    if (this.droplets.length === 0) return;
    c.save();
    c.fillStyle = this.liquidColor();
    for (const d of this.droplets) {
      c.globalAlpha = Math.max(0, Math.min(1, d.life / d.maxLife));
      c.beginPath();
      c.arc(d.x, d.y, d.radius, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  /** The liquid takes the poured product's own sampled backdrop colour when
   * it has one, so the cup fills with something that looks like the thing
   * being poured rather than a generic accent wash. */
  private liquidColor(): string {
    const asset = this.prizePool[this.prizeIndex];
    // The fallback is pushed well away from brand.accent on purpose: the
    // sleeve is drawn IN brand.accent, and at -0.1 the liquid and the sleeve
    // were close enough to read as one block of colour.
    return asset?.backgroundColor || shadeHex(this.ctx.brand.accent, -0.3);
  }

  private renderCup(c: CanvasRenderingContext2D, l: Layout): void {
    const { brand, brandLogo } = this.ctx;
    const cx = l.cupX + l.cupW / 2;

    // Outer silhouette: rim ellipse on top, base ellipse at the bottom,
    // straight sides between. Reused as both fill path and clip.
    const bodyPath = () => {
      c.beginPath();
      c.moveTo(cx - l.topRx, l.topCy);
      c.lineTo(cx - l.baseRx, l.baseCy);
      c.ellipse(cx, l.baseCy, l.baseRx, l.baseRy, 0, Math.PI, 0, true);
      c.lineTo(cx + l.topRx, l.topCy);
      c.ellipse(cx, l.topCy, l.topRx, l.topRy, 0, 0, Math.PI, true);
      c.closePath();
    };

    // Body, with a horizontal gradient standing in for a curved surface:
    // dark at both edges, brightest just left of centre where the light is.
    withDropShadow(c, () => {
      c.save();
      bodyPath();
      const shell = c.createLinearGradient(cx - l.topRx, 0, cx + l.topRx, 0);
      shell.addColorStop(0, shadeHex(brand.background, -0.2));
      shell.addColorStop(0.3, shadeHex(brand.background, 0.05));
      shell.addColorStop(0.62, brand.background);
      shell.addColorStop(1, shadeHex(brand.background, -0.24));
      c.fillStyle = shell;
      c.fill();
      c.restore();
    });

    // Cup interior, seen through the rim opening.
    c.save();
    c.beginPath();
    c.ellipse(cx, l.topCy, l.topRx, l.topRy, 0, 0, Math.PI * 2);
    c.fillStyle = shadeHex(brand.background, -0.32);
    c.fill();
    c.restore();

    c.save();
    bodyPath();
    c.clip();

    // --- liquid ---------------------------------------------------------
    const level = Math.max(0, Math.min(1, this.fill));
    const surfaceCy = this.surfaceCy(l.topCy, l.baseCy, level);
    const surfaceRx = this.rxAt(l, surfaceCy);
    const surfaceRy = l.baseRy + (l.topRy - l.baseRy) * level;
    // Slosh rides on the surface ellipse's own height, so a settled cup is
    // a clean ellipse and a freshly-hit one wobbles.
    const slosh = Math.sin(this.sloshPhase) * this.sloshAmp * surfaceRy * 0.45;

    if (level > 0.001) {
      c.fillStyle = this.liquidColor();
      c.fillRect(cx - l.topRx, surfaceCy, l.topRx * 2, l.baseCy + l.baseRy - surfaceCy);
      // The visible top face of the liquid — an ellipse, not a straight
      // line, which is what actually makes the cup read as having a volume.
      c.beginPath();
      c.ellipse(cx, surfaceCy + slosh, surfaceRx, Math.max(1, surfaceRy + slosh * 0.5), 0, 0, Math.PI * 2);
      c.fillStyle = shadeHex(this.liquidColor(), 0.12);
      c.fill();
      c.strokeStyle = "rgba(255,255,255,0.35)";
      c.lineWidth = 1.5;
      c.stroke();
    }

    // Sleeve — the cup's permanent brand surface, carrying the logo. It is
    // opaque, so it sits LOW on the cup and stays clear of where the fill
    // band can ever be: pickBandCentre() never goes below 0.5 of the cup,
    // which is the upper half of the drawn silhouette. A sleeve across the
    // middle hid the band and the liquid level at exactly the moment the
    // player needs to read them. Its top and bottom edges are ellipse arcs,
    // so the band wraps the cylinder instead of sitting on it like a label.
    const sleeveTop = l.topCy + (l.baseCy - l.topCy) * 0.66;
    const sleeveBottom = l.topCy + (l.baseCy - l.topCy) * 0.92;
    const sleeveTopRx = this.rxAt(l, sleeveTop);
    const sleeveBottomRx = this.rxAt(l, sleeveBottom);
    const sleeveTopRy = l.topRy * 0.72;
    const sleeveBottomRy = l.topRy * 0.6;

    c.beginPath();
    c.ellipse(cx, sleeveTop, sleeveTopRx, sleeveTopRy, 0, Math.PI, 0, true);
    c.lineTo(cx + sleeveBottomRx, sleeveBottom);
    c.ellipse(cx, sleeveBottom, sleeveBottomRx, sleeveBottomRy, 0, 0, Math.PI, true);
    c.closePath();
    const sleeveShade = c.createLinearGradient(cx - sleeveTopRx, 0, cx + sleeveTopRx, 0);
    sleeveShade.addColorStop(0, shadeHex(brand.accent, -0.22));
    sleeveShade.addColorStop(0.35, shadeHex(brand.accent, 0.08));
    sleeveShade.addColorStop(1, shadeHex(brand.accent, -0.26));
    c.fillStyle = sleeveShade;
    c.fill();

    const sleeveMidY = (sleeveTop + sleeveBottom) / 2;
    const sleeveH = sleeveBottom - sleeveTop;
    const sleeveW = sleeveTopRx * 1.72;
    if (brandLogo) {
      const pad = sleeveH * 0.16;
      drawImageContain(c, brandLogo, cx - sleeveW / 2, sleeveTop + pad, sleeveW, sleeveH - pad * 2);
    } else if (brand.name) {
      c.fillStyle = contrastOn(brand.accent, brand.foreground, brand.background);
      c.font = `700 ${Math.round(sleeveH * 0.52)}px ${brand.fontFamily}, system-ui, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(truncate(c, brand.name.toUpperCase(), sleeveW), cx, sleeveMidY);
    }

    // The fill band the player is aiming for — drawn last inside the cup so
    // it is never occluded by the liquid or the sleeve, and curved to the
    // cylinder like a printed measuring line.
    const bandCy = this.surfaceCy(l.topCy, l.baseCy, this.bandCentre);
    const bandSpan = (l.baseCy - l.topCy) * this.bandWidth;
    c.fillStyle = "rgba(255,255,255,0.16)";
    c.fillRect(cx - l.topRx, bandCy - bandSpan / 2, l.topRx * 2, bandSpan);
    // Each edge is stroked twice, dark then light one pixel below. A single
    // colour can't work here: the band sits over the pale empty interior
    // near the rim and over the dark liquid once the cup fills, and either
    // one alone disappears against half of that. The doubled line is legible
    // on both, which matters — this is the thing the player is aiming at.
    for (const edgeY of [bandCy - bandSpan / 2, bandCy + bandSpan / 2]) {
      const rx = this.rxAt(l, edgeY);
      for (const [dy, stroke, width] of [
        [0, withAlpha(brand.foreground, 0.75), 2.5],
        [1.5, "rgba(255,255,255,0.9)", 1.5],
      ] as [number, string, number][]) {
        c.beginPath();
        c.ellipse(cx, edgeY + dy, rx, rx * 0.2, 0, 0, Math.PI);
        c.strokeStyle = stroke;
        c.lineWidth = width;
        c.stroke();
      }
    }

    // Specular stripe — one soft vertical highlight, same light source as
    // the body gradient.
    const gloss = c.createLinearGradient(cx - l.topRx * 0.55, 0, cx - l.topRx * 0.15, 0);
    gloss.addColorStop(0, "rgba(255,255,255,0)");
    gloss.addColorStop(0.5, "rgba(255,255,255,0.26)");
    gloss.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = gloss;
    c.fillRect(cx - l.topRx * 0.55, l.topCy, l.topRx * 0.4, l.baseCy - l.topCy);
    c.restore();

    // Rim lip on top of everything, then the outline.
    c.save();
    c.beginPath();
    c.ellipse(cx, l.topCy, l.topRx, l.topRy, 0, 0, Math.PI * 2);
    c.strokeStyle = shadeHex(brand.background, -0.28);
    c.lineWidth = Math.max(3, l.cupW * 0.035);
    c.stroke();
    bodyPath();
    c.strokeStyle = withAlpha(brand.foreground, 0.16);
    c.lineWidth = 1.5;
    c.stroke();
    c.restore();

    // Spill: liquid running down both sides, following the taper.
    if (this.phase === "overflowing") {
      const spillProgress = Math.min(1, this.phaseT / OVERFLOW_HOLD_SEC);
      const runH = (l.baseCy - l.topCy) * spillProgress;
      c.save();
      bodyPath();
      c.clip();
      c.fillStyle = this.liquidColor();
      c.globalAlpha = 0.85;
      c.fillRect(cx - l.topRx, l.topCy, l.topRx * 0.22, runH);
      c.fillRect(cx + l.topRx * 0.78, l.topCy, l.topRx * 0.22, runH);
      c.restore();
    }
  }

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
