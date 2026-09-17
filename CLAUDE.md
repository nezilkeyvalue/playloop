# CLAUDE.md

Reference for Claude Code (or any AI agent) working in this repo. Read this
first. For depth beyond what's here, see `docs/`:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the pipeline and runtime actually work, file by file
- [`docs/ADDING_A_TEMPLATE.md`](docs/ADDING_A_TEMPLATE.md) — step-by-step recipe for a new game template
- [`docs/COUPONS.md`](docs/COUPONS.md) — how a code gets from a spreadsheet to a player's clipboard, step by step
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

lib/coupons/           Coupon pools (per reward tier)
  codes.ts               crypto-random generation + canonicalisation/de-dup of a batch
  parse.ts               CSV/TSV (no dep) and XLSX (exceljs) -> raw code strings

lib/runtime/            Client-side game player
  mount.ts                mount(spec, container, placement) → { teardown } — the runtime entry point
  gameModule.ts            GameModule contract every template implements
  games/                   one file per template (catch.ts, guessPrice.ts,
                           chainPop.ts, shooter.ts, sweetSpot.ts)
    spriteRender.ts          shared subject-aware draw helpers + the celebrate primitive — see hazards list
  stage.ts, loop.ts, input.ts, reward.ts, telemetry.ts   shared runtime services
  fixtures/sampleGameSpec.ts   hand-written GameSpecs for offline dev/demo (no pipeline needed)

lib/db/                 Dev-mode JSON-file store, or Supabase when SUPABASE_URL is set
lib/auth/               Google SSO via Supabase Auth
  config.ts               isAuthEnabled() — the one switch; safe to import from client code
  server.ts               getSessionUser/requireAccount/ownsRecord — the ONLY request -> accountId path
  browser.ts              cookie-backed browser client (auth only, never data)
lib/storage.ts          Blob storage (Supabase Storage, or local disk when unconfigured)
lib/rateLimit.ts, lib/slug.ts

supabase/               CLI project: config.toml (incl. [auth.external.google]) + migrations/
scripts/migrate-dev-data.ts   one-shot ./dev-data -> Supabase (rows + blobs + URL rewrite)

app/(marketing)/        Public landing page, gallery
app/(app)/               Builder UI: /build, /games, /games/[id] (the editor), /games/[id]/stats, /games/[id]/embed
app/auth/                callback (OAuth code -> session cookies) and signout
app/api/                 generate, games, plays, leads, upload — the HTTP surface over lib/engine + lib/db
app/play/[slug]/         Hosted standalone game page
app/embed.js/            The embed script third-party sites load
app/demo-storefront/     Mock storefront showing the embed in context

components/              Shared UI (Logomark, Reveal, AnimatedNumber, EditorIcons, GamePreviewModal, HeroDoodle, ShowcaseSlideshow)
  AuthProvider.tsx         session context + the shared login modal + requireLogin()
  AuthButton.tsx           header control: "Log in" / avatar menu
  AuthGate.tsx             per-page gate: sign-in card instead of a doomed fetch
  CouponManager.tsx        per-tier coupon admin (terms, generate, upload, stock)
```

## Commands

```bash
npm run dev          # start dev server
npm run typecheck    # tsc --noEmit — run this after every change, it's fast and strict
npm run lint
npm run build
npm run test:extract # runs the extraction ladder against scripts/sample-sites.json
npm run migrate:dev-data -- --owner you@example.com   # ./dev-data -> Supabase (add --dry-run first)
```

Supabase, when you're changing it:

```bash
supabase link --project-ref <ref>   # once, per checkout
supabase db push                    # apply supabase/migrations/*
supabase config push                # apply supabase/config.toml (auth URLs + Google provider)
```

Still no external accounts needed to run it. Leave `SUPABASE_URL` unset →
JSON-file DB under `./dev-data/` and local-disk blobs. Leave the two
`NEXT_PUBLIC_SUPABASE_*` vars unset → no login wall, no login button, one
implicit account (see the auth section below). Leave `GEMINI_API_KEY` unset →
deterministic fallback in `brain.ts` (same code path as a real Gemini timeout,
so "no key" and "degraded" are never two different behaviors to maintain).

## Auth and persistence

Sign-in is Google SSO through Supabase Auth. `accounts.id` **is**
`auth.users.id` — the same uuid — which is what makes every
`auth.uid() = account_id` RLS policy in the schema correct rather than
aspirational.

Three rules:

1. **`lib/auth/server.ts#requireAccount()` is the only way a route learns who
   is calling.** It returns either `{ accountId }` or a ready-made 401. Don't
   read cookies or call `getUser()` anywhere else, and never authorize off
   `getSession()` — that returns whatever the cookie claims without verifying
   it.
