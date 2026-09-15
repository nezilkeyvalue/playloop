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
  games/                   one file per template (catch.ts, guessPrice.ts)
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
- **`undici`'s default max header size is small.** Some real-world sites
  return oversized response headers that blow past Node's default and throw
  before `safeFetch.ts` even gets a body. Both fetches there use a shared
  `undici.Agent({ maxHeaderSize: 1_048_576 })` dispatcher.
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

Two templates are live end-to-end: `catch` and `guess_price` (see
`lib/capabilities/*.json`, `lib/runtime/games/*.ts`). `TemplateId` in
`types.ts` also reserves `"match"` and `"stack"` — they exist in the type
system (and the capability-schema Zod validator) precisely so a third
template can be added later without touching that shared contract at all.
See `docs/ADDING_A_TEMPLATE.md`.
