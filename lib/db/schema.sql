-- lib/db/schema.sql
-- PlayLoop data model. Build spec §4.
--
-- NOT the source of truth any more. This file is the initial schema, copied
-- verbatim into supabase/migrations/20260917000001_init.sql; a second
-- migration beside it (20260917000002_auth_and_storage.sql) wires `accounts`
-- to auth.users, adds the sign-in trigger, and provisions the `sprites`
-- Storage bucket. Apply the whole thing with:
--
--   supabase link --project-ref <ref>
--   supabase db push
--
-- Change the schema by ADDING a migration, never by editing this file — the
-- migration history is what every environment replays.
--
-- Row Level Security on every table: tenant isolation is a GDPR obligation
-- here, not a nicety — PlayLoop is a data processor for every client whose
-- rows live in these tables.

create extension if not exists pgcrypto;

-- Tenants --------------------------------------------------------------
create table if not exists accounts (
  id          uuid primary key default gen_random_uuid(),
  email       text unique not null,
  plan        text not null default 'free',   -- free | campaign | growth | agency
  created_at  timestamptz not null default now()
);

-- Generation jobs --------------------------------------------------------
create table if not exists jobs (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid references accounts(id) on delete cascade,
  mode        text not null,                  -- auto | manual
  source_url  text,
  stage       text not null default 'queued',
  percent     int  not null default 0,
  message     text,
  inventory   jsonb,                          -- AssetInventory
  match       jsonb,                          -- MatchReport
  spec        jsonb,                          -- GameSpec, once composed
  game_id     uuid,
  business_name        text,                  -- carried across the "choosing" pause into composition
  business_description text,
  dropped_count         int,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists jobs_account_created_idx on jobs (account_id, created_at desc);

-- Games --------------------------------------------------------------------
create table if not exists games (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid references accounts(id) on delete cascade,
  slug          text unique,                  -- null until published
  name          text not null,
  spec          jsonb not null,               -- GameSpec
  placement     text not null default 'section',
  status        text not null default 'draft',-- draft | published | archived
  allowed_hosts text[] default '{}',          -- domain allowlist for the embed
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists games_account_updated_idx on games (account_id, updated_at desc);
create unique index if not exists games_slug_idx on games (slug) where slug is not null;

-- Plays --------------------------------------------------------------------
create table if not exists plays (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid references games(id) on delete cascade,
  session      text not null,                 -- server-minted token
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  score        int,
  tier_index   int,
  replay_of    uuid references plays(id),
  referrer     text,
  device       text,                          -- mobile | desktop
  country      text
);
create index if not exists plays_game_started_idx on plays (game_id, started_at desc);

-- Leads --------------------------------------------------------------------
create table if not exists leads (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid references games(id) on delete cascade,
  play_id     uuid references plays(id),
  email       text,
  phone       text,
  consent     boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index if not exists leads_game_email_idx on leads (game_id, email) where email is not null;

-- Row Level Security ---------------------------------------------------------
alter table accounts enable row level security;
alter table jobs enable row level security;
alter table games enable row level security;
alter table plays enable row level security;
alter table leads enable row level security;

-- Server-side access uses the service role key (bypasses RLS by design — the
-- Next.js API routes are the trust boundary, they authorize per-account
-- before touching these tables). These policies protect against any future
-- direct-from-browser (anon key) access.
create policy accounts_self on accounts
  for select using (auth.uid() = id);

create policy jobs_owner on jobs
  for all using (account_id = auth.uid());

create policy games_owner on games
  for all using (account_id = auth.uid());

-- Plays and leads belong to games; ownership is checked via join since the
-- rows themselves carry no account_id.
create policy plays_via_game on plays
  for all using (
    game_id in (select id from games where account_id = auth.uid())
  );

create policy leads_via_game on leads
  for all using (
    game_id in (select id from games where account_id = auth.uid())
  );