2. **Reading a row by id is not authorization.** Every per-game route pairs
   `getGameById()` with `ownsRecord()`, and a row owned by someone else
   returns **404, not 403** — a 403 confirms the id exists, which leaks which
   game uuids are real.
3. **Auth is optional and must stay optional.** With the two
   `NEXT_PUBLIC_SUPABASE_*` vars unset, `isAuthEnabled()` is false,
   `requireAccount()` hands back `accountId: null` (the single implicit dev
   account this codebase used everywhere before SSO existed), `AuthButton`
   renders nothing and `AuthGate` renders its children. That path is what
   keeps the zero-external-accounts local run above true — don't add a check
   that assumes a user exists.

`AuthProvider` is mounted in `app/(marketing)/layout.tsx` and
`app/(app)/layout.tsx`, **not** in the root layout, so `app/play/[slug]` and
the embed don't pull the Supabase auth client into the bundle a third-party
storefront loads. Keep it that way.

## Coupons

Each reward tier can own a pool of single-use codes. The split of
responsibility is the thing to hold on to:

| | Where it lives | Who sees it |
|---|---|---|
| Terms, expiry, offer link (`CouponTerms`) | inside `GameSpec.rewards[i].coupon` | shipped to every browser |
| The codes themselves | the `coupons` table only | one player gets exactly one |

**Never put codes in `GameSpec`.** The spec is delivered wholesale to every
storefront running the embed, so a pool in the spec is a pool published to
anyone who opens devtools.

A code is consumed when the player presses **Copy my code**, not when the game
ends — players who close the tab must not burn coupons. `POST
/api/plays/claim-coupon` is idempotent: the same play always gets the same
code back and only the first call consumes anything, which is what makes the
button safe to double-click and the retry in `telemetry.ts` safe to use.

Admin side is `/api/games/:id/coupons` (owner-only): generate from the UI,
upload .csv/.xlsx, paste a list, or clear unclaimed. Claimed rows are never
deleted — they are the record of which code went to which play.

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
- **A role's `fallback: "logo"` can hand your template the brand's own
  logo asset — that still counts as "a real loaded image," so the
  `recordEngagement`/`Celebration` guard above must exclude it explicitly,
  not just check `asset?.image`.** Confirmed live: `sweet_spot.json`'s
  `prize` role declares `"fallback": "logo"` and no `subjectTypeIn`
  restriction at all (unlike `catch`'s `collectible` or `guess_price`'s
  `hero`), so when too few real prize assets exist the matcher can hand
  `prize` the logo directly — `sweetSpot.ts` then "won" and celebrated the
  logo as if it were a product, and it showed up in the reward screen's
  recap gallery next to real products. Fixed two ways: `spriteRender.ts`'s
  `isBrandLogoUrl(imageSrc, logoUrl)` guards `sweetSpot.ts`'s own
  celebration call site, and `mount.ts`'s `recordEngagement()` checks the
  same thing centrally (the one function every template already calls
  through) so any future template with a similar `fallback: "logo"` role
  can't reintroduce this by forgetting the per-template guard.
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
- **Supabase Storage builds the `Cache-Control` header for you.** The
  `cacheControl` upload option is *not* a full header value — Storage emits
  `public, max-age=<your string>`. Passing
  `"public, max-age=31536000, immutable"` yields the malformed
  `public, max-age=public, max-age=31536000, immutable`, which was shipped
  once and caught only by reading the response headers off a live object.
  `lib/storage.ts` passes `"31536000, immutable"`. Note also that the public
  URL is CDN-fronted with that same long max-age, so re-uploading over an
  object will *not* show you the new headers — test with a fresh object name.
