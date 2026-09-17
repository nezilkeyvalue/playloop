// components/AuthGate.tsx
//
// Wraps any builder page whose contents belong to one account. Signed out,
// it shows a sign-in card instead of firing a fetch that would only 401;
// signed in (or with auth not configured at all) it renders its children
// untouched.
//
// Deliberately NOT a redirect to a /login page: the app has no login route,
// and bouncing someone off the page they asked for loses the URL they were
// trying to reach. The card keeps them where they are.

"use client";

import { useAuth, GoogleMark } from "@/components/AuthProvider";

export function AuthGate({
  children,
  title = "Sign in to see your games",
  description = "Your games are saved to your account. Sign in with Google to pick up where you left off.",
}: {
  children: React.ReactNode;
  title?: string;
  description?: string;
}) {
  const { user, loading, authEnabled, signInWithGoogle } = useAuth();

  // No Supabase project configured — single implicit account, no gate.
  if (!authEnabled) return <>{children}</>;

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-40 animate-pulse rounded-2xl border border-border bg-card" />
        ))}
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto mt-10 max-w-md animate-fade-up rounded-2xl border border-border bg-card p-10 text-center shadow-card">
        <h1 className="font-display text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted">{description}</p>
        <button
          type="button"
          onClick={() => void signInWithGoogle(window.location.pathname)}
          className="mt-6 flex w-full items-center justify-center gap-3 rounded-xl border border-border bg-background px-5 py-3 text-sm font-semibold transition hover:bg-foreground/[0.04] active:scale-[0.98]"
        >
          <GoogleMark className="h-5 w-5" />
          Continue with Google
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
