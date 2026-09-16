# CLAUDE.md

Reference for Claude Code (or any AI agent) working in this repo. Read this
first. For depth beyond what's here, see `docs/`:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the pipeline and runtime actually work, file by file
- [`docs/ADDING_A_TEMPLATE.md`](docs/ADDING_A_TEMPLATE.md) — step-by-step recipe for a new game template
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — open work, organized into parallelizable tracks
- [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) — how to split work across people/agents without stepping on each other

## What this is

PlayLoop turns a website URL into an embeddable mini-game in ~60 seconds: it
extracts the site's brand and products, picks a game template that fits what
it found, builds a `GameSpec`, and the runtime plays it off a `<canvas>`.
Manual mode (upload images yourself) produces the same `GameSpec` through a
different front door and shares everything downstream.

## The one rule that matters

**`lib/engine/types.ts` is the shared contract.** `GameSpec`, `AssetInventory`,
`GameCapability`, `MatchReport` all live there. Every subsystem — extraction,
matcher, AI layer, DB, editor, runtime — is a boundary around this file.
Change it deliberately, additively, and in one PR that updates every consumer.
Everything else in this repo is genuinely safe to parallelize (see
`docs/CONTRIBUTING.md`).

## Repo map

```
lib/engine/           Generation pipeline (auto mode's brain)
  extract/               URL → AssetInventory (Shopify JSON → JSON-LD → OG → DOM ladder)
  sprites.ts             cutout, trim, resize, phash dedup, text-density heuristic
  quality.ts             quality gate — drops/scores assets before matching
  matcher.ts             deterministic role-assignment + template scoring
  brain.ts               Gemini call + deterministic fallback (template/copy/rewards)
  compose.ts             (inventory, match, brain output) → final GameSpec
  index.ts               runGeneration() — orchestrates the stages above
  types.ts               *** the shared contract, see above ***

lib/capabilities/      One JSON per template (data, not code) + index.ts loader/validator

lib/runtime/            Client-side game player
  mount.ts                mount(spec, container, placement) → { teardown } — the runtime entry point
  gameModule.ts            GameModule contract every template implements
  games/                   one file per template (catch.ts, guessPrice.ts, chainPop.ts, shooter.ts)
    spriteRender.ts          shared subject-aware draw helpers + the celebrate primitive — see hazards list
  stage.ts, loop.ts, input.ts, reward.ts, telemetry.ts   shared runtime services
  fixtures/sampleGameSpec.ts   hand-written GameSpecs for offline dev/demo (no pipeline needed)

lib/db/                 Dev-mode JSON-file store, or Supabase when SUPABASE_URL is set
lib/storage.ts          Blob storage (local disk in dev, Vercel Blob in prod)
lib/rateLimit.ts, lib/slug.ts

app/(marketing)/        Public landing page, gallery
app/(app)/               Builder UI: /build, /games, /games/[id] (the editor), /games/[id]/stats, /games/[id]/embed
app/api/                 generate, games, plays, leads, upload — the HTTP surface over lib/engine + lib/db
app/play/[slug]/         Hosted standalone game page
app/embed.js/            The embed script third-party sites load
app/demo-storefront/     Mock storefront showing the embed in context

components/              Shared UI (Logomark, Reveal, AnimatedNumber, EditorIcons, GamePreviewModal, HeroDoodle, ShowcaseSlideshow)
```

## Commands

```bash
npm run dev          # start dev server
npm run typecheck    # tsc --noEmit — run this after every change, it's fast and strict
npm run lint
npm run build
npm run test:extract # runs the extraction ladder against scripts/sample-sites.json
```

No external accounts needed. Leave `SUPABASE_URL` unset → JSON-file DB under
`./dev-data/`. Leave `GEMINI_API_KEY` unset → deterministic fallback in
`brain.ts` (same code path as a real Gemini timeout, so "no key" and
"degraded" are never two different behaviors to maintain).

## Conventions and hazards learned the hard way

These are real bugs found and fixed in this codebase — re-read before
touching the related area.

- **Pointer capture retargets clicks.** `lib/runtime/input.ts`'s
  `createInput()` calls `setPointerCapture()` on every pointerdown, which
  per the Pointer Events spec redirects the resulting `click` to whatever
  element called capture. `mount.ts` scopes `createInput(canvas)` — not the
  outer `shell` — specifically so overlay buttons (idle/reward screens,
  siblings of the canvas) keep receiving their own clicks. Don't widen that
  scope back to `shell`.
- **`position: sticky` doesn't create a scroll container.** A sticky column
  taller than the viewport just gets stuck with content below the fold and
  no way to reach it. The editor (`app/(app)/games/[id]/page.tsx`) sticks
  the *left* preview column and keeps the *right* column (which has
  variable-height content like the warnings box) in normal scrollable flow
  for exactly this reason. If you add sticky positioning anywhere, make sure
  the sticky element's own content can't grow past the viewport.
