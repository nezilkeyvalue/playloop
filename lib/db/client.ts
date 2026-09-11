// lib/db/client.ts
//
// Supabase client (server + browser), plus the dev-mode switch that the rest
// of the db layer (lib/db/queries.ts) reads. Build spec §2, §4, §19.
//
// MVP stub: real auth is out of scope (spec §19 — "magic link or a stub is
// fine"). There is exactly one implicit dev account (accountId: null)
// throughout this codebase; see the comment on that in queries.ts.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * True when no Supabase project is configured. In that case queries.ts uses
 * a JSON-file-backed store under ./dev-data/ instead of Postgres, so the
 * whole app runs with zero external accounts (build spec §19 "run the whole
 * app locally"). Flip it on by setting SUPABASE_URL (+ the service role key)
 * in .env.local and running lib/db/schema.sql against that project.
 */
export function isDevMode(): boolean {
  return !process.env.SUPABASE_URL;
}

let serverClient: SupabaseClient | null = null;

/**
 * Server-only client, authenticated with the service role key. This
 * deliberately bypasses RLS — per the comment in schema.sql, the Next.js API
 * routes ARE the trust boundary and authorize per-account before touching
 * any table. Never import this from a client component; every caller in
 * this repo is a route handler under app/api/**.
 *
 * Throws in dev mode — callers must check isDevMode() first (queries.ts
 * does this for every exported function so callers never have to).
 */
export function getSupabaseServerClient(): SupabaseClient {
  if (isDevMode()) {
    throw new Error(
      "getSupabaseServerClient() was called with SUPABASE_URL unset. " +
        "This is a bug in queries.ts — every query function must branch on " +
        "isDevMode() before reaching here.",
    );
  }
  if (!serverClient) {
    const url = process.env.SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) {
      throw new Error(
        "SUPABASE_SERVICE_ROLE_KEY is required once SUPABASE_URL is set.",
      );
    }
    serverClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return serverClient;
}

let browserClient: SupabaseClient | null = null;

/**
 * Browser client using the anon key, for future client-side reads once real
 * auth exists (out of MVP scope — see spec §19). Nothing in this build
 * calls it: every mutation and read in the builder UI goes through this
 * track's API routes, which use getSupabaseServerClient() above instead.
 * Kept only so the "server + browser" client shape the spec describes
 * exists and is easy to wire up later.
 *
 * Note: SUPABASE_URL is a server-only env var in .env.example (not
 * NEXT_PUBLIC_-prefixed), so calling this from an actual browser bundle
 * will not see a URL and will throw — that's expected until a public URL
 * var is added alongside real auth.
 */
export function getSupabaseBrowserClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase browser client requires a public URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }
  if (!browserClient) {
    browserClient = createClient(url, key);
  }
  return browserClient;
}
