// app/auth/callback/route.ts
//
// Where Supabase sends the browser back after Google consent. Exchanges the
// one-time `code` for a session and writes the auth cookies, then bounces to
// wherever the user was headed.
//
// This is the one place in the app that can reliably WRITE auth cookies (see
// the note on setAll() in lib/auth/server.ts), which is why the exchange has
// to happen here and not in a server component.

export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

import { SUPABASE_ANON_KEY, SUPABASE_PUBLIC_URL, isAuthEnabled } from "@/lib/auth/config";

/**
 * Only same-origin relative paths are honoured. `next` comes straight off the
 * query string, so accepting an absolute URL here would turn our own callback
 * into an open redirect that phishing pages could bounce through with a real
 * playloop.app origin in the address bar.
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/games";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/games";
  return raw;
}

export async function GET(req: NextRequest) {
  const { searchParams, origin } = req.nextUrl;
  const next = safeNext(searchParams.get("next"));

  if (!isAuthEnabled()) {
    return NextResponse.redirect(`${origin}${next}`);
  }

  // Google itself can fail the consent (user hit "cancel", app not verified,
  // …). Surface that on the landing page rather than silently pretending the
  // sign-in worked and then 401ing on the next call.
  const oauthError = searchParams.get("error_description") ?? searchParams.get("error");
  if (oauthError) {
    return NextResponse.redirect(
      `${origin}/?auth_error=${encodeURIComponent(oauthError.slice(0, 200))}`,
    );
  }

  const code = searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(`${origin}/?auth_error=missing_code`);
  }

  const response = NextResponse.redirect(`${origin}${next}`);
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

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      `${origin}/?auth_error=${encodeURIComponent(error.message.slice(0, 200))}`,
    );
  }

  return response;
}
