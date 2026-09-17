-- 20260917000004_fix_leads_upsert.sql
--
-- Fixes lead capture, which had never worked against real Postgres.
--
-- lib/db/queries.ts#recordLead upserts with `onConflict: "game_id,email"`.
-- The index it was inferring against was PARTIAL:
--
--   create unique index leads_game_email_idx on leads (game_id, email)
--     where email is not null;
--
-- Postgres will only infer a partial index for ON CONFLICT if the statement
-- repeats the same WHERE predicate, which supabase-js cannot express. So
-- every lead submission failed with:
--
--   42P10  there is no unique or exclusion constraint matching the
--          ON CONFLICT specification
--
-- i.e. a 500 from POST /api/leads. It went unnoticed because the dev-mode
-- JSON store in the same function hand-rolls the same de-duplication and
-- works fine; the bug only appears once SUPABASE_URL is set.
--
-- The `where email is not null` predicate was redundant anyway. A unique
-- index treats NULLs as DISTINCT by default (NULLS DISTINCT), so a plain
-- index on (game_id, email) still permits any number of phone-only leads
-- per game — while being inferrable by ON CONFLICT.

drop index if exists leads_game_email_idx;

create unique index if not exists leads_game_email_idx
  on leads (game_id, email);
