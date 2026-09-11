# PlayLoop

Make your brand playable in 60 seconds. Paste a website URL, PlayLoop grabs
the logo, colours and products, picks a game that fits, and builds it. Or
upload assets and build manually. Preview, edit, copy one line of embed code.

Full product spec: see the two source documents this repo was built from
(`playloop-build-spec.md`, `playloop-capability-schema.md`) if attached to
this workspace; the shared contract they describe lives in
`lib/engine/types.ts`.

## Status

This is a scaffolded MVP build, generated in one working session against the
full build spec. Real, working logic where it matters for the demo path
(extraction ladder, sprite cutout, matcher, both game runtimes, embed loader,
builder flow); reduced-scope stubs elsewhere, called out below.

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
contract everything else is built against, and the build spec §3 for the
full intended repository structure.

## Try the extractor

```bash
npm run test:extract
```

Runs the source ladder (`lib/engine/extract`) against `scripts/sample-sites.json`
and reports a success rate — the spec calls this "the highest-value hour in
the whole build" before a live demo.
