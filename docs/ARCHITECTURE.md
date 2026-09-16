# Architecture

How a URL becomes a playable, embeddable game — stage by stage, with the
file that owns each one. Read `CLAUDE.md` first for orientation; this is the
deeper reference for whoever is actually working in a given stage.

## 1. The shared contract

Everything below either produces, consumes, or renders a `GameSpec`
(`lib/engine/types.ts`). The four core shapes:

| Type | Produced by | Consumed by |
|---|---|---|
| `AssetInventory` | `lib/engine/extract/` | `sprites.ts`, `quality.ts`, `matcher.ts` |
| `GameCapability` | hand-written JSON in `lib/capabilities/` | `matcher.ts`, `brain.ts`, `compose.ts`, the editor, `mount.ts` |
| `MatchReport` | `matcher.ts` | `brain.ts`, `compose.ts` |
| `GameSpec` | `compose.ts` (auto) or the manual-build API route | DB, editor, `mount.ts`, embed |

`GameSpec` is the only one that crosses the generation/runtime boundary —
once it exists, the runtime (`lib/runtime/`) never touches `AssetInventory`,
`GameCapability`, or `MatchReport` again. This is why the runtime and the
pipeline can be developed almost completely independently.

## 2. Generation pipeline (`lib/engine/index.ts`)

Two functions, `runExtraction()` and `runComposition()`, split at a
deliberate pause: the pipeline scores every template against what was
actually found, then **stops and waits for the user to pick one** — it
never auto-selects a template on its own. Both are called by
`app/api/generate/route.ts` (phase 1) and
`app/api/generate/[jobId]/choose/route.ts` (phase 2), which persist
progress via `GenerationCallbacks.onProgress` (the DB `Job` record's
`stage`/`percent`/`message`, polled by `app/api/generate/[jobId]/route.ts`
and rendered by the `/build/auto/[jobId]` page). Neither function touches
the DB itself — that's the integration seam between the pipeline and the
builder-API track.

Stages, in order (`JobStage` in `types.ts`):

1. **`fetching` / `extracting`** — `lib/engine/extract/index.ts`
   (`extractFromUrl`) runs a ladder: Shopify `products.json` →
   `application/ld+json` → OpenGraph → raw DOM scraping
   (`shopify.ts`/`jsonld.ts`/`opengraph.ts`/`dom.ts`), plus a separate logo
   ladder (`extract/logo.ts`). All network access goes through
   `safeFetch.ts` — SSRF-safe (blocks private/link-local ranges), respects
   `robots.txt`, and uses an `undici.Agent` with a raised max header size
   because some real sites exceed Node's default. Output: `AssetInventory`
   (candidate assets + a brand guess: logo, palette, font stack).
   Manual mode skips this and builds an `AssetInventory` directly from
   already-uploaded URLs (`buildManualInventory` in `index.ts`).

   Every step past the root document fetch is wrapped in `tryStep()` (a
   step throws → treated as "found nothing", never crashes extraction) —
   the root fetch itself is now wrapped the same way too, so a site that
   refuses even that first request degrades to an empty `AssetInventory`
   (which the matcher correctly scores as zero eligible templates, routing
   the user to "no template fit — try manual mode") instead of throwing all
   the way up to a raw job error. `safeFetch.ts` also remembers, for 5
   minutes, any origin that just hard-failed (a timeout or connection
   error — never a clean non-2xx response) so that every other fetch to
   that same origin later in the same run — the Shopify probe, the sitemap
   probe, the robots.txt lookup itself — fails immediately instead of each
   independently re-discovering the same dead end. Confirmed live against
   uniqlo.com (whose WAF silently drops any request identifying itself as
   a bot): this took a single `extractFromUrl()` call from ~40s down to
   ~11s — see CLAUDE.md's hazards list for the full story. This is
   resilience against a site being unreachable, not a tool for evading a
   site's deliberate bot-blocking — this codebase does not spoof a browser
   identity to get past one.

