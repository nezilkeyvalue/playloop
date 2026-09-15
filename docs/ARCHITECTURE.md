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

## 2. Generation pipeline (`lib/engine/index.ts` → `runGeneration()`)

One function, called by `app/api/generate/route.ts`, which persists
progress via `GenerationCallbacks.onProgress` (the DB `Job` record's
`stage`/`percent`/`message`, polled by `app/api/generate/[jobId]/route.ts`
and the `/build/auto/[jobId]` page). `runGeneration()` itself never touches
the DB — that's the integration seam between the pipeline and the
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

5. **`thinking`** — `brain.ts` (`runBrain`) calls Gemini (schema-validated
   response) with the eligible templates and a sample of assets, asking it
   to pick a template, write copy, and set reward tiers. If `GEMINI_API_KEY`
   is unset, the call errors, or it times out, `deterministicFallback()`
   runs instead — picks the matcher's top-scored template and uses
   hand-written copy templates. Both paths return the same `BrainResponse`
   shape, so nothing downstream needs to know which one ran.

6. **`composing`** — `compose.ts` merges `AssetInventory` + `MatchReport` +
   `BrainResponse` into the final `GameSpec` (roles, copy, rewards, tuning
   clamped to the capability's ranges, `meta.warnings`).

`runGeneration()` returns `{ inventory, match, spec }`; the API route
persists `spec` as a new `GameRecord` (draft) and the job's `gameId` points
to it.

## 3. Runtime (`lib/runtime/`)

`mount(spec, container, placement, options?) → { teardown }`
(`mount.ts`) is the entire public surface. It:

- Resolves `spec.template` to a `GameModule` factory via a small
  `REGISTRY` map (`catch` → `createCatchGame`, `guess_price` →
  `createGuessPriceGame`) and looks up the matching `GameCapability` for
  placement constraints and tuning ranges. An unregistered/unimplemented
  template (currently `match`, `stack`) degrades to a friendly
  "isn't ready yet" message rather than crashing.
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
`.../guessPrice.ts`) implements exactly this and nothing else — `mount.ts`
is the only thing that knows about DOM, input, or telemetry.

## 4. Capability definitions (`lib/capabilities/`)

Each template is **data**: a JSON file validated at import time by a Zod
schema in `index.ts` against the `GameCapability` shape (roles, per-role
requirements/preferences/transforms/fallback, placement constraints, tuning
ranges, scoring). `listCapabilities()` / `getCapability(id)` are the only
reads anything else in the codebase does — the matcher, the brain's
eligible-template list, `compose.ts`, and the editor's role-completeness UI
are all generic over whatever's registered here. Nothing needs to change in
any of those files to add a template; see `docs/ADDING_A_TEMPLATE.md`.

## 5. Data layer (`lib/db/`)

`isDevMode()` (`client.ts`) is `true` whenever `SUPABASE_URL` is unset — in
that case `queries.ts` reads/writes JSON files under `./dev-data/` instead
of Postgres, so the whole app runs with zero external accounts. Every
exported function in `queries.ts` branches on `isDevMode()` itself, so
callers (API routes) never need to know or care which backend is active.
`lib/db/schema.sql` is the real-Postgres schema for when `SUPABASE_URL` is
set. There is currently exactly one implicit account (`accountId: null`
everywhere) — no real auth yet (see `docs/ROADMAP.md`).

## 6. API surface (`app/api/`)

| Route | Purpose |
|---|---|
| `POST /api/generate`, `GET /api/generate/[jobId]` | kick off + poll auto-mode generation (`runGeneration`) |
| `GET/PATCH /api/games/[id]` | fetch/edit a `GameRecord`'s `GameSpec` (the editor's save path) |
| `POST /api/games` | create a game (manual mode) |
| `POST /api/games/[id]/publish` | draft → published |
| `GET /api/games/[id]/stats` | play/lead analytics for the stats page |
| `POST /api/plays/start`, `POST /api/plays/finish` | runtime telemetry (session begin/end, score, reward tier) |
| `POST /api/leads` | email capture from the reward screen |
| `POST /api/upload` | manual-mode asset upload → blob storage |

## 7. App routes (`app/`)

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

## 8. Design system

Tokens live in `app/globals.css` (`:root` + a `prefers-color-scheme: dark`
block, RGB triplets) and are exposed to Tailwind via
`tailwind.config.ts`'s `rgb(var(--x) / <alpha-value>)` pattern — this is
what makes `bg-card`, `text-muted`, etc. theme-aware for free. Two font
families: `--font-sans` (Inter, body) and `--font-display` (Space Grotesk,
headlines only, via the `font-display` class) — both loaded at build time
via `next/font/google` in `app/layout.tsx`. This is separate from
per-*game* brand fonts, which are arbitrary Google Fonts loaded at runtime
by `mount.ts` (see §3) since they come from `GameSpec.brand.fontFamily`,
not the app's own design system.
