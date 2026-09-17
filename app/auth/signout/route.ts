// app/auth/signout/route.ts
//
// POST -> clears the session cookies and redirects home.
//
// POST rather than GET on purpose: a GET sign-out can be triggered by any
// <img src> or link prefetch on a page the user visits, which makes logging
// people out a trivial cross-site nuisance.

export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

import { SUPABASE_ANON_KEY, SUPABASE_PUBLIC_URL, isAuthEnabled } from "@/lib/auth/config";

export async function POST(req: NextRequest) {
  const { origin } = req.nextUrl;
  const response = NextResponse.redirect(`${origin}/`, { status: 303 });

  if (!isAuthEnabled()) return response;

  const supabase = createServerClient(SUPABASE_PUBLIC_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  await supabase.auth.signOut();
  return response;
}
