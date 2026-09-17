-- 20260917000003_coupons.sql
--
-- Per-reward-tier coupon pools. Replaces the placeholder that
-- lib/db/queries.ts#finishPlay used to lean on (`tier.code ?? a random
-- string`), which handed players codes that existed nowhere in the
-- merchant's store.
--
-- A coupon is a CONSUMABLE: exactly one player may ever receive a given code.
-- That is the whole difficulty here, and it is why claiming is a database
-- function rather than a read-then-write from the API route — see claim_coupon
-- at the bottom.

create table if not exists coupons (
  id                uuid primary key default gen_random_uuid(),
  game_id           uuid not null references games(id) on delete cascade,
  -- Index into the game's ORIGINAL GameSpec.rewards array, not the sorted
  -- order the reward resolvers use. plays.tier_index is written from the
  -- SORTED order by finishPlay, so anything joining the two must map between
  -- them; lib/db/queries.ts#claimCouponForPlay is the only place that does.
  tier_index        int  not null check (tier_index >= 0),
  code              text not null check (length(btrim(code)) > 0),
  claimed_at        timestamptz,
  claimed_by_play_id uuid references plays(id) on delete set null,
  created_at        timestamptz not null default now()
);

-- A code must be unique within a game. Uploading the same CSV twice is a
-- realistic mistake and would otherwise double-issue every code in it.
-- Scoped per game, not globally: two unrelated merchants may legitimately
-- both use "WELCOME10".
create unique index if not exists coupons_game_code_idx on coupons (game_id, code);

-- The hot path: "give me one unclaimed coupon for this game+tier". Partial,
-- so it stays small as the claimed rows pile up.
create index if not exists coupons_unclaimed_idx
  on coupons (game_id, tier_index, created_at)
  where claimed_at is null;

-- IDEMPOTENCY, enforced by the database rather than trusted to the caller.
-- One play may hold at most one coupon per tier, so a double-clicked "Copy
-- code" cannot burn two coupons even if two requests race past the
-- application-level check in claim_coupon below.
create unique index if not exists coupons_one_per_play_idx
  on coupons (game_id, tier_index, claimed_by_play_id)
  where claimed_by_play_id is not null;

create index if not exists coupons_claimed_by_play_idx
  on coupons (claimed_by_play_id) where claimed_by_play_id is not null;

-- Row Level Security -------------------------------------------------------
-- Same posture as every other table: the service role (used by the API
-- routes) bypasses these, and they exist to make any future direct anon-key
-- access safe. Note there is deliberately NO player-facing select policy —
-- a player must never be able to read the pool, only receive one code from
-- claim_coupon().
alter table coupons enable row level security;

drop policy if exists coupons_owner on coupons;
create policy coupons_owner on coupons
  for all using (
    game_id in (select id from games where account_id = auth.uid())
  );

-- Atomic claim --------------------------------------------------------------
--
-- Hands out exactly one code, or NULL when the pool is empty.
--
-- Why a function and not a SELECT-then-UPDATE in TypeScript: between reading
-- "the oldest unclaimed coupon" and writing "it's mine", another concurrent
-- player can read the same row. Two players then walk away with the same
-- code. `FOR UPDATE SKIP LOCKED` is the fix — each concurrent caller locks a
-- different row and nobody waits.
create or replace function claim_coupon(
  p_game_id    uuid,
  p_tier_index int,
  p_play_id    uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  -- Already claimed by this play? Return the same code and consume nothing.
  -- This is what makes a re-copy free, and it runs first so the common
  -- double-click case never even looks at the pool.
  select code into v_code
    from coupons
   where game_id = p_game_id
     and tier_index = p_tier_index
     and claimed_by_play_id = p_play_id
   limit 1;

  if v_code is not null then
    return v_code;
  end if;

  update coupons
     set claimed_at = now(),
         claimed_by_play_id = p_play_id
   where id = (
     select id
       from coupons
      where game_id = p_game_id
        and tier_index = p_tier_index
        and claimed_at is null
      order by created_at
      limit 1
      for update skip locked
   )
  returning code into v_code;

  -- NULL means the pool is exhausted. The caller shows the tier without a
  -- code rather than inventing one (build decision: a fabricated code fails
  -- at the merchant's checkout, which is worse for the player than no code).
  return v_code;
exception
  -- Lost the race against coupons_one_per_play_idx: a concurrent request for
  -- this same play won. Its code is now committed, so read and return it
  -- instead of surfacing a constraint error.
  when unique_violation then
    select code into v_code
      from coupons
     where game_id = p_game_id
       and tier_index = p_tier_index
       and claimed_by_play_id = p_play_id
     limit 1;
    return v_code;
end;
$$;

-- Only the service role calls this. Revoke the default so an anon/authenticated
-- caller cannot drain a pool by invoking it directly with guessed ids.
revoke all on function claim_coupon(uuid, int, uuid) from public;
revoke all on function claim_coupon(uuid, int, uuid) from anon;
revoke all on function claim_coupon(uuid, int, uuid) from authenticated;
