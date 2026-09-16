# Roadmap

Open work, grouped into tracks that can move in parallel because each one
lives mostly behind its own boundary in `lib/engine/types.ts` (see
`docs/CONTRIBUTING.md` for exactly which files each track touches). Not a
committed schedule — a map of what's next and who'd naturally pick it up.

## Track A — New game templates

`TemplateId` reserves `match` and `stack`; neither has a capability JSON or
runtime module yet. Follow `docs/ADDING_A_TEMPLATE.md`.

`sweet_spot` (tap to stop a sweeping marker in a shrinking zone) shipped and
covers the thin-extraction case this track kept hitting: it declares no
`fallback: "none"` role, so it stays eligible when a site yields almost no
usable images. The spin-the-wheel idea below is now largely redundant with
it — both were aimed at the same "few usable product photos" gap.

- **`match`** — pairs-matching/memory game. Likely roles: `card` (needs an
  even, larger pool than `catch`'s collectibles — probably `count.ideal`
  around 6-8 *pairs*), maybe `stageBackground`. Good fit for sites with
  many similar-shaped product photos.
- **`stack`** — a stacking/timing game (drop items to build a tower without
  toppling). Roles likely: `block` (needs consistent aspect ratio more than
  `catch`'s collectibles do — this is where `prefers.uniformScale` earns
  its keep), `stageBackground`.
- Beyond those two reserved ids: a spin-the-wheel reward game (almost no
  asset requirements — mostly a brand-color/logo showcase, good fallback
  for sites with few usable product photos), and a trivia/quiz format (pairs
  well with sites that have rich JSON-LD product descriptions already
  extracted).
- Each template is close to fully isolated work — one person/session per
  template, no coordination needed beyond the two-line registrations in
  `capabilities/index.ts` and `mount.ts`.

## Track B — Pipeline & extraction quality

- **Text-density detection is a heuristic, not OCR** (`sprites.ts`'s
  Laplacian-convolution edge count). It'll misjudge busy product photography
  as "text-like" sometimes. A real OCR pass (even a lightweight on-device
  one) would let `maxTextDensity` actually mean "contains readable text."
- **Extraction ladder coverage** — `lib/engine/extract/` currently covers
  Shopify `products.json`, JSON-LD, OpenGraph, and raw DOM. Missing:
  WooCommerce/BigCommerce structured endpoints, sites that lazy-load
  products via client-side JS (would need a headless-browser fetch path,
  a real cost/complexity tradeoff to weigh against `safeFetch.ts`'s current
  plain-HTTP simplicity).
- **`scripts/test-extract.ts` + `scripts/sample-sites.json`** — the spec
  calls running this against a real, diverse site list "the highest-value
  hour before a demo." Worth running regularly (`npm run test:extract`) as
  the extraction ladder changes, and growing the sample set.
- **Brand palette refinement** (`refineBrandPalette` in `lib/engine/index.ts`)
  is a frequency tally, not real clustering — a proper k-means-on-Lab-space
  pass would produce more perceptually distinct palettes.
- **`brain.ts` prompt quality** — the Gemini prompt and response schema are
  functional but not deeply tuned; there's room to improve template choice
  and copy quality with better few-shot examples per template, especially
  once Track A adds more templates competing for the same eligible-list slot.

## Track C — Editor & builder UX

- **Template picker in the editor** — right now `spec.template` is decided
  once at generation time; there's no UI path to re-run the matcher against
  a different template for an existing game without starting over.
- **Role reassignment drag-and-drop** — `RoleImagesEditor` in
  `app/(app)/games/[id]/page.tsx` already does per-role image assignment via
  buttons; a drag-and-drop reorder/reassign interaction would be a pure UI
  layer on top of the same `spec.roles` mutation the buttons already call.
- **Undo/redo on the editor's save path** — currently every field change
  PATCHes immediately; no history.
- **More brand controls** — `BrandKit.secondaryAccent` was added this
  session but nothing in the editor exposes tertiary/neutral tones,
  gradients, or per-role color overrides.
- **Live multi-user editing** — out of scope until real auth exists
  (Track D), but worth designing the `PATCH /api/games/[id]` contract with
  optimistic-concurrency in mind now (e.g. an `updatedAt` check) so it's not
  a breaking change later.

## Track D — Infra & platform

- **Real auth.** Every request currently acts as one implicit dev account
  (`accountId: null` throughout `lib/db/queries.ts`) — see that file's own
  comments. Blocks: multi-tenant game lists, per-account rate limiting,
  billing.
- **Real Supabase rollout.** `lib/db/schema.sql` exists; `isDevMode()`
  (`lib/db/client.ts`) is the whole switch. Needs: running the schema
  against a real project, migration story, RLS review (the doc comment in
  `client.ts` notes API routes are currently the trust boundary, not RLS).
- **Real blob storage.** `lib/storage.ts` writes to local disk under
  `./dev-data/blob` — doesn't work on Vercel's ephemeral filesystem. Needs
  real Vercel Blob (or S3-compatible) wiring, gated the same
  env-var-presence way as Supabase.
- **Real coupon codes.** `RewardTier.code` is currently a cosmetic
  placeholder string, not a redeemable code from any commerce platform —
  needs a real integration (Shopify discount API, etc.) per template's
  `rewards`.
- **Rate limiting hardening.** `lib/rateLimit.ts` exists; worth an audit
  once real auth adds per-account identity to key off of instead of IP.
- **Analytics depth.** `getGameStats` (`lib/db/queries.ts`) and the stats
  page currently report aggregate counts; funnel breakdowns (impression →
  start → complete → reward → lead, by referrer/device) are a natural next
  step given `AnalyticsEvent` already models each stage.

## Track E — Design & marketing site

- The homepage now has an interactive hero (`HeroDoodle`) and a live
  multi-brand slideshow (`ShowcaseSlideshow`) instead of a single static
  demo. Natural next steps: a dedicated `/templates` or `/examples` gallery
  page reusing the same fixture `GameSpec`s at full size, and swapping the
  slideshow's hardcoded fixture list for something that reads from actual
  published games once there's a public gallery worth showing off.
- Dark mode tokens exist (`app/globals.css`) but there's no visible toggle
  yet — currently follows system preference only.
