# Adding a new game template

The matcher, brain, compose step, and editor are all data-driven off
`lib/capabilities/*.json` — none of them contain template-specific branches
(verified: `matcher.ts` only reads capability JSON; `brain.ts`'s only
per-template thing is the free-form `tuning` keys, which it copies through
generically; the editor looks up `getCapability(spec.template)` and renders
whatever roles it declares). So adding a template is additive: new files
plus a couple of one-line registrations. Nothing above gets touched.

`TemplateId` (`lib/engine/types.ts`) already reserves `"match"` and
`"stack"` for this reason — use one of those ids, or extend the union (see
step 0) for something new entirely.

## Step 0 — only if the id doesn't already exist

If you're not implementing `match` or `stack`, add the new id in exactly
three places (all small, low-conflict-risk, shared files):

1. `TemplateId` union in `lib/engine/types.ts`
2. The `z.enum([...])` for `id` in `lib/capabilities/index.ts`'s
   `gameCapabilitySchema`
3. The `z.enum([...])` for `template` in `app/api/games/route.ts`'s
   `gameSpecSchema` — easy to miss since it's a separate, independent zod
   schema for the same value (this route accepts a hand-assembled `GameSpec`
   directly from manual mode's build wizard, rather than going through the
   capability-JSON pipeline the other two touch). Missing this one doesn't
   fail loudly: chain_pop and shooter both shipped fully working in auto
   mode while manual mode silently rejected every attempt to create either,
   until this line was found and fixed.

## Step 1 — capability JSON (`lib/capabilities/<id>.json`)

This is the design of the template: what roles it needs, how picky each
role is, what happens when a role can't be filled, what tuning knobs exist
and their ranges, and where it fits (`section`/`fullpage`/`modal`/`ad`).
Copy `lib/capabilities/catch.json` as a starting shape and read
`GameCapability`/`CapabilityRole` in `types.ts` for what every field means.
Things worth getting right up front:

- **`roles[].fallback`**: `"none"` means the role is a hard requirement —
  no assets means the whole template is ineligible for a given site.
  Everything else (`"generatedShape"`, `"brandGradient"`, `"logo"`,
  `"solid"`) means the runtime module must be able to render *something*
  reasonable with zero real assets in that role — don't assume a role is
  always filled just because it's not `optional`.
- **`scoring.maxRealistic`**: an estimate you'll reconcile against the
  runtime module's actual `maxRealisticScore()` in step 3 — see
  `catch.ts`'s comment for the derivation pattern (walk through the default
  tuning and compute the ceiling by hand).
- **`tuning`**: every key here gets defensively clamped by `mount.ts`
  (`clampTuning`) before the runtime module sees it, and the brain is
  allowed to set any of these keys within range — so pick names that read
  clearly in a Gemini prompt (`spawnRateHz`, not `k1`).

## Step 2 — register the capability (`lib/capabilities/index.ts`)

Two one-line additions:

```ts
import myTemplateCapability from "./my_template.json";
// ...
const registry: Record<string, GameCapability> = {
  catch: validate(catchCapability, "catch.json"),
  guess_price: validate(guessPriceCapability, "guess_price.json"),
  my_template: validate(myTemplateCapability, "my_template.json"), // add this
};
```

The moment this lands, `matchAssets()` will start scoring real sites
against your template and the brain will start considering it eligible —
before you've written a single line of runtime code. That's fine and
expected; `mount.ts` degrades gracefully (see step 4) for a template with a
capability but no registered game module.

## Step 3 — runtime module (`lib/runtime/games/<id>.ts`)

Implement `GameModule` (`lib/runtime/gameModule.ts`):

```ts
import type { GameModule, RuntimeContext } from "@/lib/runtime/gameModule";

export function maxRealisticScore(tuning: Record<string, number>): number {
  // mirror capability JSON's scoring.maxRealistic at default tuning —
  // see catch.ts's comment block for the derivation pattern
}

class MyTemplateGame implements GameModule {
  id: "my_template" = "my_template";
  private ctx!: RuntimeContext;

  init(ctx: RuntimeContext) {
    this.ctx = ctx;
    // ctx.roles["<role id from your capability JSON>"] — {assets, fallback?}
    // ctx.brand, ctx.copy, ctx.tuning, ctx.stage, ctx.input are all ready
  }

  update(dt: number) {
    // read this.ctx.input (pointer/keys — see input.ts's InputState), mutate
    // game state, call this.ctx.addScore(delta) as needed, and
    // this.ctx.complete() the instant the round is over
  }

  render(c: CanvasRenderingContext2D) {
    // draw against this.ctx.stage.width/height every frame; for any role
    // with no real asset, draw a generated fallback (shape/gradient/solid)
    // per that role's declared `fallback` — never assume a sprite exists.
    //
    // For any role that draws a real sprite, prefer
    // lib/runtime/games/spriteRender.ts's drawAssetContain() (or the lower-
    // level containFit/colorAdjustFilterString/createBlurredBackdrop it's
    // built from) over a raw drawImage — it crops toward SubjectBounds and
    // applies ColorAdjust for you, which is most of what makes a product
    // read clearly instead of a stretched, padded sprite. Also draw
    // `this.celebrations` (if you're using the Celebration primitive) last,
    // after everything else, so it reads as the clear focal point.
  }

  teardown() {
    // clear timers/listeners you own; mount.ts already tears down the loop
    // and input for you
  }

  maxRealisticScore(tuning: Record<string, number>) {
    return maxRealisticScore(tuning);
  }
}

export function createMyTemplateGame(): GameModule {
  return new MyTemplateGame();
}
```

