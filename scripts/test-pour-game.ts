// scripts/test-pour-game.ts
//
// Headless check for lib/runtime/games/pour.ts. update() never touches the
// canvas, so whole rounds run with a hand-built RuntimeContext.
//
// What it protects:
//   1. An overflow costs a life and scores nothing. This is the template's
//      whole fail state; a version that quietly scored an overflow would
//      look fine on screen and pay out coupons for doing nothing.
//   2. Under-pouring costs a life too. Tapping below the band is the other
//      way to waste a cup and must not be free.
//   3. A serve inside the band scores, and dead-centre scores more than the
//      edge of the band — the accuracy bonus is the only reason to aim
//      rather than mash.
//   4. recordEngagement fires for a served product but NEVER for the brand
//      logo, which the `prize` role's `fallback: "logo"` can genuinely put
//      in the pool (this exact trap shipped once in sweetSpot.ts).
//   5. maxRealisticScore stays in the capability's ballpark — it is the
//      server-side forged-score ceiling.
//
// Run: npm run test:pour

import { createPourGame } from "../lib/runtime/games/pour";
import { getCapability } from "../lib/capabilities";
import type { LoadedAsset, RuntimeContext } from "../lib/runtime/gameModule";
import type { GameSpec } from "../lib/engine/types";

const capability = getCapability("pour");
if (!capability) throw new Error("pour capability missing from the registry");

const DT = 1 / 60;
const LOGO_URL = "https://example.test/logo.png";

function defaultTuning(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, range] of Object.entries(capability!.tuning)) out[key] = range.default;
  return out;
}

function prize(id: string, src: string): LoadedAsset {
  return { id, image: { src } as HTMLImageElement, width: 200, height: 200 };
}

interface Harness {
  game: ReturnType<typeof createPourGame>;
  ctx: RuntimeContext;
  engagements: string[];
  score(): number;
  lives(): number;
  fill(): number;
  band(): { centre: number; width: number };
  droplets(): number;
  slosh(): number;
  ripples(): number;
  foam(): number;
  tap(): void;
  step(): void;
}

