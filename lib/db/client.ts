// lib/db/client.ts
//
// Supabase client (server + browser), plus the dev-mode switch that the rest
// of the db layer (lib/db/queries.ts) reads. Build spec §2, §4, §19.
//
// Auth is real now and lives in lib/auth/* (Google SSO via Supabase Auth);
// accounts.id is the same uuid as auth.users.id. The `accountId: null` row
// owner this codebase used to pass everywhere survives as exactly one thing:
// the single implicit account used when NO Supabase project is configured.
// See the comment on that in queries.ts, and lib/auth/server.ts#requireAccount.

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

// The browser client that used to live here has moved to lib/auth/browser.ts.
// It was a never-called placeholder using createClient() with localStorage
// session persistence; the replacement uses @supabase/ssr's
// createBrowserClient(), whose cookie-backed session is the thing that makes
// a login visible to server components and route handlers too. localStorage
// is not. Nothing in this file needs a browser client any more — every read
// and mutation still goes through the API routes and the service-role client
// above, which remains the trust boundary.
