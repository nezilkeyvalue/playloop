# PlayLoop

Make your brand playable in 60 seconds. Paste a website URL, PlayLoop grabs
the logo, colours and products, picks a game that fits, and builds it. Or
upload assets and build manually. Preview, edit, copy one line of embed code.

Full product spec: see the two source documents this repo was built from
(`playloop-build-spec.md`, `playloop-capability-schema.md`) if attached to
this workspace; the shared contract they describe lives in
`lib/engine/types.ts`.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — reference for AI agents (or anyone) working in
  this repo: repo map, conventions, hard-won gotchas
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the generation
  pipeline and runtime actually work, stage by stage
- [`docs/ADDING_A_TEMPLATE.md`](docs/ADDING_A_TEMPLATE.md) — recipe for
  adding a new game template
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — open work, grouped into
  parallelizable tracks
- [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) — splitting work across
  people/agents without merge conflicts

## Status

Originally scaffolded in one session by three concurrent tracks built
against the shared `lib/engine/types.ts` contract, then run, debugged, and
iterated on for real in later sessions: `npm install`/`next build`/`next dev`
all work, real bugs found via actual browser testing have been fixed (see
`CLAUDE.md`'s hazards list — pointer-capture click retargeting, the
sticky-preview/scroll interaction, the logo-dropped-by-candidate-slicing
bug, and others), and the builder UI/editor/marketing site have been through
several rounds of real design polish. Three game templates (`catch`,
`guess_price`, `chain_pop`) are fully implemented end-to-end; `match`/`stack`
are reserved in the type system for future templates (see
`docs/ADDING_A_TEMPLATE.md`).

**Real, working logic:**
- Extraction ladder (Shopify products.json → JSON-LD → OG → DOM), SSRF-safe
  fetch with robots.txt respect, logo ladder
- Sprite pipeline: flood-fill cutout, trim/pad/resize, hand-rolled aHash
  perceptual dedup, palette extraction with WCAG contrast
- Quality gate + deterministic matcher (role scoring, transform quality
  deltas) exactly per the capability schema formulas
- Gemini AI layer with response schema + validation, and a genuine fallback
  path (matcher-ranked template + templated copy) that runs identically
  whether `GEMINI_API_KEY` is unset or the real call times out
- Both game runtimes (Catch, Guess the Price) on vanilla Canvas 2D, tuned to
  the capability JSON's ranges, with the embed loader, hosted `/play/:slug`
  page, and a mock storefront (`/demo-storefront`) that all work with zero
  setup via two hand-written fixture specs (`demo-catch`, `demo-guess-price`)
- Full builder flow (URL input → progress polling → preview/editor → publish
  → embed code), all API routes, and a dev-mode database (JSON files under
  `./dev-data/`) that needs no Supabase account to run

**Explicit stubs / deferred, called out in code comments:**
- Blob storage always uses local disk (`./dev-data/blob`) — real Vercel Blob
  wiring is a follow-up once this runs somewhere with registry access
  (`lib/storage.ts`)
- No real auth — every request acts as a single implicit dev account
  (`accountId: null` throughout `lib/db/queries.ts`), per the spec's own
  MVP scope ("magic link or a stub is fine")
- Reward codes are cosmetic placeholders, not real redeemable coupons
  (that's Horizon 2 — coupon platform APIs)
- Text-density detection (burned-in "50% OFF" badges) is a heuristic
  approximation, not OCR
- `scripts/test-extract.ts` / `sample-sites.json` are written but unrun —
  the spec calls running this "the highest-value hour before a demo," do it
  first once `npm install` works

## About the npm registry block

This only affects the Claude sandbox this was built in — it has nothing to
do with your own machine or npm account. If your organization's Claude
network settings also block `registry.npmjs.org` and you want Claude to run
`npm install`/`next build`/`next dev` directly in a future session, an org
Owner can allow that host in Admin settings → Capabilities. Otherwise, just
run the commands below wherever you normally develop.

## Running locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

No external accounts are required to run it. Leave `SUPABASE_URL` unset and
the db layer (`lib/db/client.ts`) falls back to an in-memory + on-disk
(`./dev-data`) store. Leave `GEMINI_API_KEY` unset and the AI layer
(`lib/engine/brain.ts`) falls back to matcher-ranked template choice with
templated copy — same behavior the spec describes for a Gemini timeout, so
the "degraded" and "no key configured" paths are one code path.

To use real infrastructure, fill in `.env.local`:
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — run `lib/db/schema.sql`
  against a fresh Supabase project first.
- `BLOB_READ_WRITE_TOKEN` — a Vercel Blob token, for sprite storage.
- `GEMINI_API_KEY` — for real copy generation and template selection.

## Repository map

See `lib/engine/types.ts` for the GameSpec/AssetInventory/MatchReport
contract everything else is built against, and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full repository
structure and how each part fits together.

## Try the extractor

```bash
npm run test:extract
```

Runs the source ladder (`lib/engine/extract`) against `scripts/sample-sites.json`
and reports a success rate — the spec calls this "the highest-value hour in
the whole build" before a live demo.
