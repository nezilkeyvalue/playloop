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
//   - The surface is a WAVE, not a line: two travelling sines plus a
//     Gaussian depression under the stream, sampled around the surface
//     ellipse. That is what stops a rising level reading as a rectangle
//     sliding upward.
//   - The bulk level rides a damped spring, so when the pour stops the
//     surface overshoots and settles instead of freezing mid-frame.
//
// Every spring here sub-steps at a fixed PHYSICS_SUBSTEP. loop.ts clamps a
// frame's dt to 0.1s, and an explicit spring integrated at K=90 over a
// 0.1s step diverges — a backgrounded tab would come back to a surface
// oscillating out of the cup.
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

/** Fixed integration step for every spring below. See the header: loop.ts's
 * dt can be as large as 0.1s and these stiffnesses are not stable there. */
const PHYSICS_SUBSTEP = 1 / 120;

// The bulk surface level: a damped spring about its true height, so the
// liquid overshoots and settles rather than stopping dead. Under-damped on
// purpose (C below 2*sqrt(K)) — that overshoot IS the satisfying part.
const SURFACE_SPRING_K = 95;
const SURFACE_SPRING_C = 7.5;
// Sized from the spring it feeds, not guessed: a constant push `a` against
// stiffness K settles at a/K, so this is ~6px of steady depression at
// K=95 — enough to see. At 34 it was 0.36px, which is invisible, and the
// whole overshoot-and-settle beat did not exist on screen.
const SURFACE_IMPULSE_PER_SEC = 560; // px/sec^2 of downward push from the stream

// Two travelling sines across the surface. Wavelengths are deliberately
// incommensurate so the pattern never visibly repeats.
const WAVE_A = { amp: 0.34, length: 0.82, speed: 3.1 };
const WAVE_B = { amp: 0.2, length: 0.39, speed: -4.7 };
const CRATER_WIDTH = 0.3; // Gaussian sigma, as a fraction of the surface radius
const CRATER_DEPTH = 0.9; // in surface-ellipse half-heights, at full pour

// The stream eases in and out instead of blinking on and off.
// Fast enough to be fully gone inside OVERFLOW_HOLD_SEC: at 7/sec the
// stream was still ~5% visible when the next cup started, so a served
// cup sat there with a ghost of a pour still running into it.
const STREAM_EASE_PER_SEC = 12;
const STREAM_CUTOFF = 0.02; // below this the stream is gone entirely

// Cup bounce on a serve, and the softer nudge on a miss.
const POP_SPRING_K = 240;
const POP_SPRING_C = 15;
const POP_SERVE_IMPULSE = 2.6;
const POP_MISS_IMPULSE = -1.1;

// Restrained on purpose: a serve gets a dozen short-lived sparks, not a
// firework. MISS_FLASH is a fade, never a shake.
const MAX_SPARKLES = 14;
const SPARKLE_LIFE_SEC = 0.6;
const SPARKLE_GRAVITY = 420;
const MISS_FLASH_SEC = 0.6;
const PERFECT_CLOSENESS = 0.82; // centre-closeness that earns the "PERFECT" call
const PERFECT_LABEL_SEC = 0.9;

// How far the source is tipped, in radians (canvas positive = clockwise).
//
// The two cases are genuinely different objects. A modelled bottle has a
// known mouth, so it is tipped right over — past horizontal — and actually
// pours. An arbitrary product sprite (a bag of beans, a tin, a carton) has
// no mouth to find and reads as broken upside down, so it gets a modest
// tilt and the stream leaves its lower leading edge. Either way the spout
// is DERIVED from the tilt below, never guessed, which is what keeps the
// stream attached to the thing that is supposed to be pouring it.
const SPRITE_TILT = -0.42; // counter-clockwise: the low corner ends up left
const BOTTLE_TILT = 2.35; // ~135deg: mouth swings down and over the cup

/** Mouth position in the source's own local square, as a fraction of its
 * half-size. The modelled bottle's neck is dead centre at the top of its
 * box; a sprite's "lip" is taken inside its lower-left quadrant rather
 * than at the extreme corner, which on a contain-fit image is usually
 * transparent padding rather than product. */
const SPRITE_MOUTH = { x: -0.55, y: 0.75 };
const BOTTLE_MOUTH = { x: 0, y: -1 };

/** Default liquid when the poured product carries no sampled backdrop
 * colour of its own — which is most of the time, since a cleanly isolated
 * cutout has no backdrop to sample. A deep chocolate/espresso brown reads
 * as an actual drink at a glance; the previous fallback was the brand
 * accent darkened, which on a blue or green brand poured something that
 * looked like ink. The brand still comes through everywhere it should —
 * the sleeve, the band, the tray — and a product that DOES have a sampled
 * colour still wins over this. */
const LIQUID_DEFAULT = "#4A2C17";

// Stream breakup. A falling column is unstable: surface tension amplifies
// any perturbation whose wavelength exceeds its circumference, and the
// fastest-growing one is about 4.51 diameters (Rayleigh). So a stream stays
// intact for a length proportional to its own diameter and then separates
// into drops spaced by that wavelength — which, because the drops keep
// accelerating, spreads further apart the lower you look. That behaviour is
// the single clearest "this is a real pour" cue, and it is the reason a
// continuous ribbon all the way down reads as computer graphics.
// Low end of the real range on purpose: a hand-tipped bottle is a heavily
// perturbed jet, which breaks up sooner than a laboratory one. At 9 the
// breakup happened below the cup's rim, where the front wall hides it,
// so the whole effect was invisible on this layout.
const BREAKUP_INTACT_DIAMETERS = 5; // intact length, in stream diameters
const BREAKUP_WAVELENGTH_RATIO = 4.51; // Rayleigh's fastest-growing mode
const BREAKUP_MAX_BLOBS = 10;
const SATELLITE_SCALE = 0.45; // the small drop that forms between two main ones

