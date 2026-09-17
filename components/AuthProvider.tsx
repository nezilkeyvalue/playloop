// components/AuthProvider.tsx
//
// Client-side session state + the one login modal the whole app shares.
//
// Two things live here rather than in each page because both are genuinely
// app-wide: (1) "is someone signed in", which the header, the landing page
// and /games all need, and (2) requireLogin(), the call any action makes
// when it needs a user and might not have one — the landing page's "Make it
// playable" button is the motivating case.
//
// When auth is not configured (no NEXT_PUBLIC_SUPABASE_* vars) this degrades
// to `authEnabled: false`, `user: null`, and a requireLogin() that just says
// "yes, go ahead" — so the zero-external-accounts local build in CLAUDE.md
// keeps working with no login wall anywhere.

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";

import { getBrowserSupabase } from "@/lib/auth/browser";
import { isAuthEnabled } from "@/lib/auth/config";

export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  authEnabled: boolean;
  /**
   * Returns true if the caller may proceed. When it returns false it has
   * already opened the login modal, so the caller should simply bail out.
   *
   *   if (!requireLogin()) return;
   *   await doTheThing();
   */
  requireLogin: (reason?: string) => boolean;
  openLogin: (reason?: string) => void;
  closeLogin: () => void;
  signInWithGoogle: (next?: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth() must be used inside <AuthProvider>.");
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const authEnabled = isAuthEnabled();
  const pathname = usePathname();

  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(authEnabled);
  const [loginReason, setLoginReason] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);

  // The page the user was on when the modal opened — we send them back here
  // after Google, not to a generic dashboard, so an interrupted action
  // resumes where it was.
  const returnToRef = useRef<string>("/games");

  useEffect(() => {
    if (!authEnabled) return;
    const supabase = getBrowserSupabase();
    if (!supabase) return;

    let cancelled = false;

    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      setUser(data.user ? toAuthUser(data.user) : null);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ? toAuthUser(session.user) : null);
      setLoading(false);
      if (session?.user) setLoginOpen(false);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [authEnabled]);

  const openLogin = useCallback(
    (reason?: string) => {
      returnToRef.current = pathname ?? "/games";
      setLoginReason(reason ?? null);
      setLoginOpen(true);
    },
    [pathname],
  );

  const closeLogin = useCallback(() => setLoginOpen(false), []);

  const requireLogin = useCallback(
    (reason?: string) => {
      if (!authEnabled) return true;
      // Still resolving the session — don't flash a login modal at someone
      // who is in fact signed in.
      if (loading) return false;
      if (user) return true;
      openLogin(reason);
      return false;
    },
    [authEnabled, loading, user, openLogin],
  );

  const signInWithGoogle = useCallback(
    async (next?: string) => {
      const supabase = getBrowserSupabase();
      if (!supabase) return;
      const target = next ?? returnToRef.current ?? "/games";
      await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(target)}`,
          // Google only returns a refresh token on the first consent unless
          // asked again; without this a returning user's session cannot be
          // refreshed server-side after the access token expires.
          queryParams: { access_type: "offline", prompt: "consent" },
        },
      });
    },
    [],
  );

  const signOut = useCallback(async () => {
    const supabase = getBrowserSupabase();
    // Sign out in the browser (clears the client cache immediately) and then
    // through the route handler, which is what actually expires the httpOnly
    // cookies the server reads. Doing only one of the two leaves the other
    // side still believing there is a session.
    if (supabase) await supabase.auth.signOut();
    await fetch("/auth/signout", { method: "POST", redirect: "manual" });
    setUser(null);
    window.location.href = "/";
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      authEnabled,
      requireLogin,
      openLogin,
      closeLogin,
      signInWithGoogle,
      signOut,
    }),
    [user, loading, authEnabled, requireLogin, openLogin, closeLogin, signInWithGoogle, signOut],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      {loginOpen && <LoginModal reason={loginReason} />}
    </AuthContext.Provider>
  );
}

function toAuthUser(user: {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}): AuthUser {
  const meta = user.user_metadata ?? {};
  const pick = (key: string) => (typeof meta[key] === "string" ? (meta[key] as string) : null);
  return {
    id: user.id,
    email: user.email ?? null,
    name: pick("full_name") ?? pick("name"),
    avatarUrl: pick("avatar_url") ?? pick("picture"),
  };
}

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

function LoginModal({ reason }: { reason: string | null }) {
  const { closeLogin, signInWithGoogle } = useAuth();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeLogin();
    }
    window.addEventListener("keydown", onKey);
    // The page behind a modal must not scroll under it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [closeLogin]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-foreground/40 p-6 backdrop-blur-sm"
      onClick={closeLogin}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-modal-title"
        className="w-full max-w-sm animate-fade-up rounded-2xl border border-border bg-card p-8 text-center shadow-elevated"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="login-modal-title" className="font-display text-xl font-semibold tracking-tight">
          Sign in to continue
        </h2>
        <p className="mx-auto mt-2 max-w-xs text-sm text-muted">
          {reason ?? "Sign in so we can save your game and keep it in My games."}
        </p>

        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await signInWithGoogle();
            } finally {
              // Only reached if the redirect didn't happen (popup blocked,
              // network error) — otherwise the page is already gone.
              setBusy(false);
            }
          }}
          className="mt-6 flex w-full items-center justify-center gap-3 rounded-xl border border-border bg-background px-5 py-3 text-sm font-semibold transition hover:bg-foreground/[0.04] active:scale-[0.98] disabled:opacity-50"
        >
          <GoogleMark className="h-5 w-5" />
          {busy ? "Redirecting…" : "Continue with Google"}
        </button>

        <button
          type="button"
          onClick={closeLogin}
          className="mt-3 w-full rounded-xl px-5 py-2 text-sm text-muted transition hover:text-foreground"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

/** Google's brand mark. Fixed hex values — these are Google's colours, not ours. */
export function GoogleMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59A14.5 14.5 0 0 1 9.77 24c0-1.6.27-3.15.76-4.59l-7.98-6.19A23.94 23.94 0 0 0 0 24c0 3.88.93 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