- **`noUncheckedIndexedAccess` is on** (`tsconfig.json`). Every array/object
  index access is `T | undefined`. Use non-null assertions (`arr[0]!`) only
  where you've just checked length/existence; otherwise handle `undefined`.
- **`brand.fontFamily` doesn't load itself.** It's just a CSS string; nothing
  fetches the actual font file unless you call `ensureGoogleFontLoaded()`
  (in `mount.ts`, called once per mount). If you add a new place that
  renders branded text outside the runtime, you need your own font loading.
- **Text density is a real heuristic, not decoration.** `sprites.ts`'s
  `estimateTextDensity()` runs a Laplacian edge-detection convolution via
  `sharp` to guess whether an image is mostly a text/badge graphic (e.g. a
  burned-in "50% OFF" banner) rather than a product photo. It is not OCR —
  don't expect it to read the text, only to flag "lots of hard edges."
- **The logo must survive candidate slicing, not just the quality gate.**
  `processSprites()` caps candidates to `MAX_CANDIDATE_IMAGES` before
  processing; on image-heavy sites the logo (often near the end of the DOM)
  used to get cut before it ever reached the quality gate. Both `sprites.ts`
  (`alwaysInclude`) and `quality.ts` (`exemptFromGate`) need the logo's
  asset id, and the exemption in `quality.ts` must skip *every* check, not
  just resolution — a logo that's a thin horizontal wordmark fails aspect
  and coverage checks that were written for square product photos.
- **Role assignment order matters.** `matcher.ts` sorts roles so
  `fallback: "none"` roles (hard-required, e.g. `collectible`) claim assets
  before optional/fallback-able roles get a chance to grab something they
  merely prefer. Without this, a generic role can starve a required one.
- **`isolatable: true` silently excludes most real product photography.**
  `sprites.ts`'s `guessSubjectType()` only ever labels an image `"product"`
  when it *also* isolated cleanly (a plain, removable background) — a
  normal-aspect lifestyle-context photo that fails isolation lands in
  `"unknown"`, not `"product"`, even though it's perfectly good tile/photo
  content. Only require `isolatable` on a role if the template actually
  floats the sprite over a stage (`catch`'s `collectible`, `guess_price`'s
  `hero`); a role that *frames* a photo (a tile, a card) doesn't need it —
  see `ProcessedAsset.presentation`/`docs/ARCHITECTURE.md` §3 for how to
  render a non-isolated photo well instead.
- **Never crop a `"photographic"` asset to make it "fit" — unless you have
  `subjectBounds`, and then only toward it.** The first attempt at the fix
  above filled a tile's frame with the photo's own `backgroundColor`
  (right) but also cropped into the sprite to reduce visible backdrop
  margin (wrong) — a subject that already filled most of the frame got its
  head/feet/edges cut off. The rule is now: without a known subject
  boundary, always scale the *whole* image in (Canvas `drawImage` "contain"
  semantics, no source-rect cropping) and fill the leftover space with
  `backgroundColor` and/or a pre-rendered blurred self-extension
  (`backgroundTreatment`) instead of cropping toward it. *With* a known
  boundary (`ProcessedAsset.subjectBounds` — see `docs/ARCHITECTURE.md` §3)
  it's safe, and often much better-looking, to crop toward it — that field
  exists specifically to mark the part of the frame that's genuinely unsafe
  to touch, so cropping to it (never into it) removes only padding, never
  content.
- **Subject-aware sprite rendering lives in `lib/runtime/games/spriteRender.ts`
  — reuse it, don't re-derive it.** `containFit`, `colorAdjustFilterString`,
  `drawAssetContain`, `createBlurredBackdrop`, `drawArcText`, and the
  `Celebration`/`updateCelebrations`/`drawCelebration` primitive are shared
  across every template's runtime module. This used to be copy-pasted
  between `chainPop.ts` and `shooter.ts` before it was extracted here — a
  new template needing subject-cropped rendering, a blurred backdrop, or
  curved text should import from this file, not write a fourth copy.
- **Every game module must call `ctx.recordEngagement(assetId)` when the
  player genuinely interacts with a real product asset.** `mount.ts`
  accumulates these (deduped) and shows a recap gallery of the actual
  products played with on the reward screen — the highest-attention moment
  of the whole session (the peak-end rule: players remember the peak and
  the end of an experience most, and the reward screen previously showed
  zero product imagery). Call it only for a *real* asset a player
  succeeded on — never for hazards/decoys/generated-shape fallbacks/
  synthesized filler (a synthesized brand-colour gem in `chainPop.ts`, a
  hazard in `catch.ts`, a missed/wrong shot in `shooter.ts`). See
  `catch.ts`'s catch branch, `chainPop.ts`'s `popGroup()`, `shooter.ts`'s
  `resolveHit()`, and `guessPrice.ts`'s `startRound()` (every round shows a
  real hero regardless of guess accuracy, so recording happens there
  unconditionally) for the four existing patterns — pick whichever matches
  your template's "moment of success." The same primitive from
  `spriteRender.ts` (above) is the natural pairing: a `Celebration` pushed
  at the same call site gives the player a brief grow-and-fade look at what
  they just engaged with, instead of it just vanishing.