// Foam/crema head. Builds while the stream is landing and collapses after.
const FOAM_BUILD_PER_SEC = 1.1;
const FOAM_DECAY_PER_SEC = 0.85;
const FOAM_MAX_FRACTION = 0.045; // of the cup's inner height, at full head

// Surface rings thrown out from the impact point.
const RIPPLE_INTERVAL_SEC = 0.17;
const RIPPLE_SPEED = 95; // px/sec outward
const RIPPLE_LIFE_SEC = 0.65;
const MAX_RIPPLES = 4;

const FEEDBACK_SEC = 0.5;
const OVERFLOW_HOLD_SEC = 0.45; // how long a spilling cup stays up before it resets
const HUD_HEIGHT = 34;
const TRAY_MAX_CUPS = 8; // how many served cups the tray shows before it stops growing

type Phase = "pouring" | "served" | "overflowing";

interface Ripple {
  radius: number;
  life: number;
}

interface Sparkle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
}

interface Droplet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  radius: number;
  /** True for the few drips that trail off the spout after the pour stops,
   * as opposed to splash thrown up from the impact. They fall past the rim,
   * so they need the same clip the stream has. */
  spout?: boolean;
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
  /** The tipped source: its square's size, how far it is rotated, and the
   * pivot that rotation happens about. The spout below is derived from
   * these, not chosen alongside them. */
  sourceSize: number;
  tilt: number;
  pivotX: number;
  pivotY: number;
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
  /** Expanding rings on the surface where the stream lands. */
  private ripples: Ripple[] = [];
  private rippleTimer = 0;
  /** Foam head, 0..1 of FOAM_MAX_FRACTION. Builds under the pour, collapses
   * after it — which is what makes the liquid read as a specific drink
   * rather than tinted water. */
  private foam = 0;

  /** Bulk surface level as a damped spring: `surfaceOffset` is the surface's
   * displacement in pixels from where `fill` alone would put it. The stream
   * pushes it down; when the pour stops it springs back through zero and
   * settles. */
  private surfaceOffset = 0;
  private surfaceVel = 0;
  /** Phase of the travelling surface waves. */
  private wavePhase = 0;
  /** Depth of the depression the stream punches, 0..1, eased with the pour. */
  private crater = 0;
  /** Stream opacity/width multiplier, eased so the pour starts and stops
   * smoothly instead of appearing and vanishing between frames. */
  private streamStrength = 0;
  /** Cup scale bounce, also a spring: positive on a serve, slightly
   * negative on a miss. */
  private pop = 0;
  private popVel = 0;
  private sparkles: Sparkle[] = [];
  private missFlash = 0;
  private perfectT = 0;

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
    this.ripples = [];
    this.rippleTimer = 0;
    this.foam = 0;
    this.surfaceOffset = 0;
    this.surfaceVel = 0;
    this.wavePhase = 0;
    this.crater = 0;
    this.streamStrength = 0;
    this.pop = 0;
    this.popVel = 0;
    this.sparkles = [];
    this.missFlash = 0;
    this.perfectT = 0;
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
    // Rising with the streak, so a run of clean pours builds audibly.
    this.ctx.sound.play(this.streak > 0 && this.streak % 5 === 0 ? "milestone" : "success", {
      semitones: Math.min(12, this.streak),
    });
    this.phase = "served";
    this.phaseT = 0;
    this.feedback = { kind: "serve", t: FEEDBACK_SEC };

    // Physical response to the tap: the cup bounces, the surface gets one
    // last kick so it visibly settles, and a ring goes out. Landing dead
    // centre also earns a short burst of sparks and the "PERFECT" call.
    this.popVel += POP_SERVE_IMPULSE * (0.7 + closeness * 0.5);
    this.surfaceVel += 30 * closeness;
    if (this.ripples.length < MAX_RIPPLES) this.ripples.push({ radius: 0, life: RIPPLE_LIFE_SEC });
    if (closeness >= PERFECT_CLOSENESS) {
      this.perfectT = PERFECT_LABEL_SEC;
      this.spawnSparkles();
    }
    this.spawnSpoutDrips();

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

      this.rippleTimer += dt;
      if (this.rippleTimer >= RIPPLE_INTERVAL_SEC) {
        this.rippleTimer -= RIPPLE_INTERVAL_SEC;
        if (this.ripples.length < MAX_RIPPLES) {
          this.ripples.push({ radius: 0, life: RIPPLE_LIFE_SEC });
        }
      }

      this.foam = Math.min(1, this.foam + FOAM_BUILD_PER_SEC * energy * dt);
    } else {
      this.dropletCarry = 0;
      this.rippleTimer = 0;
    }

    // Foam collapses on its own clock whether or not the pour is running —
    // under the stream the build term simply wins.
    this.foam *= Math.exp(-FOAM_DECAY_PER_SEC * dt);

    const liveRipples: Ripple[] = [];
    for (const r of this.ripples) {
      r.radius += RIPPLE_SPEED * dt;
      r.life -= dt;
      if (r.life > 0) liveRipples.push(r);
    }
    this.ripples = liveRipples;

    this.sloshPhase += SLOSH_HZ * dt;
    this.wavePhase += dt;
    this.sloshAmp *= Math.exp(-SLOSH_DECAY_PER_SEC * dt);

    // Everything that eases toward a target, integrated at a fixed step so
    // a 0.1s frame (loop.ts's clamp) can't destabilise the stiff springs.
    const streamTarget = pouring ? 1 : 0;
    const craterTarget = pouring ? 1 - Math.min(1, this.fill) * 0.4 : 0;
    let remaining = dt;
    while (remaining > 0) {
      const step = Math.min(PHYSICS_SUBSTEP, remaining);
      remaining -= step;

      this.streamStrength += (streamTarget - this.streamStrength) * Math.min(1, STREAM_EASE_PER_SEC * step);
      this.crater += (craterTarget - this.crater) * Math.min(1, 9 * step);

      // Surface level: a damped spring about zero, pushed down by the
      // stream. Semi-implicit Euler — velocity first, then position — which
      // is what keeps a spring stable rather than gaining energy.
      if (pouring) this.surfaceVel += SURFACE_IMPULSE_PER_SEC * this.streamStrength * step;
      this.surfaceVel += (-SURFACE_SPRING_K * this.surfaceOffset - SURFACE_SPRING_C * this.surfaceVel) * step;
      this.surfaceOffset += this.surfaceVel * step;

      this.popVel += (-POP_SPRING_K * this.pop - POP_SPRING_C * this.popVel) * step;
      this.pop += this.popVel * step;
    }
    if (this.streamStrength < STREAM_CUTOFF && !pouring) this.streamStrength = 0;

    this.missFlash = Math.max(0, this.missFlash - dt / MISS_FLASH_SEC);
    this.perfectT = Math.max(0, this.perfectT - dt);

    const liveSparkles: Sparkle[] = [];
    for (const sp of this.sparkles) {
      sp.vy += SPARKLE_GRAVITY * dt;
      sp.x += sp.vx * dt;
      sp.y += sp.vy * dt;
      sp.life -= dt;
      if (sp.life > 0) liveSparkles.push(sp);
    }
    this.sparkles = liveSparkles;

    // Anything that falls past the cup's base is gone: splash thrown out of
    // the cup used to keep falling and land on the tray, which reads as the
    // game leaking rather than as a splash.
    const floor = this.layout().baseCy;
    const alive: Droplet[] = [];
    for (const d of this.droplets) {
      // Semi-implicit (symplectic) Euler: velocity first, then position.
      d.vy += DROPLET_GRAVITY * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.life -= dt;
      if (d.life > 0 && d.y < floor) alive.push(d);
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
    this.ctx.sound.play("fail");
    this.phase = "overflowing";
    this.phaseT = 0;
    this.fill = Math.min(1, this.fill);
    this.feedback = { kind: "spill", t: FEEDBACK_SEC };
    // Deliberately gentle: a small settle of the cup and a fading warm
    // wash, no shake and no red flash. A miss here costs a life already —
    // the feedback's job is to be legible, not to punish.
    this.popVel += POP_MISS_IMPULSE;
    this.missFlash = 1;
    this.spawnSpoutDrips();
  }

  /** The last of the liquid leaving the lip once the pour stops. A stream
   * that ends cleanly at the spout looks switched off; real ones dribble. */
  private spawnSpoutDrips(): void {
    const { spoutX, spoutY } = this.layout();
    const r = this.ctx.random;
    const count = 2 + Math.floor(r() * 3);
    for (let i = 0; i < count; i++) {
      if (this.droplets.length >= MAX_DROPLETS) break;
      this.droplets.push({
        x: spoutX + (r() - 0.5) * 6,
        y: spoutY + i * 4,
        vx: (r() - 0.5) * 24,
        vy: 40 + r() * 70,
        life: DROPLET_LIFE_SEC * (1.2 + r() * 0.8),
        maxLife: DROPLET_LIFE_SEC * 2,
        radius: 1.6 + r() * 1.6,
        spout: true,
      });
    }
  }

  /** A short, restrained burst for a dead-centre serve. Thrown upward and
   * outward from the surface so they arc rather than shooting out flat. */
  private spawnSparkles(): void {
    const { impactX, impactY } = this.layout();
    const r = this.ctx.random;
    for (let i = 0; i < MAX_SPARKLES; i++) {
      const angle = -Math.PI / 2 + (r() - 0.5) * 2.2;
      const speed = 110 + r() * 150;
      this.sparkles.push({
        x: impactX + (r() - 0.5) * 30,
        y: impactY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: SPARKLE_LIFE_SEC * (0.6 + r() * 0.6),
        size: 1.6 + r() * 2,
      });
    }
  }

  private nextCup(): void {
    if (this.livesLeft <= 0) {
      this.finish();
      return;
    }
    this.fill = 0;
    this.surfaceOffset = 0;
    this.surfaceVel = 0;
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

    // --- where the pour actually leaves the source ----------------------
    // Rotate the mouth out of the source's local square and put the pivot
    // wherever that lands the mouth on the cup's axis. Doing it in this
    // order is the point: the spout can't drift away from the drawn lip,
    // because the lip is what positions the sprite rather than the other
    // way round. The old code picked both independently and they did not
    // agree — the stream came out of empty space beside the bottle.
    // 0.86 of the band, not all of it: the mouth ends up near the bottom of
    // the rotated square, so a full-height source leaves the spout almost
    // touching the rim and the pour has no visible free fall at all.
    const sourceSize = Math.min(bottleH * 0.86, w * 0.42);
    const half = sourceSize / 2;
    const tilt = this.sourceHasSprite() ? SPRITE_TILT : BOTTLE_TILT;
    const mouth = this.sourceHasSprite() ? SPRITE_MOUTH : BOTTLE_MOUTH;
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);
    const mouthX = mouth.x * half;
    const mouthY = mouth.y * half;
    const offsetX = mouthX * cos - mouthY * sin;
    const offsetY = mouthX * sin + mouthY * cos;

    const pivotX = cx - offsetX; // => spoutX lands exactly on cx
    const pivotY = bottleY + half;

    return {
      cupX, cupY, cupW, cupH,
      topRx, topRy, topCy,
      baseRx, baseRy, baseCy,
      bottleY, bottleH,
      trayY: h - trayH - 6, trayH,
      sourceSize, tilt, pivotX, pivotY,
      spoutX: pivotX + offsetX,
      spoutY: pivotY + offsetY,
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
    this.renderCup(c, l);
    // After the cup, not before it. The stream has to be visible where it
    // plunges through the rim opening — drawn first, the whole lower half
    // of it was painted over by the cup's front wall and the pour looked
    // like it stopped in mid-air. renderStream clips itself to the part a
    // viewer could actually see.
    //
    // Gated on streamStrength rather than the phase, so the pour eases out
    // over a few frames after the tap instead of vanishing on one.
    if (this.streamStrength > 0) this.renderStream(c, l);
    this.renderDroplets(c, l);
    this.renderSparkles(c);
    this.renderPerfect(c, l);
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

  /** True when a real image fills the source — a product sprite or the
   * brand logo. False means the modelled bottle, which is the only case
   * where the mouth's position in the artwork is actually known. */
  private sourceHasSprite(): boolean {
    return Boolean(this.prizePool[this.prizeIndex]?.image || this.ctx.brandLogo);
  }

  /** The product doing the pouring, tipped over the cup. Pivot and tilt
   * both come from layout(), which chose them so the mouth sits on the
   * cup's axis — so this method only draws; it never decides where the
   * pour comes from. */
  private renderSource(c: CanvasRenderingContext2D, w: number, l: Layout): void {
    const { brand, brandLogo } = this.ctx;
    const asset = this.prizePool[this.prizeIndex] ?? null;
    const size = l.sourceSize;
    const cx = w / 2;

    c.save();
    c.translate(l.pivotX, l.pivotY);
    c.rotate(l.tilt);
    withDropShadow(c, () => {
      if (asset?.image) {
        drawAssetContain(c, asset, -size / 2, -size / 2, size, size);
      } else if (brandLogo) {
        // "logo" fallback per the capability — brand identity, never
        // recorded as engagement (see lockIn()).
        drawImageContain(c, brandLogo, -size / 2, -size / 2, size, size);
      } else {
        // No prize and no logo: a modelled bottle, tipped right over so it
        // genuinely pours. Its neck is drawn at the top of this box, which
        // is exactly the point BOTTLE_MOUTH names.
        drawBottleShape(
          c,
          -size * 0.26,
          -size * 0.5,
          size * 0.52,
          size,
          brand.accent,
          this.liquidColor(),
          l.tilt,
          this.sloshPhase * 0.6,
        );
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
    // Thicker than a hairline, and scaled by the eased strength so the pour
    // thins out as it stops rather than being cut off mid-column.
    const w0 = Math.max(4, l.cupW * 0.075) * this.streamStrength;
    if (w0 < 0.6) return;
    // Lateral drift from the tipped spout, plus a slow wobble so the column
    // isn't a dead straight line.
    const driftX = -l.cupW * 0.04;

    const cx = l.cupX + l.cupW / 2;

    // Where the intact column ends. Rayleigh: a jet survives for a length
    // proportional to its own diameter, so a short drop never breaks up at
    // all (correct — top up a nearly-full cup and the stream stays solid).
    const intactLength = BREAKUP_INTACT_DIAMETERS * w0;
    const intactT =
      intactLength >= drop
        ? flight
        : (Math.sqrt(v0 * v0 + 2 * STREAM_GRAVITY * intactLength) - v0) / STREAM_GRAVITY;

    /** Stream centre, width and speed at time `t` into the flight. */
    const at = (t: number) => {
      const vy = v0 + STREAM_GRAVITY * t;
      const y = l.spoutY + v0 * t + 0.5 * STREAM_GRAVITY * t * t;
      const progress = t / Math.max(flight, 1e-4);
      const wobble = Math.sin(this.elapsed * Math.PI * 2 * STREAM_WOBBLE_HZ - t * 9) * w0 * 0.35 * progress;
      // Mass continuity: area * speed is constant along the stream, so the
      // width has to go as 1/v. Fat at the spout, thin where it lands.
      return { x: l.spoutX + driftX * progress + wobble, y, vy, width: (w0 * v0) / vy };
    };

    const left: [number, number][] = [];
    const right: [number, number][] = [];
    for (let i = 0; i <= STREAM_SAMPLES; i++) {
      const t = (i / STREAM_SAMPLES) * intactT;
      const p = at(t);
      left.push([p.x - p.width / 2, p.y]);
      right.push([p.x + p.width / 2, p.y]);
    }

    // The cup is translucent, so the part of the stream below the front lip
    // is not hidden — it is dimmed. Drawn first, under the crisp pass, so
    // the column visibly continues down into the liquid instead of being
    // chopped off at the rim.
    c.save();
    c.beginPath();
    c.moveTo(cx - l.topRx, l.topCy);
    c.lineTo(cx - l.baseRx, l.baseCy);
    c.ellipse(cx, l.baseCy, l.baseRx, l.baseRy, 0, Math.PI, 0, true);
    c.lineTo(cx + l.topRx, l.topCy);
    c.ellipse(cx, l.topCy, l.topRx, l.topRy, 0, 0, Math.PI, true);
    c.closePath();
    c.clip();
    c.globalAlpha = 0.34;
    c.fillStyle = this.liquidColor();
    this.fillStreamPath(c, left, right);
    c.restore();

    c.save();
    this.clipToVisiblePour(c, l);

    // A bead of liquid clinging at the lip, so the stream grows out of the
    // bottle instead of starting in the air just below it.
    c.fillStyle = this.liquidColor();
    c.beginPath();
    c.ellipse(l.spoutX, l.spoutY, w0 * 0.85, w0 * 0.62, 0, 0, Math.PI * 2);
    c.fill();

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

    // Past the intact length the column has separated into drops. Spacing
    // is the Rayleigh wavelength advected at the local speed, recomputed
    // each step — so the gaps widen on the way down for free, because the
    // drops are still accelerating. Every other one is a satellite: the
    // small drop real breakup leaves between two main ones.
    let t = intactT;
    for (let n = 0; n < BREAKUP_MAX_BLOBS && t < flight; n++) {
      const p = at(t);
      const main = n % 2 === 0;
      const rx = (p.width / 2) * (main ? 1 : SATELLITE_SCALE);
      // Drops stretch along their fall as inertia outruns surface tension.
      const ry = rx * Math.min(2.2, 1 + (p.vy / v0 - 1) * 0.45);
      c.beginPath();
      c.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
      c.fill();
      t += (BREAKUP_WAVELENGTH_RATIO * p.width) / p.vy;
    }
    c.restore();
  }

  /** Clip to the part of the pour a viewer could actually see: above the
   * rim, plus the rim opening itself. The cup is opaque below its front
   * lip, so anything falling past that is behind the wall. Shared by the
   * stream and by the drips that trail off the spout. */
  private clipToVisiblePour(c: CanvasRenderingContext2D, l: Layout): void {
    c.beginPath();
    c.rect(0, 0, this.ctx.stage.width, l.topCy);
    c.ellipse(l.cupX + l.cupW / 2, l.topCy, l.topRx, l.topRy, 0, 0, Math.PI * 2);
    c.clip();
  }

  /** Traces the stream polygon from its two pre-computed edges. Shared by
   * the dimmed in-cup pass and the crisp free-fall pass. */
  private fillStreamPath(
    c: CanvasRenderingContext2D,
    left: [number, number][],
    right: [number, number][],
  ): void {
    c.beginPath();
    c.moveTo(left[0]![0], left[0]![1]);
    for (const [x, y] of left.slice(1)) c.lineTo(x, y);
    for (let i = right.length - 1; i >= 0; i--) c.lineTo(right[i]![0], right[i]![1]);
    c.closePath();
    c.fill();
  }

  private renderDroplets(c: CanvasRenderingContext2D, l: Layout): void {
    if (this.droplets.length === 0) return;
    const draw = (list: Droplet[]) => {
      for (const d of list) {
        c.globalAlpha = Math.max(0, Math.min(1, d.life / d.maxLife));
        // Drops stretch along their velocity: surface tension loses to
        // inertia as they speed up, and a circle at 600px/sec reads as a
        // floating bead rather than a moving drop.
        const speed = Math.hypot(d.vx, d.vy);
        const stretch = Math.min(2.4, 1 + speed / 900);
        c.save();
        c.translate(d.x, d.y);
        c.rotate(Math.atan2(d.vy, d.vx));
        c.beginPath();
        c.ellipse(0, 0, d.radius * stretch, d.radius, 0, 0, Math.PI * 2);
        c.fill();
        c.restore();
      }
    };

    const splash = this.droplets.filter((d) => !d.spout);
    const drips = this.droplets.filter((d) => d.spout);

    c.save();
    c.fillStyle = this.liquidColor();
    draw(splash);
    c.restore();

    if (drips.length > 0) {
      // The drips that trail off the spout after the pour stops fall past
      // the rim, so they get the same clip the stream does.
      c.save();
      this.clipToVisiblePour(c, l);
      c.fillStyle = this.liquidColor();
      draw(drips);
      c.restore();
    }
  }

  private renderSparkles(c: CanvasRenderingContext2D): void {
    if (this.sparkles.length === 0) return;
    c.save();
    for (const sp of this.sparkles) {
      const fade = Math.max(0, Math.min(1, sp.life / SPARKLE_LIFE_SEC));
      c.globalAlpha = fade;
      c.fillStyle = "#FFFFFF";
      // A four-point star rather than a dot: at this size a dot is just
      // noise, and the star reads as "a good thing happened".
      c.save();
      c.translate(sp.x, sp.y);
      c.beginPath();
      const r = sp.size * (0.5 + fade);
      c.moveTo(0, -r * 2.2);
      c.quadraticCurveTo(0, 0, r, 0);
      c.quadraticCurveTo(0, 0, 0, r * 2.2);
      c.quadraticCurveTo(0, 0, -r, 0);
      c.quadraticCurveTo(0, 0, 0, -r * 2.2);
      c.fill();
      c.restore();
    }
    c.restore();
  }

  /** The liquid takes the poured product's own sampled backdrop colour when
   * it has one, so the cup fills with something that looks like the thing
   * being poured rather than a generic accent wash. */
  private liquidColor(): string {
    const asset = this.prizePool[this.prizeIndex];
    return asset?.backgroundColor || LIQUID_DEFAULT;
  }

  /**
   * Vertical displacement of the liquid surface at a point across it, as a
   * multiple of the surface ellipse's half-height.
   *
   * Two travelling sines at incommensurate wavelengths (so the pattern
   * never visibly repeats), plus a Gaussian depression centred under the
   * stream. This is the difference between a surface and a line: the level
   * rising alone reads as a rectangle sliding up the cup no matter how well
   * the rest of it is shaded.
   *
   * @param u position across the surface, -1 at the left wall to +1 at the right
   */
  private surfaceWave(u: number): number {
    const amp = this.sloshAmp;
    const a = Math.sin((u / WAVE_A.length) * Math.PI + this.wavePhase * WAVE_A.speed) * WAVE_A.amp;
    const b = Math.sin((u / WAVE_B.length) * Math.PI + this.wavePhase * WAVE_B.speed) * WAVE_B.amp;
    const dip = -CRATER_DEPTH * this.crater * Math.exp(-((u / CRATER_WIDTH) ** 2));
    return (a + b) * amp + dip;
  }

  private renderCup(c: CanvasRenderingContext2D, l: Layout): void {
    const { brand, brandLogo } = this.ctx;
    const cx = l.cupX + l.cupW / 2;

    // Serve/miss bounce, applied about the cup's base so it squashes into
    // the tray rather than floating.
    const squash = 1 - this.pop * 0.02;
    const stretch = 1 + this.pop * 0.02;
    c.save();
    c.translate(cx, l.baseCy);
    c.scale(stretch, squash);
    c.translate(-cx, -l.baseCy);

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

    // --- the vessel itself, behind its contents ------------------------
    // Translucent rather than a flat fill: the stage background reads
    // faintly through the empty part of the cup, which is what makes it a
    // plastic tumbler instead of a painted shape. The liquid is then drawn
    // INSIDE this, with the glass pass (below) laid over everything.
    withDropShadow(c, () => {
      c.save();
      bodyPath();
      const shell = c.createLinearGradient(cx - l.topRx, 0, cx + l.topRx, 0);
      shell.addColorStop(0, withAlpha(shadeHex(brand.background, -0.22), 0.85));
      shell.addColorStop(0.32, withAlpha(shadeHex(brand.background, 0.06), 0.5));
      shell.addColorStop(0.64, withAlpha(brand.background, 0.45));
      shell.addColorStop(1, withAlpha(shadeHex(brand.background, -0.26), 0.88));
      c.fillStyle = shell;
      c.fill();
      c.restore();
    });

    // Cup interior, seen through the rim opening.
    c.save();
    c.beginPath();
    c.ellipse(cx, l.topCy, l.topRx, l.topRy, 0, 0, Math.PI * 2);
    c.fillStyle = shadeHex(brand.background, -0.3);
    c.fill();
    c.restore();

    c.save();
    bodyPath();
    c.clip();

    // --- liquid ---------------------------------------------------------
    const level = Math.max(0, Math.min(1, this.fill));
    const baseSurfaceCy = this.surfaceCy(l.topCy, l.baseCy, level);
    // The spring rides on top of the true level, and is clamped so an
    // overshoot can never push the surface out through the rim or the base.
    const surfCy = Math.max(
      l.topCy + l.topRy * 0.5,
      Math.min(l.baseCy, baseSurfaceCy + this.surfaceOffset),
    );
    const surfaceRx = this.rxAt(l, surfCy);
    const surfaceRy = l.baseRy + (l.topRy - l.baseRy) * level;

    if (level > 0.001) {
      this.renderLiquid(c, l, cx, surfCy, surfaceRx, surfaceRy);
    }

    this.renderSleeve(c, l, cx, brandLogo);
    this.renderTargetBand(c, l, cx, surfCy);
    this.renderGlass(c, l, cx, bodyPath);
    c.restore();

    // Rim lip on top of everything, then the outline.
    c.save();
    c.beginPath();
    c.ellipse(cx, l.topCy, l.topRx, l.topRy, 0, 0, Math.PI * 2);
    c.strokeStyle = shadeHex(brand.background, -0.26);
    c.lineWidth = Math.max(3, l.cupW * 0.035);
    c.stroke();
    // A bright arc along the back of the rim — the single clearest "this is
    // a hard, shiny edge" cue.
    c.beginPath();
    c.ellipse(cx, l.topCy, l.topRx, l.topRy, 0, Math.PI * 1.15, Math.PI * 1.85);
    c.strokeStyle = "rgba(255,255,255,0.75)";
    c.lineWidth = Math.max(1.5, l.cupW * 0.014);
    c.stroke();

    bodyPath();
    c.strokeStyle =
      this.missFlash > 0
        ? `rgba(209,67,67,${(0.5 * this.missFlash).toFixed(3)})`
        : withAlpha(brand.foreground, 0.16);
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

    c.restore(); // bounce transform
  }

  /**
   * The liquid: a wavy surface disc plus the body beneath it.
   *
   * The body's top edge is the FRONT half of the surface ellipse, sampled
   * with the wave — so the level and the wave are the same curve, and the
   * liquid can't separate from its own surface. Everything is inside the
   * cup's clip already, so the walls do the rest.
   */
  private renderLiquid(
    c: CanvasRenderingContext2D,
    l: Layout,
    cx: number,
    surfCy: number,
    rx: number,
    ry: number,
  ): void {
    const liquid = this.liquidColor();
    const SAMPLES = 26;

    /** A point on the surface ellipse at angle `theta`, displaced by the wave. */
    const surfacePoint = (theta: number): [number, number] => {
      const u = Math.cos(theta);
      return [cx + rx * u, surfCy + ry * Math.sin(theta) + this.surfaceWave(u) * ry];
    };

    // Body: front arc (theta 0 -> PI passes through the near edge), then
    // down the right wall, across the base, up the left wall.
    c.beginPath();
    for (let i = 0; i <= SAMPLES; i++) {
      const [x, y] = surfacePoint((i / SAMPLES) * Math.PI);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.lineTo(cx - l.topRx, l.baseCy + l.baseRy);
    c.lineTo(cx + l.topRx, l.baseCy + l.baseRy);
    c.closePath();
    // Depth: darker toward the base, lighter just under the surface.
    const depth = c.createLinearGradient(0, surfCy, 0, l.baseCy + l.baseRy);
    depth.addColorStop(0, shadeHex(liquid, 0.08));
    depth.addColorStop(0.45, liquid);
    depth.addColorStop(1, shadeHex(liquid, -0.16));
    c.fillStyle = depth;
    c.fill();

    // Surface disc, drawn over the body so the far edge reads as the liquid
    // meeting the back wall.
    c.beginPath();
    for (let i = 0; i <= SAMPLES * 2; i++) {
      const [x, y] = surfacePoint((i / (SAMPLES * 2)) * Math.PI * 2);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.closePath();
    c.fillStyle = shadeHex(liquid, 0.14);
    c.fill();

    // Specular sheen across the surface, offset toward the light.
    c.save();
    c.clip();
    const sheen = c.createLinearGradient(cx - rx, surfCy - ry, cx + rx * 0.3, surfCy + ry);
    sheen.addColorStop(0, "rgba(255,255,255,0.3)");
    sheen.addColorStop(0.55, "rgba(255,255,255,0.05)");
    sheen.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = sheen;
    c.fillRect(cx - rx, surfCy - ry * 2, rx * 2, ry * 4);
    c.restore();

    // Meniscus: the liquid climbs the wall it touches. A bright hairline
    // along the far edge and a darker contact shadow along the near one is
    // enough to stop the surface reading as a disc pasted into a tube.
    c.beginPath();
    for (let i = 0; i <= SAMPLES; i++) {
      const [x, y] = surfacePoint(Math.PI + (i / SAMPLES) * Math.PI);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.strokeStyle = "rgba(255,255,255,0.45)";
    c.lineWidth = 1.4;
    c.stroke();

    c.beginPath();
    for (let i = 0; i <= SAMPLES; i++) {
      const [x, y] = surfacePoint((i / SAMPLES) * Math.PI);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.strokeStyle = withAlpha(shadeHex(liquid, -0.3), 0.55);
    c.lineWidth = 1.2;
    c.stroke();

    // --- foam, then the impact effects that ride on top of it ----------
    const foamH = this.foam * FOAM_MAX_FRACTION * (l.baseCy - l.topCy);
    const hasFoam = foamH > 1;
    if (hasFoam) {
      const foamColor = shadeHex(liquid, 0.5);
      const foamTop = surfCy - foamH;
      c.beginPath();
      for (let i = 0; i <= SAMPLES * 2; i++) {
        const theta = (i / (SAMPLES * 2)) * Math.PI * 2;
        const [x, y] = surfacePoint(theta);
        if (i === 0) c.moveTo(x, y - foamH);
        else c.lineTo(x, y - foamH);
      }
      c.closePath();
      c.fillStyle = shadeHex(foamColor, 0.1);
      c.fill();
      c.fillStyle = foamColor;
      c.fillRect(cx - l.topRx, foamTop, l.topRx * 2, foamH * 0.6);
      c.fillStyle = shadeHex(foamColor, -0.1);
      for (let i = 0; i < 5; i++) {
        const a = this.sloshPhase * 0.3 + i * 1.7;
        const bx = cx + Math.cos(a) * rx * 0.55;
        const by = foamTop + Math.sin(a) * ry * 0.5;
        c.beginPath();
        c.arc(bx, by, Math.max(1, foamH * 0.16), 0, Math.PI * 2);
        c.fill();
      }
    }

    const impactCy = hasFoam ? surfCy - foamH : surfCy;
    const squash = ry / Math.max(rx, 1e-4);
    for (const ring of this.ripples) {
      const fade = Math.max(0, ring.life / RIPPLE_LIFE_SEC);
      const ringRx = Math.min(ring.radius, rx * 0.94);
      if (ringRx <= 1) continue;
      c.beginPath();
      c.ellipse(this.layoutImpactX(l), impactCy, ringRx, ringRx * squash, 0, 0, Math.PI * 2);
      c.strokeStyle = `rgba(255,255,255,${(0.4 * fade).toFixed(3)})`;
      c.lineWidth = 1.3;
      c.stroke();
    }

    if (this.crater > 0.02) {
      const craterRx = Math.max(3, l.cupW * 0.055) * this.crater;
      c.beginPath();
      c.ellipse(this.layoutImpactX(l), impactCy, craterRx, craterRx * squash, 0, 0, Math.PI * 2);
      c.fillStyle = withAlpha(shadeHex(liquid, -0.22), 0.8 * this.crater);
      c.fill();
    }
  }

  private layoutImpactX(l: Layout): number {
    return l.impactX;
  }

  /** The cup's permanent brand surface. Opaque, so it sits LOW and stays
   * clear of where the fill band can ever be — pickBandCentre() never goes
   * below 0.5 of the cup. A sleeve across the middle hid the band and the
   * liquid level at exactly the moment the player needs to read them. Its
   * top and bottom edges are ellipse arcs, so it wraps the cylinder instead
   * of sitting on it like a label. */
  private renderSleeve(
    c: CanvasRenderingContext2D,
    l: Layout,
    cx: number,
    brandLogo: HTMLImageElement | null,
  ): void {
    const { brand } = this.ctx;
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
    const shade = c.createLinearGradient(cx - sleeveTopRx, 0, cx + sleeveTopRx, 0);
    shade.addColorStop(0, shadeHex(brand.accent, -0.24));
    shade.addColorStop(0.35, shadeHex(brand.accent, 0.1));
    shade.addColorStop(1, shadeHex(brand.accent, -0.28));
    c.fillStyle = shade;
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
  }

  /**
   * The target. This is the one thing on screen the player is acting on, so
   * it gets a soft pulsing glow and brightens further when the surface is
   * actually inside it — which teaches the objective without a word of copy.
   *
   * Each edge is stroked twice, dark then light one pixel below. A single
   * colour cannot work: the band sits over the pale empty interior near the
   * rim and over the dark liquid once the cup fills, and either one alone
   * disappears against half of that.
   */
  private renderTargetBand(c: CanvasRenderingContext2D, l: Layout, cx: number, surfCy: number): void {
    const { brand } = this.ctx;
    const bandCy = this.surfaceCy(l.topCy, l.baseCy, this.bandCentre);
    const bandSpan = (l.baseCy - l.topCy) * this.bandWidth;
    const inside = Math.abs(surfCy - bandCy) <= bandSpan / 2;
    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 3.4);
    const glow = inside ? 0.85 : 0.3 + pulse * 0.25;

    c.save();
    c.fillStyle = `rgba(255,255,255,${(inside ? 0.26 : 0.14).toFixed(3)})`;
    c.fillRect(cx - l.topRx, bandCy - bandSpan / 2, l.topRx * 2, bandSpan);

    c.shadowColor = withAlpha(brand.accent, glow);
    c.shadowBlur = inside ? 14 : 8;
    for (const edgeY of [bandCy - bandSpan / 2, bandCy + bandSpan / 2]) {
      const rx = this.rxAt(l, edgeY);
      for (const [dy, stroke, width] of [
        [0, withAlpha(brand.foreground, 0.75), 2.5],
        [1.5, `rgba(255,255,255,${(0.75 + glow * 0.25).toFixed(3)})`, 1.5],
      ] as [number, string, number][]) {
        c.beginPath();
        c.ellipse(cx, edgeY + dy, rx, rx * 0.2, 0, 0, Math.PI);
        c.strokeStyle = stroke;
        c.lineWidth = width;
        c.stroke();
      }
    }
    c.restore();
  }

  /** The glass pass: laid over the liquid and the sleeve, which is what
   * makes both look like they are INSIDE the vessel rather than painted on
   * top of it. Two specular stripes and a darker edge on each side. */
  private renderGlass(
    c: CanvasRenderingContext2D,
    l: Layout,
    cx: number,
    bodyPath: () => void,
  ): void {
    const top = l.topCy;
    const bottom = l.baseCy + l.baseRy;

    c.save();
    // Broad soft highlight down the left, where the light is.
    const gloss = c.createLinearGradient(cx - l.topRx * 0.62, 0, cx - l.topRx * 0.1, 0);
    gloss.addColorStop(0, "rgba(255,255,255,0)");
    gloss.addColorStop(0.45, "rgba(255,255,255,0.3)");
    gloss.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = gloss;
    c.fillRect(cx - l.topRx * 0.62, top, l.topRx * 0.52, bottom - top);

    // A thin hard reflection just inside the right wall — the giveaway that
    // a surface is glassy rather than matte.
    const edge = c.createLinearGradient(cx + l.topRx * 0.6, 0, cx + l.topRx, 0);
    edge.addColorStop(0, "rgba(255,255,255,0)");
    edge.addColorStop(0.7, "rgba(255,255,255,0.22)");
    edge.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = edge;
    c.fillRect(cx + l.topRx * 0.6, top, l.topRx * 0.4, bottom - top);

    // Both walls darken at the silhouette, which is what gives a
    // transparent cylinder its thickness.
    const walls = c.createLinearGradient(cx - l.topRx, 0, cx + l.topRx, 0);
    walls.addColorStop(0, "rgba(0,0,0,0.2)");
    walls.addColorStop(0.12, "rgba(0,0,0,0)");
    walls.addColorStop(0.88, "rgba(0,0,0,0)");
    walls.addColorStop(1, "rgba(0,0,0,0.24)");
    c.fillStyle = walls;
    bodyPath();
    c.fill();

    if (this.missFlash > 0) {
      c.fillStyle = `rgba(209,67,67,${(0.12 * this.missFlash).toFixed(3)})`;
      bodyPath();
      c.fill();
    }
    c.restore();
  }

  /** A short "PERFECT" call for a dead-centre serve, riding the same pop
   * spring as the cup so it lands with the bounce rather than beside it. */
  private renderPerfect(c: CanvasRenderingContext2D, l: Layout): void {
    if (this.perfectT <= 0) return;
    const { brand } = this.ctx;
    const t = 1 - this.perfectT / PERFECT_LABEL_SEC;
    const rise = t * l.cupH * 0.16;
    const alpha = Math.min(1, (1 - t) * 2.2);
    const scale = 1 + Math.max(0, 0.28 - t * 0.6);

    c.save();
    c.globalAlpha = alpha;
    c.translate(l.impactX, l.topCy - l.cupH * 0.04 - rise);
    c.scale(scale, scale);
    c.font = `800 ${Math.round(l.cupW * 0.16)}px ${brand.fontFamily}, system-ui, sans-serif`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.lineWidth = 4;
    c.strokeStyle = "rgba(255,255,255,0.9)";
    c.strokeText("PERFECT", 0, 0);
    c.fillStyle = brand.accent;
    c.fillText("PERFECT", 0, 0);
    c.restore();
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
