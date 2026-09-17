-- Analytics lifecycle events (build spec §16). Inserts via API service role only.

create table if not exists game_analytics_events (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references games(id) on delete cascade,
  play_id     uuid references plays(id) on delete set null,
  event       text not null,
  detail      jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists game_analytics_events_game_created_idx
  on game_analytics_events (game_id, created_at desc);

create index if not exists game_analytics_events_game_event_idx
  on game_analytics_events (game_id, event);

alter table game_analytics_events enable row level security;

create policy game_analytics_events_via_game on game_analytics_events
  for select using (
    game_id in (select id from games where account_id = auth.uid())
  );
