# Splitting work without stepping on each other

This repo (see `docs/ARCHITECTURE.md`) was deliberately built as several
tracks around one shared contract (`lib/engine/types.ts`). That structure is
what makes parallel work — multiple people, multiple AI agents, or both at
once — safe. This doc is the practical guide: what's isolated, what's
shared, and how to avoid merge conflicts and integration surprises.

## The contract-first rule

`lib/engine/types.ts` is the one file everything else depends on. Changes to
it must be:

1. **Additive.** New optional fields, new union members — not renames or
   removals of anything a consumer already reads. `BrandKit.secondaryAccent`
   (added this session) is the pattern: optional, with a fallback everywhere
   it's used, so every existing `GameSpec` in the DB and every fixture kept
   working without migration.
2. **One PR, every consumer updated.** If you add a field the runtime should
   render, update the runtime in the same change — don't land a schema
   change and leave rendering as a follow-up TODO someone else has to
   remember.
3. **Discussed before written**, if the change is structural (a new
   top-level shape, a breaking rename) rather than additive. Everyone
   downstream is trusting this file to be stable.

If your task doesn't require touching `types.ts`, it almost certainly
doesn't need to — check `docs/ARCHITECTURE.md`'s table of what
produces/consumes each shape first.

## File ownership map

**Safe to parallelize — isolated, low conflict risk:**

| Area | Files |
|---|---|
| One game template | `lib/capabilities/<id>.json`, `lib/runtime/games/<id>.ts` (new files — see `docs/ADDING_A_TEMPLATE.md`) |
| One pipeline stage's internals | `lib/engine/extract/*.ts`, `sprites.ts`, `quality.ts`, `matcher.ts`, `brain.ts` (as long as you're not changing what they return) |
| One app page | anything under `app/(marketing)/`, `app/(app)/build/`, `app/(app)/games/[id]/stats/`, `app/(app)/games/[id]/embed/` |
| One API route | anything under `app/api/` (each route file is independent) |
| A new shared component | new files under `components/` |
| DB queries for a domain you're not touching elsewhere | `lib/db/queries.ts` — exports are independent functions; two people adding unrelated query functions to the same file rarely conflict in a way git can't merge |

**Shared, coordinate before large changes:**

| Area | Files | Why |
|---|---|---|
| The contract | `lib/engine/types.ts` | everything depends on it — see above |
| Template registration | `lib/capabilities/index.ts`, `lib/runtime/mount.ts`'s `REGISTRY` | every new template adds one line to each; two people adding templates same-day will both touch these two files, but the diffs are one-line-each and trivially mergeable |
| The editor | `app/(app)/games/[id]/page.tsx` | large single file (accordion sections for Branding/Images/Copy/Rewards + the sticky preview + all the helper components); two unrelated edits to different sections rarely conflict line-by-line, but skim the whole file before a big change so you know what's already there |
| Design tokens | `app/globals.css`, `tailwind.config.ts` | app-wide; changing a token's value changes every page that uses it — additive (new tokens) is safe, changing existing values needs a quick look at what currently uses them |
| Fixtures | `lib/runtime/fixtures/sampleGameSpec.ts` | shared by `/play/[slug]`, `GamePreviewModal`, and `ShowcaseSlideshow` — adding a new fixture is additive and safe; editing an existing one can silently change what those three surfaces show |

## Suggested ways to split a body of work

- **By template** (Track A in `docs/ROADMAP.md`) — the cleanest split.
  Each template is capability JSON + runtime module + fixture, almost
  entirely new files.
  - **By pipeline stage** (Track B) — extraction, sprite processing, quality
  gate, matching, and the AI layer are five files with narrow, typed
  interfaces between them (`AssetInventory` → `AssetInventory` →
  `MatchReport` → `BrainResponse`). Someone can rework `matcher.ts`'s
  scoring formula without anyone touching `extract/` needing to know.
- **By app surface** (Track C/E) — the editor, the marketing site, and the
  stats page don't share components beyond `Reveal`/`AnimatedNumber`/
  `Logomark`, so UI work on one rarely touches the others.
- **By infra concern** (Track D) — auth, Supabase rollout, blob storage,
  and rate limiting are each gated behind their own env-var-presence switch
  (`isDevMode()` and equivalents), so they can be built and tested against
  the dev-mode fallback without needing the real service provisioned yet.

## Before you open a PR / hand off work

```bash
npm run typecheck   # tsc --noEmit — strict, noUncheckedIndexedAccess is on
npm run lint
```

For anything touching the runtime or a page's visual output, don't rely on
typecheck alone — it verifies types compile, not that a button is
clickable or a layout doesn't overflow. Use the real-browser verification
workflow in `CLAUDE.md` (temporary Playwright install, real clicks/scrolls,
then clean up every scratch artifact and confirm `git diff package.json`
only shows what you intended).

## Commit hygiene

- Keep template additions, pipeline changes, and UI changes in separate
  commits/PRs even if you did them in one sitting — they review and revert
  independently that way.
- If you touch `lib/engine/types.ts`, say so explicitly in the PR
  description and list every file you updated to match, even ones that only
  needed a trivial change — that list is what makes it safe for someone
  else to trust the contract didn't silently drift under them.
