// lib/auth/browser.ts
//
// The browser-side Supabase client, used only for auth (sign in / sign out /
// "who am I"). All data still goes through this repo's own API routes, which
// are the trust boundary — see the header comment in lib/db/client.ts.
//
// This supersedes getSupabaseBrowserClient() in lib/db/client.ts, which was
// a placeholder that nothing called and which used createClient() with
// localStorage session persistence. Cookie-backed storage (what
// createBrowserClient gives us) is what makes the session visible to server
// components and route handlers too; localStorage is not.

"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { SUPABASE_ANON_KEY, SUPABASE_PUBLIC_URL, isAuthEnabled } from "./config";

let client: SupabaseClient | null = null;

/**
 * Returns null — rather than throwing — when auth is not configured, so the
 * UI can render a no-login build without every component guarding first.
 */
export function getBrowserSupabase(): SupabaseClient | null {
  if (!isAuthEnabled()) return null;
  if (!client) {
    client = createBrowserClient(SUPABASE_PUBLIC_URL, SUPABASE_ANON_KEY);
  }
  return client;
}