2. **`downloading` / `processing`** — `sprites.ts` (`processSprites`)
   downloads each candidate (capped at `MAX_CANDIDATE_IMAGES`, with the
   detected logo's asset id force-included via the `alwaysInclude` option so
   it can't be sliced off), then per-image: flood-fill cutout
   (`cutout.ts`), trim/pad/resize, perceptual hash for dedup, dominant-color
   extraction (`palette.ts`), and the text-density heuristic (a Laplacian
   edge-detection convolution via `sharp`, flagging likely text/badge
   graphics). Produces `ProcessedAsset` per surviving candidate.

3. **`quality`** — `quality.ts` (`runQualityGate`) scores and filters
   assets against fixed thresholds (resolution, aspect ratio, coverage,
   text density, background uniformity). The logo's asset id is passed via
   `exemptFromGate` and skips every check, not just resolution — a wordmark
   logo legitimately fails checks tuned for square product photos.

4. **`matching`** — `matcher.ts` (`matchAssets`) is fully data-driven off
   `listCapabilities()` (every template's JSON): for each template, for
   each role (required roles first — `fallback: "none"` roles claim assets
   before optional ones get a turn), score and assign the best-fitting
   surviving assets, or fall back per the role's declared `fallback` kind.
   Produces a `MatchReport` with a score and eligibility per template. This
   file has **no template-specific logic** — it only reads capability JSON.
   `runExtraction()` returns here with `{ inventory, match, businessName,
   businessDescription, droppedCount }` — the API route stores all of it on
   the `Job` row and flips `stage` to `"choosing"`.

5. **`choosing`** (pause, not a pipeline step) — `app/api/generate/route.ts`
   stops here on purpose. The `/build/auto/[jobId]` page renders every
   `eligible` result from `job.match` as a card (name/summary from
   `getCapability()`, a fit badge from the score), and the user picks one.
   That POSTs to `app/api/generate/[jobId]/choose/route.ts`, which
   re-validates the choice against the job's own `match.results` (never
   trusts the client's template id blindly) and resumes the pipeline via
   `runComposition()` — this is also the only place a `GameRecord` /
   `after()` background task gets kicked off for phase 2, mirroring how
   phase 1 kicks off from the original POST.

6. **`thinking`** — `brain.ts` (`runBrain`) calls Gemini (schema-validated
   response) with a sample of assets, asking it to write copy and set
   reward tiers. It does **not** pick the template — `runComposition()`
   always passes `forcedTemplate: <the user's choice>`, which narrows
   `RunBrainInput`'s eligible list to exactly that one template before
   Gemini or the fallback ever sees it (`resolveEligible()` in `brain.ts`
   is the single place this narrowing happens, shared by the Gemini path,
   response validation, and the fallback, so none of the three can
   disagree about what's actually on the table). If `GEMINI_API_KEY` is
   unset, the call errors, or it times out, `deterministicFallback()` runs
   instead and uses hand-written copy templates. Both paths return the
   same `BrainResponse` shape, so nothing downstream needs to know which
   one ran.

7. **`composing`** — `compose.ts` merges `AssetInventory` + `MatchReport` +
   `BrainResponse` into the final `GameSpec` (roles, copy, rewards, tuning
   clamped to the capability's ranges, `meta.warnings`).

`runComposition()` returns `{ inventory, match, spec }`; the choose route
persists `spec` as a new `GameRecord` (draft) and the job's `gameId` points
to it — the exact same tail behavior the single-phase flow used to have,
just triggered by the user's choice instead of automatically.

## 3. Asset presentation and treatment — how an image should be framed, cropped, and colour-corrected

Every `ProcessedAsset` (`lib/engine/types.ts`) carries two optional fields:
`presentation: "isolated" | "photographic"`, and — only when
`"photographic"` — `backgroundColor` (a hex) and
`backgroundTreatment: "solid" | "blurFill"`. This exists because of a real,
user-reported aesthetic bug, found and fixed in two rounds:

1. `chain_pop`'s tile role originally required `isolatable: true` like
   `catch`/`guess_price`'s floating-sprite roles do, which meant most real
   product photography — anything shot in lifestyle context rather than on
   a plain studio background — got excluded outright. Relaxing that let
   more real photos in, but exposed the actual problem underneath: a
   photo's own real background rendered inside a chip filled with an
   unrelated brand colour reads as an amateur "sticker in a box."
2. The first fix filled the chip with the photo's own sampled
   `backgroundColor` (no more seam) but also cropped into the sprite to
   reduce visible backdrop margin — which, for photos where the subject
   already filled most of the frame, cut off real content (a model's head,
   a product's edge). **A renderer must never crop a `"photographic"`
   asset to make it fit** — always scale the *whole* image to fit (Canvas
   `drawImage` "contain" semantics: same aspect in, same aspect out, no
   skew, no cropping) and fill the leftover space around it instead.

**`backgroundTreatment` — what fills the leftover space:**
- `"solid"`: a flat fill of `backgroundColor` — right when the backdrop is
  already close to one flat colour (high corner uniformity, just not
  bright/white enough to have isolated cleanly, e.g. a light-grey or
  pastel studio background).
- `"blurFill"`: a blurred, zoomed-in copy of the *same* photo — right for a
  busy/contextual backdrop (a room, outdoors, a person in an environment)
  where a flat colour would look like an obvious patch instead of a
  natural extension of the photo. This is the same technique
  Spotify/Apple Music use to fill space around non-square album art.

**Where these are set (deterministic today):** `sprites.ts`, from the
cutout step's own result. `presentation` from `cutoutResult.isolatable`;
`backgroundColor` from `cutoutResult.dominant` (corner-sampled hex,
already computed by `cutout.ts` for its own uniformity check);
`backgroundTreatment` from the *same* corner-uniformity score
`cutout.ts` uses for isolation eligibility (`MIN_UNIFORMITY_FOR_ISOLATION`,
now exported so both files share one threshold) — high uniformity but not
isolatable (i.e. uniform but not white) → `"solid"`; low uniformity →
`"blurFill"`.

**Where they can be overridden (AI hook):** `brain.ts`'s Gemini call
already sends resized images for template/copy decisions (build spec §11);
the same request now also asks it to classify each attached image's
presentation *and*, for anything it calls `"photographic"`, which
background treatment fits best — both keyed by asset id (the prompt lists
`"1. <assetId>"` per attached image in send order, since not every
candidate necessarily survives the fetch/resize — see `buildImageParts`).
`validateBrainResponse` sanitizes both the same way, through one shared
`validateAssetEnumMap()` helper: only keys that are real, gate-passing
asset ids and values in the real enum survive; anything else is dropped,
never repaired. `compose.ts`'s `buildProcessedAssets` prefers the AI value
over the deterministic one per asset when present. On the deterministic
fallback (no key, timeout, error — see §2 stage 6), both maps are simply
absent and every asset keeps sprites.ts's heuristic values — same
call/fallback pattern as the rest of `brain.ts`, and equally unverified in
this sandbox (no `GEMINI_API_KEY` configured — see that file's own
warning).

**Who reads it:** currently only `chain_pop`'s runtime module
(`lib/runtime/games/chainPop.ts`). `catch`/`guess_price` still hard-require
`isolatable: true` on their floating-sprite roles, so by construction they
only ever receive `"isolated"` assets and don't need to branch on this —
this field only matters for a template that *frames* photos rather than
floating them. When drawing a `"photographic"` tile, `chainPop.ts`:
1. Fills the tile's chip with `backgroundColor` (both treatments start
   here — it's the base layer, and the only layer for `"solid"`).
2. For `"blurFill"`, draws a blurred, zoomed-in copy of the asset's own
   image over that fill — pre-rendered once per kind onto a small offscreen
   canvas (`buildKinds` → `createBlurredBackdrop`), not re-blurred every
   frame, since a live Canvas `filter: blur()` on every tile every frame
   would be wasted per-frame cost for a result that never changes.
3. Draws the full sprite on top, `drawImage`'d at a fixed square
   destination with **no source-rect cropping** — this is what guarantees
   nothing is ever cut off, regardless of treatment.
The outer ring stroke always stays in the kind's brand colour (not
`backgroundColor`), so tiles of the same kind are still visually
distinguishable from each other during play even as their backdrops vary.

A template with a similar "frame a photo" role in the future should read
these fields the same way rather than re-inventing a treatment — extend
the enums additively if a genuinely different treatment is ever needed.

**Smart zoom — `subjectBounds`, cropping toward the subject, never into
it.** Even with `backgroundTreatment` solved, a product photographed small
and centered against a huge plain backdrop (common — many brands shoot
with generous margin for their own site's layout needs) still renders
small and lost inside a tile: the *whole* image is correctly never
cropped, but "whole image" can itself be mostly empty padding. A second
optional `ProcessedAsset` field, `subjectBounds: { x, y, width, height }`
(normalized 0..1, relative to the sprite's own square canvas), names the
part of the frame that's real content — everything outside it is safe
padding. This *refines* the "never crop" rule from above rather than
weakening it: a renderer may crop toward `subjectBounds`, but never into
it. `{x:0,y:0,width:1,height:1}` (the whole frame) is always a safe,
inert value — a renderer or asset that ignores this field entirely
behaves exactly as before it existed.

- **Where it's set (deterministic today):** for free, in `sprites.ts`.
  `buildSprite()`'s existing trim step (`sharp().trim()`, already run for
  every asset to tighten an alpha cutout before the pad-to-square step)
  already computes the exact trimmed content rect — this just reads it
  back out as normalized fractions instead of discarding it. Only trusted
  for an `"isolated"` asset (a real alpha silhouette, not a guess); for a
  `"photographic"` asset there's no reliable way to segment subject from
  backdrop without real vision judgment, so it's left unset (full-frame
  fallback) rather than asserting a boundary sprites.ts doesn't actually
  know.
- **Where it can be overridden (AI hook):** `brain.ts`'s `imageSubjectBounds`
  — this is the field that matters most for a `"photographic"` asset,
  since that's exactly the case with no deterministic source at all.
  Validated by `parseSubjectBoundsValue`: a box that would claim more than
  the actual frame is clamped down to what's left, never trusted as-is.
- **Who reads it:** `chainPop.ts`'s `drawCell()` — computes a source rect
  from `subjectBounds` (falling back to the whole image when absent), then
  `containFit()`s that rect's own aspect ratio into the tile's inset box
  (a subject rect is usually *not* square even though every sprite's outer
  canvas is, so this step matters — a naive stretch would distort it) before
  the same never-crop-into-the-subject `drawImage` as before.

**Colour consistency — `colorAdjust`.** A site's product photos rarely
share one consistent exposure/colour grade (different photographers,
lighting, years) — a grid of otherwise well-framed tiles with visibly
inconsistent brightness still reads as scraped, not designed. A third
optional field, `colorAdjust: { brightness, contrast, saturation }`
(multipliers, 1 = no change), is meant to be applied as a cheap canvas
filter (`ctx.filter = "brightness(b) contrast(c) saturate(s)"`) at draw
time.

- **Where it's set:** nowhere deterministic — there is no heuristic here at
  all, deliberately. Guessing "correct" exposure from pixel statistics
  alone is as likely to make an image worse as better without real
  judgment, which is worse than doing nothing, so the only fallback is the
  neutral no-op (equivalently: the field is just absent).
- **Where it can be overridden (AI hook):** `brain.ts`'s `imageColorAdjust`
  — the *only* source of a real value, ever. The prompt asks Gemini to set
  it only for an image that's noticeably under/over-exposed relative to the
  rest of the set, framed as "a correction, not a re-edit"; each channel is
  clamped to `[0.5, 1.5]` by `parseColorAdjustValue` regardless of what the
  model returns.
- **Who reads it:** `chainPop.ts` — applied to the live foreground sprite
  draw (skipped entirely, not just set to a no-op filter string, when
  absent — avoids paying for a canvas filter graph on every frame for the
  common case where nothing needs correcting) and baked into the
  `blurFill` backdrop at its one-time pre-render (`createBlurredBackdrop`),
  so the corrected colour shows through the blurred decor layer too.

`imagePresentation`, `imageBackgroundTreatment`, `imageSubjectBounds`, and
`imageColorAdjust` all share one validation shape in `brain.ts`: a
per-asset-id map, keys restricted to ids that actually passed the quality
gate, values sanitized hard (`validateAssetEnumMap` for the two string
enums, `validateAssetObjectMap` + a `parse*Value` function for the two
structured ones) — never trusted as-is, same "non-negotiable" discipline
build spec §11 established for `copy`/`rewards`/`tuning`. A future
AI-assisted image field should follow the same shape: a per-asset-id map
on `BrainResponse`, a deterministic (even if trivially "absent") fallback
elsewhere, and a dedicated parse/validate function that drops rather than
repairs anything that doesn't hold up.

## 4. Runtime (`lib/runtime/`)

`mount(spec, container, placement, options?) → { teardown }`
(`mount.ts`) is the entire public surface. It:

- Resolves `spec.template` to a `GameModule` factory via a small
  `REGISTRY` map (`catch` → `createCatchGame`, `guess_price` →
  `createGuessPriceGame`, `chain_pop` → `createChainPopGame`) and looks up
  the matching `GameCapability` for placement constraints and tuning
  ranges. An unregistered/unimplemented template (currently `match`,
  `stack`) degrades to a friendly "isn't ready yet" message rather than
  crashing.
- Builds a DOM scaffold: a `<canvas>` (the game) and an `overlay` div
  (idle screen, reward screen, email capture) as **siblings**, both
  children of a `shell`. Input capture (`createInput`) is scoped to the
  canvas specifically so overlay button clicks aren't retargeted by
  `setPointerCapture()` — see `CLAUDE.md`'s hazards list.
- Sizes the stage per `placement` via `stage.ts`, loads every
  `spec.assets[].spriteUrl` as an `Image`, resolves `spec.roles` against
  loaded assets into `ResolvedRole`s (`{ assets, fallback? }`), and hands
  all of it to the game module through `RuntimeContext`
  (`gameModule.ts`) — the module never touches the DOM, telemetry, or role
  resolution directly.
- Drives the idle → play → reward lifecycle: `startPlay()` calls
  `factory().init(ctx)` then runs `loop.ts`'s fixed-step loop calling
  `update(dt)`/`render(ctx)`; on `ctx.complete()` it tears the loop down,
  resolves the reward tier (`reward.ts`), and reports telemetry
  (`telemetry.ts` → `/api/plays/*`, `/api/leads`). No client-side storage
  anywhere — all durable state is these server calls.
- Loads the brand's Google Font on demand (`ensureGoogleFontLoaded`),
  deduped per family per page load.

**`GameModule` contract** (`gameModule.ts`): `id`, `init(ctx)`,
`update(dt)`, `render(ctx)`, `teardown()`, `maxRealisticScore(tuning)` (a
server-side anti-cheat ceiling — see each module's own comments for how the
constant was derived from the capability's `scoring.maxRealistic`). Every
template's runtime module (`lib/runtime/games/catch.ts`,
`.../guessPrice.ts`, `.../chainPop.ts`) implements exactly this and
nothing else — `mount.ts`
is the only thing that knows about DOM, input, or telemetry.

## 5. Capability definitions (`lib/capabilities/`)

Each template is **data**: a JSON file validated at import time by a Zod
schema in `index.ts` against the `GameCapability` shape (roles, per-role
requirements/preferences/transforms/fallback, placement constraints, tuning
ranges, scoring). `listCapabilities()` / `getCapability(id)` are the only
reads anything else in the codebase does — the matcher, the brain's
eligible-template list, `compose.ts`, and the editor's role-completeness UI
are all generic over whatever's registered here. Nothing needs to change in
any of those files to add a template; see `docs/ADDING_A_TEMPLATE.md`.

## 6. Data layer (`lib/db/`)

`isDevMode()` (`client.ts`) is `true` whenever `SUPABASE_URL` is unset — in
that case `queries.ts` reads/writes JSON files under `./dev-data/` instead
of Postgres, so the whole app runs with zero external accounts. Every
exported function in `queries.ts` branches on `isDevMode()` itself, so
callers (API routes) never need to know or care which backend is active.
`lib/db/schema.sql` is the real-Postgres schema for when `SUPABASE_URL` is
set. There is currently exactly one implicit account (`accountId: null`
everywhere) — no real auth yet (see `docs/ROADMAP.md`).

## 7. API surface (`app/api/`)

| Route | Purpose |
|---|---|
| `POST /api/generate`, `GET /api/generate/[jobId]` | kick off auto-mode extraction + poll job progress (`runExtraction`) |
| `POST /api/generate/[jobId]/choose` | resume a paused job with the user's chosen template (`runComposition`) |
| `GET/PATCH /api/games/[id]` | fetch/edit a `GameRecord`'s `GameSpec` (the editor's save path) |
| `POST /api/games` | create a game (manual mode) |
| `POST /api/games/[id]/publish` | draft → published |
| `GET /api/games/[id]/stats` | play/lead analytics for the stats page |
| `POST /api/plays/start`, `POST /api/plays/finish` | runtime telemetry (session begin/end, score, reward tier) |
| `POST /api/leads` | email capture from the reward screen |
| `POST /api/upload` | manual-mode asset upload → blob storage |

## 8. App routes (`app/`)

- `(marketing)/` — public landing page (`page.tsx`), `gallery/`. No auth,
  no DB writes.
- `(app)/` — the builder: `/build` (mode choice), `/build/auto/[jobId]`
  (progress → redirect), `/build/manual` (upload wizard), `/games` (list),
  `/games/[id]` (the editor — accordion sections for Branding/Images/
  Copy/Rewards, sticky live preview via `GamePreviewModal`'s underlying
  `mount()` call), `/games/[id]/stats`, `/games/[id]/embed` (embed code
  generation).
- `play/[slug]/` — hosted standalone game page, served directly for the
  fixture slugs (`demo-catch`, `demo-guess-price`, etc.) with no DB hit,
  and via `getGameBySlug` for real games.
- `embed.js/` — the actual `<script>` third-party sites include; finds its
  host element, dynamically imports `mount.ts`, and mounts.
- `demo-storefront/` — a fake e-commerce page embedding the widget, for
  screenshots/demos.

## 9. Design system

Tokens live in `app/globals.css` (`:root` + a `prefers-color-scheme: dark`
block, RGB triplets) and are exposed to Tailwind via
`tailwind.config.ts`'s `rgb(var(--x) / <alpha-value>)` pattern — this is
what makes `bg-card`, `text-muted`, etc. theme-aware for free. Two font
families: `--font-sans` (Inter, body) and `--font-display` (Space Grotesk,
headlines only, via the `font-display` class) — both loaded at build time
via `next/font/google` in `app/layout.tsx`. This is separate from
per-*game* brand fonts, which are arbitrary Google Fonts loaded at runtime
by `mount.ts` (see §4) since they come from `GameSpec.brand.fontFamily`,
not the app's own design system.
