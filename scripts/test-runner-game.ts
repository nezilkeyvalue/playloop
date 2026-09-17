// scripts/test-runner-game.ts
//
// Headless check for lib/runtime/games/runner.ts. update() never touches the
// canvas, so the whole round can be driven with a hand-built RuntimeContext —
// only render() needs a real 2D context, and none of the logic worth
// protecting lives there.
//
// Two things it protects:
//   1. The finish gate lands on the runner at durationSec. The gate is
//      spawned from `remaining * speed <= travelDistance` rather than a fixed
//      lead constant, so it has to stay correct across the whole scrollSpeed
//      range (180..420) and every stage width — which is exactly the kind of
//      thing that silently drifts when the speed ramp is retuned.
//   2. maxRealisticScore() stays the same order of magnitude as the
//      capability's declared scoring.maxRealistic. It is the server-side
//      forged-score ceiling (see finishPlay), so a drift either pays out
//      cheats or rejects honest players.
//
// Run: npm run test:runner

import { createRunnerGame } from "../lib/runtime/games/runner";
import { getCapability } from "../lib/capabilities";
import type { RuntimeContext } from "../lib/runtime/gameModule";
import type { GameSpec } from "../lib/engine/types";

const capability = getCapability("runner");
if (!capability) throw new Error("runner capability missing from the registry");

const DT = 1 / 60;

interface RunResult {
  completedAt: number | null;
  completeCalls: number;
  score: number;
}

function defaultTuning(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, range] of Object.entries(capability!.tuning)) out[key] = range.default;
  return out;
}

/** Drives a full round headlessly and reports when complete() fired. */
function playRound(tuning: Record<string, number>, stage: { width: number; height: number }): RunResult {
  const game = createRunnerGame();
  let score = 0;
  let completedAt: number | null = null;
  let completeCalls = 0;
  let elapsed = 0;

  const ctx: RuntimeContext = {
    spec: { tuning } as unknown as GameSpec,
    tuning,
    // One collectible so the spawner runs; image is null, which is the
    // real "sprite failed to load" path and keeps this free of any DOM.
    roles: { collectible: { assets: [{ id: "a1", image: null, width: 200, height: 200 }] } },
    brand: {
      accent: "#ff5500",
      background: "#ffffff",
      foreground: "#111111",
      fontFamily: "Inter",
      palette: [],
    },
    brandLogo: null,
    copy: {
      headline: "",
      subhead: "",
      ctaStart: "",
      ctaReplay: "",
      rewardIntro: "",
      emailPrompt: "",
    },
    stage,
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
    recordEngagement: () => {},
    complete: () => {
      completeCalls++;
      if (completedAt === null) completedAt = elapsed;
    },
  };

  game.init(ctx);
  // Hard cap well past any legal durationSec so a never-ending round fails
  // the assertion below instead of hanging the script.
  const maxSteps = Math.ceil((tuning.durationSec! + 20) / DT);
  for (let step = 0; step < maxSteps && completedAt === null; step++) {
    elapsed += DT;
    game.update(DT);
  }
  game.teardown();
  return { completedAt, completeCalls, score };
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL  ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok    ${message}`);
}

// --- 1. the finish gate lands on time, across the tuning range ------------
const speeds = [capability.tuning.scrollSpeed!.min, capability.tuning.scrollSpeed!.default, capability.tuning.scrollSpeed!.max];
const stages = [
  { width: 300, height: 250 }, // the smallest declared ad slot
  { width: 420, height: 760 },
  { width: 1200, height: 660 }, // a wide section — the longest gate travel
];

for (const scrollSpeed of speeds) {
  for (const stage of stages) {
    // obstacleRateHz 0 switches hurdles off (intervalFor() maps it to
    // Infinity), so the finish gate is the ONLY thing that can end this
    // round. The driver never jumps, so with hurdles on it would just
    // lose all its lives in the first six seconds and prove nothing
    // about the gate. Losing on lives is covered separately below.
    const tuning: Record<string, number> = { ...defaultTuning(), scrollSpeed, obstacleRateHz: 0 };
    const { completedAt, completeCalls } = playRound(tuning, stage);
    const duration = tuning.durationSec!;
    const label = `finish at ${duration}s (speed ${scrollSpeed}, ${stage.width}x${stage.height})`;

    if (completedAt === null) {
      assert(false, `${label} — round never completed`);
      continue;
    }
    // The gate is spawned on a frame boundary and the speed keeps ramping
    // while it travels, so it arrives slightly early. Half a second is the
    // budget; a fixed lead constant used to miss by several seconds at the
    // extremes of the speed range, which is what this guards.
    const drift = Math.abs(completedAt - duration);
    assert(drift <= 0.5, `${label} — landed at ${completedAt.toFixed(2)}s (drift ${drift.toFixed(2)}s)`);
    assert(completeCalls === 1, `${label} — complete() called exactly once (got ${completeCalls})`);
  }
}

// --- 2. lives still end the round early ----------------------------------
{
  const tuning: Record<string, number> = { ...defaultTuning(), lives: 1 };
  const { completedAt } = playRound(tuning, { width: 420, height: 760 });
  assert(
    completedAt !== null && completedAt < tuning.durationSec!,
    `a 1-life round ends before the finish line (ended at ${completedAt?.toFixed(2)}s)`,
  );
}

// --- 3. the forged-score ceiling stays in the capability's ballpark -------
{
  const game = createRunnerGame();
  const ceiling = game.maxRealisticScore(defaultTuning());
  const declared = capability.scoring.maxRealistic;
  assert(
    ceiling <= declared,
    `maxRealisticScore ${ceiling} does not exceed the declared ceiling ${declared}`,
  );
  assert(
    ceiling >= declared * 0.5,
    `maxRealisticScore ${ceiling} is at least half the declared ceiling ${declared}`,
  );
}

if (process.exitCode) console.error("\nrunner: FAILED");
else console.log("\nrunner: all checks passed");