- **Migrating a game row without rewriting its sprite URLs looks like it
  worked.** Sprite URLs live at arbitrary depths inside the `spec` jsonb
  blob, as `/dev-blob/<hash>.<ext>` paths that only ever resolved on one
  laptop. `scripts/migrate-dev-data.ts` uploads the blobs first and rewrites
  every occurrence in `spec`/`inventory`/`match` before inserting a single
  row, because a row-only copy passes every check you'd think to run and then
  renders a game with no images. The dev store also wrote `.bin` for any
  content type it had no extension for, so that script sniffs magic bytes
  rather than trusting the file name — the `sprites` bucket has a MIME
  allowlist and rejects `application/octet-stream`.
- **Never re-derive a reward tier from `plays.score`.** `finishPlay` keeps the
  RAW reported score for audit even when it judges the play forged (score
  above the template's realistic ceiling, or elapsed time under the floor) —
  it signals the rejection by writing `tier_index = null`, not by zeroing
  `score`. The coupon claim originally resolved the tier from `play.score`
  and therefore paid out exactly the plays `finishPlay` had just rejected;
  a test where `finishPlay` returned `tier: null` and the claim still handed
  over a code is what caught it. Read `play.tierIndex`; treat null as
  "earned nothing".
- **`plays.tier_index` is an index into the SORTED rewards, coupon pools are
  keyed by the ORIGINAL array order.** These are different numbers as soon as
  a merchant reorders tiers in the editor, and mixing them pays out the wrong
  tier silently. Convert with `originalTierIndexFromSortedIndex()` in
  `specRules.ts`. The stored sorted-index semantics are deliberately left
  alone — changing them would rewrite the meaning of historical rows the
  stats dashboard already aggregates.
- **Claiming a coupon cannot be a read-then-write.** Between "find the oldest
  unclaimed row" and "mark it mine", a concurrent player reads the same row
  and both walk away with the same code. The claim is the `claim_coupon()`
  SQL function using `FOR UPDATE SKIP LOCKED`; verified with 8 simultaneous
  claims against a 5-code pool returning 5 distinct codes and 3 "exhausted".
  Don't move that logic into TypeScript.
- **`finishPlay` must never invent a reward code.** It used to do
  `tier.code ?? generateRewardCode()`, minting a random 8-character string
  per play. That code exists nowhere in the merchant's store, so it fails at
  checkout — and because the reward screen seeds its coupon block from this
  value, a game with a real pool displayed the fake code instead of claiming
  a real one. It now returns only the legacy static `tier.code`, or nothing.
- **`exceljs` is CommonJS.** `await import("exceljs")` yields a namespace
  whose real exports sit under `.default`; reaching for `.Workbook` directly
  throws "ExcelJS.Workbook is not a constructor". Its `uuid` advisory is
  cleared by the `overrides` block in `package.json`, not by a version bump —
  exceljs only uses uuid when WRITING workbooks and we only read.
- **A coupon CSV's first column is often the wrong one.** Real merchant
  exports are wide ("Type", "Discount code", "Value", "Times used"), so
  `parse.ts` finds the column by header name and only falls back to column 0
  when no header is recognised. The import receipt echoes which column was
  read, because picking the wrong one is the failure nobody notices.
- **`spec.durationSeconds` is not what the runtime plays.** `mount.ts` uses
  `spec.tuning.durationSec ?? spec.durationSeconds` and then CLAMPS to the
  template's `capability.tuning.durationSec` range — for `catch` that floor
  is 20s, so a fixture asking for 5 actually runs 20. Cost a confusing
  "reward screen never appears" while testing.
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

Five templates are live end-to-end: `catch`, `guess_price`, `chain_pop`,
`shooter`, and `sweet_spot` (see `lib/capabilities/*.json`,
`lib/runtime/games/*.ts`). `TemplateId` in `types.ts` also reserves
`"match"` and `"stack"` — they exist in the type system (and the
capability-schema Zod validator) precisely so more templates can be added
later without touching that shared contract at all. See
`docs/ADDING_A_TEMPLATE.md`.

**`sweet_spot` is the eligibility floor.** It is the only template with no
`fallback: "none"` role, so it stays eligible on sites where extraction
yields almost nothing — verified live against deathwishcoffee.com, whose
two surviving assets leave `catch` (needs 4 isolatable collectibles) and
`guess_price` (needs a priced hero) both ineligible. Don't add a
hard-required role to it; that floor is the whole reason it exists.
