// lib/auth/server.ts
//
// Server-side session reading, for route handlers and server components.
// This is the ONLY place that turns "an HTTP request" into "an account id";
// every API route goes through resolveAccountId()/requireAccount() below so
// there is exactly one answer to "whose data is this?".
//
// Note the split of responsibilities with lib/db/client.ts: that file's
// getSupabaseServerClient() uses the SERVICE ROLE key and deliberately
// bypasses RLS, because the API routes are the trust boundary. The client
// built here uses the ANON key plus the caller's own cookies, so it is
// subject to RLS and can only ever see the signed-in user — which is
// exactly what you want for answering "who is calling?", and exactly what
// you don't want for the actual data queries. Don't mix them up.

// Not marked with the `server-only` package (not a dependency here); the
// next/headers import below already makes any client-component import of
// this file a build error, which is the same guarantee.

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";

import { SUPABASE_ANON_KEY, SUPABASE_PUBLIC_URL, isAuthEnabled } from "./config";

export interface SessionUser {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

/**
 * A cookie-backed Supabase client for the current request.
 *
 * `cookies()` is read-only inside server components and route handlers that
 * haven't started a response, so setAll() is wrapped in a try/catch — that's
 * the documented pattern, and the token refresh it would have written is
 * picked up again by app/auth/callback/route.ts (which CAN write cookies)
 * on the next round trip.
 */
export async function createRequestScopedSupabase() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_PUBLIC_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Read-only cookie store (server component render). Safe to ignore.
        }
      },
    },
  });
}

/**
 * The signed-in user, or null.
 *
 * Uses getUser() rather than getSession(): getSession() returns whatever the
 * cookie claims without verifying it against the auth server, so it must
 * never be the basis of an authorization decision. getUser() revalidates.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (!isAuthEnabled()) return null;

  const supabase = await createRequestScopedSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  const meta = data.user.user_metadata ?? {};
  return {
    id: data.user.id,
    email: data.user.email ?? null,
    name:
      (typeof meta.full_name === "string" && meta.full_name) ||
      (typeof meta.name === "string" && meta.name) ||
      null,
    avatarUrl:
      (typeof meta.avatar_url === "string" && meta.avatar_url) ||
      (typeof meta.picture === "string" && meta.picture) ||
      null,
  };
}

/**
 * The account id to scope queries by, following the same "null is the single
 * implicit dev account" convention lib/db/queries.ts already documents.
 *
 * - auth disabled  -> null, and the caller should NOT require a login
 * - auth enabled, signed in     -> the user's uuid (== accounts.id)
 * - auth enabled, not signed in -> null, and the caller SHOULD 401
 *
 * The two null cases are told apart by isAuthEnabled(), which is why
 * requireAccount() below exists rather than every route re-deriving it.
 */
export async function resolveAccountId(): Promise<string | null> {
  const user = await getSessionUser();
  return user?.id ?? null;
}

export type RequireAccountResult =
  | { ok: true; accountId: string | null; user: SessionUser | null }
  | { ok: false; response: NextResponse };

/**
 * Gate for every route that touches per-account data. Returns either the
 * account id to use or a ready-made 401 for the caller to return.
 *
 * The 401 body is `{ error: "unauthenticated" }` — the builder UI keys its
 * "sign in to continue" modal off exactly that string, so don't rename it
 * without updating components/AuthGate.tsx.
 */
export async function requireAccount(): Promise<RequireAccountResult> {
  if (!isAuthEnabled()) {
    // Local/dev: one implicit account, no login wall. Same contract as
    // before this file existed.
    return { ok: true, accountId: null, user: null };
  }

  const user = await getSessionUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthenticated" }, { status: 401 }),
    };
  }
  return { ok: true, accountId: user.id, user };
}

/**
 * Ownership check for a row that carries an account_id.
 *
 * Returns 404 rather than 403 on a mismatch on purpose: a 403 confirms the
 * id exists, which leaks whether a given game id is real to anyone who can
 * guess one. The caller can't tell "never existed" from "not yours", which
 * is the correct amount of information to hand out.
 */
export function ownsRecord(
  record: { accountId: string | null },
  accountId: string | null,
): boolean {
  return record.accountId === accountId;
}

export function notFound(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}
