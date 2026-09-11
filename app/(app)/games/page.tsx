// app/(app)/games/page.tsx — list via GET /api/games (spec §12, §15).
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { GameRecord } from "@/lib/engine/types";

export default function GamesListPage() {
  const [games, setGames] = useState<GameRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/games", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("Could not load games.");
        return res.json();
      })
      .then(setGames)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, []);

  async function handleDelete(id: string) {
    if (!confirm("Delete this game? This cannot be undone.")) return;
    await fetch(`/api/games/${id}`, { method: "DELETE" });
    setGames((prev) => prev?.filter((g) => g.id !== id) ?? null);
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">My games</h1>
        <Link
          href="/build"
          className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper"
        >
          New game
        </Link>
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {games === null && !error && <p className="mt-6 text-sm text-ink/50">Loading…</p>}

      {games?.length === 0 && (
        <p className="mt-6 text-sm text-ink/50">
          No games yet. <Link href="/build" className="underline">Build your first one</Link>.
        </p>
      )}

      {games && games.length > 0 && (
        <ul className="mt-6 divide-y divide-ink/10 rounded-md border border-ink/10">
          {games.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-4 p-4">
              <div>
                <Link href={`/games/${g.id}`} className="font-medium hover:underline">
                  {g.name}
                </Link>
                <div className="mt-1 flex items-center gap-2 text-xs text-ink/50">
                  <span className="rounded-full bg-ink/10 px-2 py-0.5 capitalize">
                    {g.status}
                  </span>
                  <span>{g.spec.template}</span>
                  {g.slug && <span>/{g.slug}</span>}
                </div>
              </div>
              <div className="flex shrink-0 gap-3 text-sm">
                <Link href={`/games/${g.id}`} className="underline">
                  Edit
                </Link>
                <Link href={`/games/${g.id}/embed`} className="underline">
                  Embed
                </Link>
                <Link href={`/games/${g.id}/stats`} className="underline">
                  Stats
                </Link>
                <button onClick={() => handleDelete(g.id)} className="text-red-600 underline">
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
