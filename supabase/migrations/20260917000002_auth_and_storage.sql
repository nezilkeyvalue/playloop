-- 20260917000002_auth_and_storage.sql
--
-- Turns the MVP's single implicit dev account (accountId: null, see the
-- header comment in lib/db/queries.ts) into real per-user tenancy backed by
-- Supabase Auth, and moves sprite/upload blobs off the local disk into a
-- Storage bucket.
--
-- The `accounts` table already existed in 20260917000001_init.sql but was
-- never written to. Its `id` is now the SAME uuid as `auth.users.id`, which
-- is what makes every `auth.uid() = account_id` policy in the init migration
-- correct rather than aspirational.

-- Accounts are Auth users ----------------------------------------------------
alter table accounts
  add constraint accounts_id_fkey
  foreign key (id) references auth.users (id) on delete cascade;

-- Carry the display fields Google SSO gives us, so the UI can show a name
-- and avatar without a second round trip to auth.users.
alter table accounts add column if not exists display_name text;
alter table accounts add column if not exists avatar_url   text;

-- Every new auth user gets an accounts row automatically. SECURITY DEFINER
-- because the trigger runs as the auth admin role, which has no rights on
-- the public schema.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.accounts (id, email, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'avatar_url', '')
  )
  on conflict (id) do update
    set email        = excluded.email,
        display_name = coalesce(excluded.display_name, accounts.display_name),
        avatar_url   = coalesce(excluded.avatar_url,   accounts.avatar_url);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update on auth.users
  for each row execute function public.handle_new_auth_user();

-- Backfill any users that already exist (e.g. if someone signed in before
-- this migration ran).
insert into public.accounts (id, email, display_name, avatar_url)
select u.id,
       coalesce(u.email, ''),
       nullif(u.raw_user_meta_data ->> 'full_name', ''),
       nullif(u.raw_user_meta_data ->> 'avatar_url', '')
from auth.users u
on conflict (id) do nothing;

-- accounts.email is `unique not null` from the init migration. Auth allows a
-- null email for some providers; Google never does, but keep the insert above
-- honest by defaulting to ''. Drop the unique constraint so two providerless
-- users can't collide on that empty string.
alter table accounts drop constraint if exists accounts_email_key;
create unique index if not exists accounts_email_idx
  on accounts (email) where email <> '';

-- An account may update its own row (display name), not just select it.
drop policy if exists accounts_self on accounts;
create policy accounts_self_select on accounts for select using (auth.uid() = id);
create policy accounts_self_update on accounts for update using (auth.uid() = id);

-- Storage --------------------------------------------------------------------
-- Sprites are public by design: the embed script renders them on third-party
-- storefronts with no PlayLoop session, so a signed URL would expire mid-game.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sprites',
  'sprites',
  true,
  8388608,                                   -- 8MB, matches MAX_BYTES in app/api/upload/route.ts
  array['image/png','image/jpeg','image/webp','image/avif','image/svg+xml']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Anyone may read a sprite; only the service role (which bypasses RLS) writes
-- them, so there is deliberately no insert/update/delete policy here.
drop policy if exists sprites_public_read on storage.objects;
create policy sprites_public_read on storage.objects
  for select using (bucket_id = 'sprites');