Ground rules (see `CLAUDE.md`'s hazards list for the *why*):

- Never touch the DOM directly, read `document`/`window`, or attach
  listeners — everything you need is on `RuntimeContext`. `mount.ts` owns
  the DOM, input capture, telemetry, and the idle/reward overlay chrome
  entirely; your module only draws to the canvas it's handed.
- Don't assume a role's `assets` array is non-empty just because it isn't
  `optional` — a role can still resolve to `{ assets: [], fallback: "..." }`
  when nothing survived the quality gate for it. Always branch on
  `role.assets.length > 0 ? draw sprite : draw fallback`.
- Colors come from `ctx.brand` (hex strings) — no hardcoded colors, this is
  what makes the same template look right for every brand.
- Call `ctx.recordEngagement(assetId)` for every real product asset the
  player succeeds against, and only those — never for hazards, decoys, or
  generated-shape/synthesized fallbacks. This isn't optional polish: the
  reward screen's recap gallery is built entirely from what each template
  reports here, so skipping it means your template's reward screen shows no
  products at all, silently, with no error to catch it.

## Step 4 — register the runtime module (`lib/runtime/mount.ts`)

```ts
import { createMyTemplateGame } from "@/lib/runtime/games/myTemplate";
// ...
const REGISTRY: Partial<Record<TemplateId, GameModuleFactory>> = {
  catch: createCatchGame,
  guess_price: createGuessPriceGame,
  my_template: createMyTemplateGame, // add this
};
```

Until this line lands, any `GameSpec` the pipeline produces with your
template renders `mount.ts`'s friendly "isn't ready to play yet" message
instead of crashing — so steps 1–3 are safe to ship/merge independently of
step 4 if you want a slower rollout.

## Step 5 — a fixture (`lib/runtime/fixtures/sampleGameSpec.ts`)

Add a hand-written, complete `GameSpec` for your template and add it to the
exported `fixtureGameSpecs` map. This is what lets you (and everyone else)
exercise the new template with zero pipeline/DB dependency:

- `/play/<your-fixture-id>` serves it directly, no DB hit
- the marketing homepage slideshow (`components/ShowcaseSlideshow.tsx`) and
  `GamePreviewModal` can mount it directly for visual QA
- it becomes the reference input for anyone iterating on the runtime module

Use inline SVG `data:` URIs for sprites (see the existing `colorSprite()`
helper in that file) so the fixture needs no network and works offline/CI.

## Step 6 — verify

```bash
npm run typecheck
```

Then, in a real browser (see `CLAUDE.md`'s Playwright verification workflow
for the temp-install pattern): mount your fixture via `/play/<id>` or
`GamePreviewModal`, and click through idle → play → complete → reward for
every role-fallback combination you care about (e.g. zero hazard assets,
zero background asset) — `mount.ts` won't catch a fallback rendering bug,
only a missing-role crash. Actually succeed against a real product asset at
least once (catch it/pop it/hit it/whatever your mechanic's win condition
is) and confirm the reward screen's recap gallery shows it — a template
that never calls `ctx.recordEngagement()` fails silently here (an empty
gallery looks identical to "nothing was engaged," not an error), so this
needs an actual look, not just a passing typecheck. Also watch the browser
console for uncaught errors while the round transitions from play to
reward — a template whose `render()` isn't defensive against state
`teardown()` just cleared can throw there (see `CLAUDE.md`'s hazards list
entry on `loop.ts`'s `running` check for the general fix; this only bites a
template that keeps render()-time state your `teardown()` clears down to
something `render()` still reads unconditionally).

Nothing in `matcher.ts`, `brain.ts`, `compose.ts`, or the editor needs
changes for a well-behaved template. If you find yourself wanting to edit
one of those files to special-case your new template, that's a sign the
capability JSON isn't expressive enough yet — prefer extending
`CapabilityRole`/`GameCapability` in `types.ts` (additively) over adding an
`if (template === "...")` branch anywhere in the generic pipeline.
