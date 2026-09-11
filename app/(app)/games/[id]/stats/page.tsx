// app/(app)/games/[id]/stats/page.tsx
//
// Analytics dashboard (spec §16): plays, completion rate, avg score, replay
// rate, rewards by tier, leads captured, device split, top referrers.
// Charted with recharts, fed by GET /api/games/:id/stats.
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Stats {
  plays: number;
  completionRate: number;
  avgScore: number;
  replayRate: number;
  rewardsByTier: { label: string; count: number }[];
  leadsCaptured: number;
  deviceSplit: { mobile: number; desktop: number };
  topReferrers: { referrer: string; count: number }[];
}

const ACCENT = "#3B82F6";
const ACCENT_SOFT = "#93C5FD";

export default function StatsPage() {
  const { id } = useParams<{ id: string }>();
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/games/${id}/stats`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("Could not load stats.");
        return res.json();
      })
      .then(setStats)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [id]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!stats) return <p className="text-sm text-ink/50">Loading…</p>;

  const deviceData = [
    { name: "Mobile", value: stats.deviceSplit.mobile },
    { name: "Desktop", value: stats.deviceSplit.desktop },
  ];

  return (
    <div className="space-y-10">
      <h1 className="text-2xl font-semibold">Stats</h1>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Plays" value={stats.plays.toString()} />
        <Stat label="Completion rate" value={`${Math.round(stats.completionRate * 100)}%`} />
        <Stat label="Avg score" value={Math.round(stats.avgScore).toString()} />
        <Stat label="Replay rate" value={`${Math.round(stats.replayRate * 100)}%`} />
        <Stat label="Leads captured" value={stats.leadsCaptured.toString()} />
      </div>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/50">
          Rewards claimed by tier
        </h2>
        <div className="mt-3 h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={stats.rewardsByTier}>
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Bar dataKey="count" fill={ACCENT} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/50">
            Device split
          </h2>
          <div className="mt-3 h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={deviceData} dataKey="value" nameKey="name" outerRadius={80} label>
                  <Cell fill={ACCENT} />
                  <Cell fill={ACCENT_SOFT} />
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/50">
            Top referrers
          </h2>
          {stats.topReferrers.length === 0 ? (
            <p className="mt-3 text-sm text-ink/50">No referrer data yet.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {stats.topReferrers.map((r) => (
                <li key={r.referrer} className="flex justify-between border-b border-ink/5 pb-1">
                  <span className="truncate">{r.referrer}</span>
                  <span className="text-ink/50">{r.count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-ink/10 p-4">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-ink/50">{label}</div>
    </div>
  );
}