function harness(tuning: Record<string, number>, prizes: LoadedAsset[]): Harness {
  const game = createPourGame();
  const engagements: string[] = [];
  let score = 0;

  const ctx: RuntimeContext = {
    spec: { tuning } as unknown as GameSpec,
    tuning,
    roles: { prize: { assets: prizes } },
    brand: {
      accent: "#C2612F",
      background: "#FBF7F2",
      foreground: "#1F1710",
      fontFamily: "Fraunces",
      palette: [],
      logoUrl: LOGO_URL,
    },
    brandLogo: null,
    copy: { headline: "", subhead: "", ctaStart: "", ctaReplay: "", rewardIntro: "", emailPrompt: "" },
    stage: { width: 420, height: 720 },
    input: {
      pointerX: 0,
      pointerY: 0,
      pointerDown: false,
      justPressed: false,
      justReleased: false,
      keysDown: new Set<string>(),
      confirmPressed: false,
    },
    random: () => 0.5,
    addScore: (delta) => {
      score += delta;
    },
    getScore: () => score,
    recordEngagement: (id) => engagements.push(id),
    complete: () => {},
  };

  game.init(ctx);
  const inner = game as unknown as {
    fill: number;
    bandCentre: number;
    bandWidth: number;
    livesLeft: number;
    droplets: unknown[];
    sloshAmp: number;
    ripples: unknown[];
    foam: number;
  };
  return {
    game,
    ctx,
    engagements,
    score: () => score,
    lives: () => inner.livesLeft,
    fill: () => inner.fill,
    band: () => ({ centre: inner.bandCentre, width: inner.bandWidth }),
    droplets: () => inner.droplets.length,
    slosh: () => inner.sloshAmp,
    ripples: () => inner.ripples.length,
    foam: () => inner.foam,
    tap: () => {
      ctx.input.justPressed = true;
      game.update(DT);
      ctx.input.justPressed = false;
    },
    step: () => game.update(DT),
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL  ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok    ${message}`);
}

/** Runs the pour until `fill` reaches `target`, without tapping. */
function fillTo(h: Harness, target: number): void {
  for (let i = 0; i < 60 * 30 && h.fill() < target; i++) h.step();
}

// --- 1. an overflow costs a life and scores nothing ----------------------
{
  const h = harness(defaultTuning(), [prize("p1", "https://example.test/p1.png")]);
  const livesBefore = h.lives();
  fillTo(h, 1);
  h.step();
  assert(h.score() === 0, `overflowing scores nothing (got ${h.score()})`);
  assert(h.lives() === livesBefore - 1, `overflowing costs exactly one life (${livesBefore} -> ${h.lives()})`);
}

// --- 2. under-pouring costs a life too -----------------------------------
{
  const h = harness(defaultTuning(), [prize("p1", "https://example.test/p1.png")]);
  const livesBefore = h.lives();
  const { centre, width } = h.band();
  fillTo(h, Math.max(0.02, centre - width));
  h.tap();
  assert(h.score() === 0, `tapping below the band scores nothing (got ${h.score()})`);
  assert(h.lives() === livesBefore - 1, `tapping below the band costs a life (${livesBefore} -> ${h.lives()})`);
}

// --- 3. a serve scores, and dead centre beats the band edge --------------
let centreScore = 0;
{
  const h = harness(defaultTuning(), [prize("p1", "https://example.test/p1.png")]);
  const livesBefore = h.lives();
  fillTo(h, h.band().centre);
  h.tap();
  centreScore = h.score();
  assert(centreScore > 0, `a serve inside the band scores (got ${centreScore})`);
  assert(h.lives() === livesBefore, `a serve costs no lives (${h.lives()})`);
  assert(h.engagements.length === 1, `a serve records exactly one engagement (${h.engagements.length})`);
}
{
  const h = harness(defaultTuning(), [prize("p1", "https://example.test/p1.png")]);
  const { centre, width } = h.band();
  // Not right at the band edge: fillTo() overshoots its target by up to one
  // step, and tap() advances the pour one more before it reads the input
  // (the tap is judged against the fill on the frame it arrives, which is
  // what the player sees). Two steps of slack at the default fillSpeed is
  // ~0.017 of the cup, so aim comfortably inside.
  fillTo(h, centre + width * 0.28);
  h.tap();
  assert(
    h.score() > 0 && h.score() < centreScore,
    `an edge-of-band serve scores less than dead centre (${h.score()} < ${centreScore})`,
  );
}

// --- 4. the brand logo in the prize pool is never an engagement ----------
{
  const h = harness(defaultTuning(), [prize("logo-asset", LOGO_URL)]);
  fillTo(h, h.band().centre);
  h.tap();
  assert(h.score() > 0, `a logo-only pool still plays and scores (${h.score()})`);
  assert(
    h.engagements.length === 0,
    `the brand logo is never recorded as an engaged product (${h.engagements.join(", ") || "none"})`,
  );
}

// --- 5. the splash particles stay bounded and settle ---------------------
// The only thing in this module that can grow without limit. A pour runs for
// the whole round, so an uncapped spawn would be a slow leak on a third-
// party storefront's main thread — the one place that must never happen.
{
  const h = harness(defaultTuning(), [prize("p1", "https://example.test/p1.png")]);
  let peak = 0;
  // Several cups' worth of continuous pouring and overflowing.
  for (let i = 0; i < 60 * 25; i++) {
    h.step();
    peak = Math.max(peak, h.droplets());
  }
  assert(peak > 0, `pouring actually throws splash droplets (peak ${peak})`);
  assert(peak <= 36, `droplet count stays at or under the cap of 36 (peak ${peak})`);
}

// Ripples are the other unbounded array, and the foam is the other value
// that only ever grows under the stream.
{
  const h = harness(defaultTuning(), [prize("p1", "https://example.test/p1.png")]);
  let peakRipples = 0;
  let peakFoam = 0;
  for (let i = 0; i < 60 * 25; i++) {
    h.step();
    peakRipples = Math.max(peakRipples, h.ripples());
    peakFoam = Math.max(peakFoam, h.foam());
  }
  assert(peakRipples > 0, `the impact throws surface rings (peak ${peakRipples})`);
  assert(peakRipples <= 4, `ripple count stays at or under the cap of 4 (peak ${peakRipples})`);
  assert(peakFoam > 0.2, `a head builds under the pour (peak ${peakFoam.toFixed(2)})`);
  assert(peakFoam <= 1, `the head never exceeds full (peak ${peakFoam.toFixed(3)})`);
}

// While a cup is held (served or overflowing) the stream has stopped, so
// nothing new may be thrown and the surface must be visibly settling. The
// hold is short by design — the next cup starts right after it — so this
// measures the hold window itself rather than waiting for a full stop.
{
  const h = harness(defaultTuning(), [prize("p1", "https://example.test/p1.png")]);
  fillTo(h, h.band().centre);
  h.tap(); // serve -> phase leaves "pouring"
  const sloshAtTap = h.slosh();
  const foamAtTap = h.foam();
  const dropletsAtTap = h.droplets();
  assert(sloshAtTap > 0, `the pour feeds the surface slosh (${sloshAtTap.toFixed(3)})`);

  let peakDuringHold = 0;
  for (let i = 0; i < 24; i++) {
    h.step(); // 0.4s, inside the 0.45s hold
    peakDuringHold = Math.max(peakDuringHold, h.droplets());
  }
  assert(
    peakDuringHold <= dropletsAtTap,
    `a held cup throws no new droplets (${dropletsAtTap} -> peak ${peakDuringHold})`,
  );
  assert(
    h.slosh() < sloshAtTap * 0.45,
    `the slosh damps while the cup is held (${sloshAtTap.toFixed(3)} -> ${h.slosh().toFixed(3)})`,
  );
  assert(
    h.foam() < foamAtTap,
    `the head starts collapsing once the pour stops (${foamAtTap.toFixed(3)} -> ${h.foam().toFixed(3)})`,
  );
}

// --- 6. the forged-score ceiling matches the capability ------------------
{
  const game = createPourGame();
  const ceiling = game.maxRealisticScore(defaultTuning());
  const declared = capability.scoring.maxRealistic;
  assert(
    Math.abs(ceiling - declared) <= declared * 0.15,
    `maxRealisticScore ${ceiling} is within 15% of the declared ceiling ${declared}`,
  );
}

if (process.exitCode) console.error("\npour: FAILED");
else console.log("\npour: all checks passed");