- **A game module calling `ctx.complete()` synchronously from `update()`
  used to crash `chainPop.ts`'s next `render()` call in the same frame.**
  `mount.ts`'s `onGameComplete()` runs synchronously up to its first
  `await`, which includes `gameModule.teardown()` — so state a template
  clears in `teardown()` (e.g. `chainPop.ts`'s `this.grid = []`) could still
  get read by one more `render()` call before the loop actually stopped,
  since `loop.ts` unconditionally called `update()` then `render()` every
  tick. Fixed centrally in `loop.ts` (it now checks `running` again right
  after `update()`, since `loop.stop()` sets that synchronously in the same
  call chain) — new templates don't need to guard against this themselves,
  but don't remove that check, and don't assume `render()` can't run after
  `teardown()` clears something without re-verifying against this fix.
- **`undici`'s default max header size is small.** Some real-world sites
  return oversized response headers that blow past Node's default and throw
  before `safeFetch.ts` even gets a body. Both fetches there use a shared
  `undici.Agent({ maxHeaderSize: 1_048_576 })` dispatcher.
- **A site that blocks non-browser User-Agents is expected behaviour, not a
  bug to route around.** Confirmed live: uniqlo.com's edge WAF silently
  drops (no response at all, not even a clean 4xx) any request carrying our
  honest `PlayLoopBot` User-Agent. Do not "fix" this by spoofing a browser
  UA to evade a site's own deliberate bot-detection — that's evasion of an
  access control the site owner put up on purpose, not a defect in this
  codebase. Two real bugs *were* found and fixed alongside this, though:
  (1) `extract/index.ts`'s root document fetch was the one ladder step not
  wrapped in `tryStep()`, so a fully-blocked site threw all the way up
  instead of degrading to an empty inventory (which already routes the user
  to "no template fit — try manual mode", exactly as build spec §23
  intends: "sites blocking fetch → empty extraction, not a thrown error").
  (2) A single blocked origin still cost ~40s of real wall time even after
  that fix — the robots.txt lookup, the root page, the Shopify
  `products.json` probe, and the sitemap.xml probe each independently paid
  the *same* ~10s timeout discovering the *same* fact. `safeFetch.ts`'s
  `originFailureCache` (5-minute TTL, separate from the 24h response/robots
  caches) now remembers a hard failure (timeout/connection error — never a
  clean non-2xx response) per origin so every subsequent attempt in the
  same run fails immediately instead of re-timing-out; verified live this
  brought uniqlo.com's total extraction time down to ~11s (one honest
  timeout — the real floor, since confirming a truly silent origin
  necessarily costs one full wait).
- **macOS `sed` needs `-E`** for extended regex (e.g. `\+`) if you're
  scripting edits — BSD sed, not GNU.
- **Verification workflow for UI changes:** temporarily
  `npm install --no-save playwright` with
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, drive real interactions (clicks
  without `force`, real scroll positions, real PATCH round-trips) against
  `chromium.launch({ channel: "chrome" })`, then clean up every scratch
  script/screenshot and `npm uninstall playwright`. Re-check
  `git diff package.json` afterward — `npm uninstall` can revert unrelated
  dependency changes if you're not careful (this has happened: `undici` was
  once silently dropped this way and had to be re-added).

## Design system quick reference

- Semantic color tokens in `app/globals.css` (`--background`, `--foreground`,
  `--card`, `--border`, `--primary`, etc., RGB triplets consumed via
  `rgb(var(--x) / <alpha-value>)` in `tailwind.config.ts`) with a mirrored
  dark-mode block. Don't hardcode hex colors in new UI — use the tokens.
  Only `lib/runtime/mount.ts` (the actual embedded game canvas) legitimately
  uses raw hex, because it's rendering per-brand colors from `GameSpec`, not
  the app's own UI.
  - `--font-sans` (Inter) for body text, `--font-display` (Space Grotesk) for
  headlines only — via the `font-display` Tailwind class.
- `shadow-card` / `shadow-elevated` are the only two elevation levels; no ad
  hoc box-shadows.

## What's implemented vs. reserved

Four templates are live end-to-end: `catch`, `guess_price`, `chain_pop`, and
`shooter` (see `lib/capabilities/*.json`, `lib/runtime/games/*.ts`).
`TemplateId` in `types.ts` also reserves `"match"` and `"stack"` — they
exist in the type system (and the capability-schema Zod validator)
precisely so more templates can be added later without touching that
shared contract at all. See `docs/ADDING_A_TEMPLATE.md`.
