// components/AuthButton.tsx
//
// The header's account control: a "Log in" button when signed out, the
// user's avatar + a small menu when signed in. Shared by the marketing
// header and the builder header so the two never drift.
//
// Renders nothing at all when auth isn't configured — a local build with no
// Supabase project shouldn't show a login affordance that can't work.

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import { useAuth, GoogleMark } from "@/components/AuthProvider";

export function AuthButton({ className = "" }: { className?: string }) {
  const { user, loading, authEnabled, openLogin, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  if (!authEnabled) return null;

  if (loading) {
    return <div className={`h-9 w-24 animate-pulse rounded-full bg-foreground/[0.06] ${className}`} />;
  }

  if (!user) {
    return (
      <button
        type="button"
        onClick={() => openLogin()}
        className={`flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-semibold transition hover:bg-foreground/[0.04] active:scale-[0.98] ${className}`}
      >
        <GoogleMark className="h-4 w-4" />
        Log in
      </button>
    );
  }

  const label = user.name ?? user.email ?? "Account";

  return (
    <div ref={menuRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="flex items-center gap-2 rounded-full border border-border bg-card py-1 pl-1 pr-3 text-sm font-medium transition hover:bg-foreground/[0.04]"
      >
        <Avatar user={user} />
        <span className="max-w-[10rem] truncate">{label}</span>
      </button>

      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-xl border border-border bg-card shadow-elevated"
        >
          <div className="border-b border-border px-4 py-3">
            <p className="truncate text-sm font-medium">{user.name ?? "Signed in"}</p>
            {user.email && <p className="truncate text-xs text-muted">{user.email}</p>}
          </div>
          <Link
            href="/games"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
            className="block px-4 py-2.5 text-sm transition hover:bg-foreground/[0.04]"
          >
            My games
          </Link>
          <Link
            href="/build"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
            className="block px-4 py-2.5 text-sm transition hover:bg-foreground/[0.04]"
          >
            New game
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              void signOut();
            }}
            className="block w-full border-t border-border px-4 py-2.5 text-left text-sm text-destructive/90 transition hover:bg-foreground/[0.04] hover:text-destructive"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

function Avatar({ user }: { user: { name: string | null; email: string | null; avatarUrl: string | null } }) {
  const initial = (user.name ?? user.email ?? "?").trim().charAt(0).toUpperCase();

  if (user.avatarUrl) {
    return (
      // Plain <img>, not next/image: the src is a Google CDN host we don't
      // control and haven't allowlisted in next.config.ts, and this is a
      // 28px decoration — nothing to gain from the optimizer here.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.avatarUrl}
        alt=""
        width={28}
        height={28}
        referrerPolicy="no-referrer"
        className="h-7 w-7 rounded-full object-cover"
      />
    );
  }

  return (
    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
      {initial}
    </span>
  );
}
