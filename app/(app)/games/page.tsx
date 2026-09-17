// app/(app)/games/page.tsx — list via GET /api/games (spec §12, §15).
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { GameRecord } from "@/lib/engine/types";
import { GamePreviewModal } from "@/components/GamePreviewModal";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { AuthGate } from "@/components/AuthGate";
import { useAuth } from "@/components/AuthProvider";

/**
 * "My games" is now literally my games: GET /api/games returns only the rows
 * owned by the signed-in account (app/api/games/route.ts). The AuthGate
 * wrapper is what keeps a signed-out visitor from seeing an empty list and
 * concluding their games were deleted.
 */
export default function GamesListPage() {
  return (
    <AuthGate>
      <GamesList />
    </AuthGate>
  );
}

function GamesList() {
  const [games, setGames] = useState<GameRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewGame, setPreviewGame] = useState<GameRecord | null>(null);
  const { user, openLogin } = useAuth();

  useEffect(() => {
    fetch("/api/games", { cache: "no-store" })
      .then((res) => {
        // The session can expire between AuthGate letting us through and this
        // fetch landing; reopen the modal rather than showing a bare error.
        if (res.status === 401) {
          openLogin("Your session expired. Sign in again to see your games.");
          return [];
        }
        if (!res.ok) throw new Error("Could not load games.");
        return res.json();
      })
      .then(setGames)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load."));
    // Refetch when the signed-in account changes — otherwise logging in as a
    // different user leaves the previous account's list on screen.
  }, [user?.id, openLogin]);

  async function handleDelete(id: string) {
    if (!confirm("Delete this game? This cannot be undone.")) return;
    await fetch(`/api/games/${id}`, { method: "DELETE" });
    setGames((prev) => prev?.filter((g) => g.id !== id) ?? null);
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl font-semibold tracking-tight">My games</h1>
        <Link
          href="/build"
          className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition active:scale-[0.98]"
        >
          New game
        </Link>
      </div>

      {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

      {games === null && !error && (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-40 animate-pulse rounded-2xl border border-border bg-card" />
          ))}
        </div>
      )}

      {games?.length === 0 && (
        <div className="mt-6 rounded-2xl border border-dashed border-border bg-card p-12 text-center">
          <p className="text-muted">
            No games yet.{" "}
            <Link href="/build" className="font-medium text-primary underline underline-offset-4">
              Build your first one
            </Link>
            .
          </p>
        </div>
      )}

      {games && games.length > 0 && (
        <>
          <div className="mt-6 grid grid-cols-3 divide-x divide-border rounded-2xl border border-border bg-card shadow-card">
            <SummaryStat value={games.length} label="Total games" />
            <SummaryStat
              value={games.filter((g) => g.status === "published").length}
              label="Published"
            />
            <SummaryStat
              value={games.filter((g) => g.status !== "published").length}
              label="Drafts"
            />
          </div>

          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {games.map((g, i) => (
              <li
                key={g.id}
                className="group flex animate-fade-up flex-col justify-between rounded-2xl border border-border bg-card p-5 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-elevated"
                style={{ animationDelay: `${Math.min(i, 8) * 60}ms` }}
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-3 w-3 shrink-0 rounded-full border border-border"
                        style={{ background: g.spec.brand.accent }}
                        aria-hidden="true"
                      />
                      <Link href={`/games/${g.id}`} className="font-medium hover:text-primary">
                        {g.name}
                      </Link>
                    </div>
                    <StatusBadge status={g.status} />
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                    <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 capitalize">
                      {g.spec.template.replace("_", " ")}
                    </span>
                    {g.slug && <span>/{g.slug}</span>}
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-sm">
                  <button onClick={() => setPreviewGame(g)} className="font-medium text-primary hover:underline">
                    Preview
                  </button>
                  <Link href={`/games/${g.id}`} className="text-muted hover:text-foreground">
                    Edit
                  </Link>
                  <Link href={`/games/${g.id}/embed`} className="text-muted hover:text-foreground">
                    Embed
                  </Link>
                  <Link href={`/games/${g.id}/stats`} className="text-muted hover:text-foreground">
                    Stats
                  </Link>
                  <button
                    onClick={() => handleDelete(g.id)}
                    className="ml-auto text-destructive/80 hover:text-destructive"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {previewGame && (
        <GamePreviewModal
          spec={previewGame.spec}
          placement={previewGame.placement}
          slug={previewGame.slug ?? undefined}
          onClose={() => setPreviewGame(null)}
        />
      )}
    </div>
  );
}

function SummaryStat({ value, label }: { value: number; label: string }) {
  return (
    <div className="px-5 py-4 text-center first:text-left last:text-right sm:text-left">
      <div className="text-2xl font-semibold tracking-tight">
        <AnimatedNumber value={value} />
      </div>
      <div className="mt-0.5 text-xs text-muted">{label}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isPublished = status === "published";
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
        isPublished ? "bg-success/10 text-success" : "bg-foreground/[0.06] text-muted"
      }`}
    >
      {status}
    </span>
  );
}
