// lib/auth/config.ts
//
// The single switch the rest of the auth layer reads. Kept separate from
// lib/auth/server.ts so client components can import it without dragging
// next/headers (server-only) into the browser bundle.
//
// Auth is OPTIONAL by design, exactly like Supabase itself is in
// lib/db/client.ts#isDevMode: with the two public env vars unset the whole
// app still runs against the ./dev-data JSON store with one implicit
// account and no login wall (CLAUDE.md: "No external accounts needed").
// Set them and every route below starts scoping by the signed-in user.

/** The browser-visible project URL. Server code may fall back to SUPABASE_URL. */
export const SUPABASE_PUBLIC_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";

export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/**
 * True once a Supabase project is reachable from the browser bundle. This is
 * deliberately a different question from lib/db/client.ts#isDevMode (which
 * only needs the server-side SUPABASE_URL): a deployment could in principle
 * have a database but no public keys, and in that case there is no way to
 * run a login flow, so we must not put a login wall in front of anything.
 */
export function isAuthEnabled(): boolean {
  return SUPABASE_PUBLIC_URL !== "" && SUPABASE_ANON_KEY !== "";
}

/**
 * Where Google sends the user back after consent. Must match, byte for byte,
 * both the "Authorized redirect URI" on the Google OAuth client and the
 * Supabase Auth site/redirect allowlist.
 */
export function authCallbackUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/auth/callback`;
}
