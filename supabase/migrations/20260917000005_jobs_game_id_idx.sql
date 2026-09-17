-- Supports getJobByGameId() (lib/db/queries.ts) — the template-switch route
-- looks up a game's originating job by game_id, ordered by created_at, and
-- jobs had no index on that column at all (only (account_id, created_at)).
-- Partial: most jobs are still mid-pipeline or manual-mode with game_id
-- null, so indexing only the rows this lookup can ever match keeps it small.
create index if not exists jobs_game_created_idx
  on jobs (game_id, created_at desc)
  where game_id is not null;
