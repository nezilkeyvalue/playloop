// scripts/test-chomp-game.ts
//
// Headless check for lib/runtime/games/chomp.ts. update() never touches the
// canvas, so a whole round can be driven with a hand-built RuntimeContext.
//
// What it protects:
//   1. recordEngagement() fires for every product the player eats. It did
//      NOT before this board work — chomp scored the eat and dropped the
//      pellet without ever telling mount.ts, so the reward screen's recap
//      gallery came up empty on every chomp game ever played. That is the
//      whole reason this check exists.
//   2. Node occupancy: pellets sit one-per-node, never stacked. The board
//      reads as designed only if that holds, and the bug would look like
//      "sometimes two products overlap" — easy to miss by eye.
//   3. The live pellet count is capped by what the stage can actually seat,
//      so a 300x250 ad slot doesn't try to place 10 pellets on 6 nodes.
//
// Run: npm run test:chomp

import { createChompGame } from "../lib/runtime/games/chomp";
import { getCapability } from "../lib/capabilities";
import type { LoadedAsset, RuntimeContext } from "../lib/runtime/gameModule";
import type { GameSpec } from "../lib/engine/types";

const capability = getCapability("chomp");
if (!capability) throw new Error("chomp capability missing from the registry");

const DT = 1 / 60;

function defaultTuning(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, range] of Object.entries(capability!.tuning)) out[key] = range.default;
  return out;
}

/** A pellet pool of real-looking assets. `image` is a stand-in object: the
 * module only ever checks it for truthiness and hands it to canvas draws,
 * which this headless run never reaches. */
function pool(count: number): LoadedAsset[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    image: {} as HTMLImageElement,
    width: 200,
    height: 200,
    data: { name: `Product ${i}` },
  }));
}

interface Harness {
  game: ReturnType<typeof createChompGame>;
  ctx: RuntimeContext;
  engagements: string[];
  step(): void;
}

function harness(tuning: Record<string, number>, stage: { width: number; height: number }): Harness {
  const game = createChompGame();
  const engagements: string[] = [];
  let score = 0;

  const ctx: RuntimeContext = {
    spec: { tuning } as unknown as GameSpec,
    tuning,
    roles: { pellet: { assets: pool(6) } },
    brand: {
      accent: "#2F7D5C",
      background: "#F4F7F2",
      foreground: "#1C2B22",
      fontFamily: "Inter",
      palette: [],
    },
    brandLogo: null,
    copy: {
      headline: "Eat the gear",
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
    random: () => Math.random(),
    addScore: (delta) => {
      score += delta;
    },
    getScore: () => score,
    recordEngagement: (id) => engagements.push(id),
    complete: () => {},
  };

  game.init(ctx);
  return { game, ctx, engagements, step: () => game.update(DT) };
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL  ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok    ${message}`);
}

/** The module keeps its pellets private, so read them the way the renderer
 * would: this is the one place the test reaches past the public surface,
 * and it is deliberate — the invariants worth protecting here are about
 * pellet placement, which has no other observable. */
function pelletsOf(game: unknown): { x: number; y: number; node: number }[] {
  return (game as { pellets: { x: number; y: number; node: number }[] }).pellets;
}

const stages = [
  { width: 300, height: 250 }, // the smallest declared ad slot
  { width: 420, height: 760 },
  { width: 1200, height: 660 },
];

// --- 1. eating a product records engagement ------------------------------
for (const stage of stages) {
  const h = harness(defaultTuning(), stage);
  const label = `${stage.width}x${stage.height}`;

  // Drive the chaser onto each pellet in turn by pointing at it. The module
  // moves toward input.pointer* at moveSpeed, so this is a real player
  // drag, not a teleport.
  const seen = new Set<string>();
  h.ctx.input.pointerDown = true;
  for (let step = 0; step < 60 * 20; step++) {
    const target = pelletsOf(h.game)[0];
    if (target) {
      h.ctx.input.pointerX = target.x;
      h.ctx.input.pointerY = target.y;
    }
    h.step();
    for (const id of h.engagements) seen.add(id);
    if (seen.size >= 3) break;
  }

  assert(h.engagements.length > 0, `${label} — eating a product calls recordEngagement (${h.engagements.length} calls)`);
  assert(seen.size >= 2, `${label} — engagement reaches more than one distinct product (${seen.size})`);
}

// --- 2. one pellet per node, at every stage size -------------------------
for (const stage of stages) {
  const h = harness(defaultTuning(), stage);
  const label = `${stage.width}x${stage.height}`;
  let worstDuplicate = 0;

  h.ctx.input.pointerDown = true;
  for (let step = 0; step < 60 * 15; step++) {
    const target = pelletsOf(h.game)[0];
    if (target) {
      h.ctx.input.pointerX = target.x;
      h.ctx.input.pointerY = target.y;
    }
    h.step();
    const nodes = pelletsOf(h.game).map((p) => p.node);
    worstDuplicate = Math.max(worstDuplicate, nodes.length - new Set(nodes).size);
  }
  assert(worstDuplicate === 0, `${label} — no two pellets ever share a node (worst overlap ${worstDuplicate})`);
}

// --- 3. the live count never exceeds what the board can seat -------------
{
  const tuning: Record<string, number> = { ...defaultTuning(), pelletCount: capability.tuning.pelletCount!.max };
  const h = harness(tuning, { width: 300, height: 250 });
  const live = pelletsOf(h.game).length;
  assert(
    live <= tuning.pelletCount!,
    `a 300x250 board seats ${live} pellets, at or under the requested ${tuning.pelletCount}`,
  );
  assert(live >= 4, `a 300x250 board still seats a playable number of pellets (${live})`);
}

// --- 4. the forged-score ceiling still matches the capability ------------
{
  const game = createChompGame();
  const ceiling = game.maxRealisticScore(defaultTuning());
  const declared = capability.scoring.maxRealistic;
  assert(
    Math.abs(ceiling - declared) <= declared * 0.1,
    `maxRealisticScore ${ceiling} is within 10% of the declared ceiling ${declared}`,
  );
}

if (process.exitCode) console.error("\nchomp: FAILED");
else console.log("\nchomp: all checks passed");
