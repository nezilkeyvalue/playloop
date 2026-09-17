"use client";

import Link from "next/link";
import { useId, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ANALYTICS_SECTION,
  copyToClipboard,
  FUNNEL_STEP_SCROLL,
  scrollToAnalyticsSection,
} from "@/components/analytics/interaction";
import type {
  FunnelStep,
  GameAnalyticsSummary,
  LeadAnalyticsRow,
  ReferrerRow,
  TimeSeriesPoint,
} from "@/lib/analytics/types";

const CHART_PRIMARY = "rgb(var(--primary))";
const CHART_SECONDARY = "#FF7A3D";
const CHART_SUCCESS = "rgb(var(--success))";
const CHART_MUTED = "rgb(var(--muted-foreground) / 0.35)";

type MetricTone = "primary" | "success" | "warning" | "secondary";

const METRIC_TONE_CLASS: Record<MetricTone, string> = {
  primary: "from-primary/20 to-primary/[0.04] ring-primary/20",
  success: "from-success/20 to-success/[0.04] ring-success/25",
  warning: "from-warning/25 to-warning/[0.06] ring-warning/25",
  secondary: "from-foreground/[0.08] to-foreground/[0.02] ring-border",
};

export function MetricCard({
  label,
  value,
  hint,
  tone = "secondary",
  scrollToSection,
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: MetricTone;
  /** Smooth-scroll to a section id (see ANALYTICS_SECTION). */
  scrollToSection?: string;
  onClick?: () => void;
}) {
  const interactive = Boolean(scrollToSection || onClick);
  const baseClass = `relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br p-4 text-left shadow-card ring-1 ring-inset transition-all ${METRIC_TONE_CLASS[tone]} ${
    interactive
      ? "cursor-pointer hover:-translate-y-0.5 hover:shadow-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:translate-y-0"
      : ""
  }`;

  const body = (
    <>
      <div className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{value}</div>
      <div className="mt-1 text-xs font-medium text-muted">{label}</div>
      {hint ? <div className="mt-2 text-[10px] leading-snug text-muted/80">{hint}</div> : null}
      {interactive ? (
        <div className="mt-2 text-[10px] font-medium text-primary/80">Click to explore →</div>
      ) : null}
    </>
  );

  if (!interactive) {
    return <div className={baseClass}>{body}</div>;
  }

  return (
    <button
      type="button"
      className={baseClass}
      onClick={() => {
        onClick?.();
        if (scrollToSection) scrollToAnalyticsSection(scrollToSection);
      }}
    >
      {body}
    </button>
  );
}

export function FunnelChart({
  steps,
  focusedStep,
  onFocusStep,
  stepScrollOverrides,
}: {
  steps: FunnelStep[];
  focusedStep?: string | null;
  onFocusStep?: (key: string | null) => void;
  stepScrollOverrides?: Partial<Record<string, string>>;
}) {
  const [localFocus, setLocalFocus] = useState<string | null>(null);
  const activeKey = focusedStep !== undefined ? focusedStep : localFocus;
  const setFocus = (key: string | null) => {
    onFocusStep?.(key);
    if (focusedStep === undefined) setLocalFocus(key);
  };

  const top = steps[0]?.count ?? 0;
  const max = Math.max(top, 1);

  if (steps.every((s) => s.count === 0)) {
    return (
      <p className="rounded-xl border border-dashed border-border bg-card2 px-4 py-8 text-center text-sm text-muted">
        No funnel activity in this range yet. Embed a published game and play a round to see data
        here.
      </p>
    );
  }

  return (
    <ul className="space-y-4">
      {steps.map((step, index) => {
        const widthPct = Math.max(4, Math.round((step.count / max) * 100));
        const fromTop =
          top > 0 && index > 0 ? Math.round((step.count / top) * 100) : step.count > 0 ? 100 : 0;
        const isActive = activeKey === step.key;
        const targetSection =
          stepScrollOverrides?.[step.key] ?? FUNNEL_STEP_SCROLL[step.key];

        return (
          <li key={step.key}>
            <button
              type="button"
              className={`w-full rounded-xl px-2 py-2 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                isActive ? "bg-primary/[0.06] ring-1 ring-primary/25" : ""
              }`}
              onClick={() => {
                setFocus(isActive ? null : step.key);
                if (targetSection) scrollToAnalyticsSection(targetSection);
              }}
            >
            <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{step.label}</span>
              <div className="flex items-center gap-2 text-sm">
                <span className="font-display font-semibold tabular-nums">{step.count}</span>
                {index > 0 && step.rateFromPrevious !== null ? (
                  <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] font-medium text-muted">
                    {Math.round(step.rateFromPrevious * 100)}% prev
                  </span>
                ) : index === 0 && top > 0 ? (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                    100% top
                  </span>
                ) : null}
                {index > 0 && top > 0 ? (
                  <span className="text-[10px] text-muted">{fromTop}% of impressions</span>
                ) : null}
              </div>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-foreground/[0.06]">
              <div
                className={`h-full rounded-full bg-gradient-to-r from-primary to-primary/70 transition-all duration-500 ${
                  isActive ? "from-primary to-primary" : ""
                }`}
                style={{ width: `${widthPct}%` }}
              />
            </div>
            {targetSection ? (
              <p className="mt-1.5 text-[10px] text-muted">Jump to related section</p>
            ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const TIME_SERIES_SERIES = [
  { key: "impressions" as const, label: "Impressions", color: CHART_SECONDARY, fill: true },
  { key: "plays" as const, label: "Plays", color: CHART_PRIMARY, fill: true },
  { key: "completions" as const, label: "Completions", color: CHART_SUCCESS, fill: false },
  { key: "leads" as const, label: "Leads", color: "#a855f7", fill: false },
];

export function TimeSeriesChart({ data }: { data: TimeSeriesPoint[] }) {
  const uid = useId().replace(/:/g, "");
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  function toggleSeries(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (data.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border bg-card2 px-4 py-8 text-center text-sm text-muted">
        No activity in this range yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {TIME_SERIES_SERIES.map((s) => {
          const off = hidden.has(s.key);
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => toggleSeries(s.key)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                off
                  ? "border-border bg-card2 text-muted line-through opacity-60"
                  : "border-border bg-card text-foreground shadow-sm hover:border-primary/30"
              }`}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: off ? "rgb(var(--border))" : s.color }}
                aria-hidden
              />
              {s.label}
            </button>
          );
        })}
      </div>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`fillPlays-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_PRIMARY} stopOpacity={0.35} />
                <stop offset="100%" stopColor={CHART_PRIMARY} stopOpacity={0} />
              </linearGradient>
              <linearGradient id={`fillImpressions-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_SECONDARY} stopOpacity={0.25} />
                <stop offset="100%" stopColor={CHART_SECONDARY} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_MUTED} vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "rgb(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 11, fill: "rgb(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={false}
              width={32}
            />
            <Tooltip
              contentStyle={{
                borderRadius: 12,
                border: "1px solid rgb(var(--border))",
                background: "rgb(var(--card))",
                fontSize: 12,
              }}
            />
            {!hidden.has("impressions") ? (
              <Area
                type="monotone"
                dataKey="impressions"
                stroke={CHART_SECONDARY}
                fill={`url(#fillImpressions-${uid})`}
                strokeWidth={2}
                dot={false}
              />
            ) : null}
            {!hidden.has("plays") ? (
              <Area
                type="monotone"
                dataKey="plays"
                stroke={CHART_PRIMARY}
                fill={`url(#fillPlays-${uid})`}
                strokeWidth={2}
                dot={false}
              />
            ) : null}
            {!hidden.has("completions") ? (
              <Area
                type="monotone"
                dataKey="completions"
                stroke={CHART_SUCCESS}
                fill="transparent"
                strokeWidth={2}
                dot={false}
              />
            ) : null}
            {!hidden.has("leads") ? (
              <Area
                type="monotone"
                dataKey="leads"
                stroke="#a855f7"
                fill="transparent"
                strokeWidth={2}
                strokeDasharray="4 4"
                dot={false}
              />
            ) : null}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function TierBarChart({ data }: { data: { label: string; count: number }[] }) {
  if (data.every((d) => d.count === 0)) {
    return <p className="text-sm text-muted">No tier rewards in this range.</p>;
  }
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_MUTED} vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <Tooltip
            contentStyle={{
              borderRadius: 12,
              border: "1px solid rgb(var(--border))",
              background: "rgb(var(--card))",
            }}
          />
          <Bar dataKey="count" fill={CHART_PRIMARY} radius={[6, 6, 0, 0]} maxBarSize={48} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DevicePieChart({
  mobile,
  desktop,
}: {
  mobile: number;
  desktop: number;
}) {
  const [focus, setFocus] = useState<"all" | "mobile" | "desktop">("all");
  const total = mobile + desktop;
  const data = [
    { name: "Mobile", key: "mobile" as const, value: mobile },
    { name: "Desktop", key: "desktop" as const, value: desktop },
  ];

  if (total === 0) {
    return <p className="text-sm text-muted">No device data yet.</p>;
  }

  const displayTotal =
    focus === "mobile" ? mobile : focus === "desktop" ? desktop : total;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {(["all", "mobile", "desktop"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setFocus(key)}
            className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition-all ${
              focus === key
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card2 text-muted hover:text-foreground"
            }`}
          >
            {key === "all" ? "All devices" : key}
          </button>
        ))}
      </div>
      <div className="relative h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={52}
              outerRadius={78}
              paddingAngle={3}
              stroke="none"
            >
              {data.map((entry) => (
                <Cell
                  key={entry.key}
                  fill={entry.key === "mobile" ? CHART_PRIMARY : CHART_SECONDARY}
                  opacity={focus === "all" || focus === entry.key ? 1 : 0.2}
                />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                borderRadius: 12,
                border: "1px solid rgb(var(--border))",
                background: "rgb(var(--card))",
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center pb-6">
          <div className="text-center">
            <div className="font-display text-xl font-semibold tabular-nums">{displayTotal}</div>
            <div className="text-[10px] uppercase tracking-wide text-muted">
              {focus === "all" ? "Sessions" : focus}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ReferrerList({ rows }: { rows: ReferrerRow[] }) {
  const [copied, setCopied] = useState<string | null>(null);

  if (rows.length === 0) {
    return <p className="text-sm text-muted">No referrer data yet.</p>;
  }
  const max = Math.max(...rows.map((r) => r.count), 1);

  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.referrer}>
          <button
            type="button"
            className="w-full rounded-lg px-1 py-1 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              void copyToClipboard(r.referrer).then((ok) => {
                if (ok) {
                  setCopied(r.referrer);
                  window.setTimeout(() => setCopied(null), 1500);
                }
              });
            }}
          >
            <div className="mb-1 flex justify-between gap-2 text-sm">
              <span className="truncate font-medium">{r.referrer}</span>
              <span className="shrink-0 tabular-nums text-muted">
                {copied === r.referrer ? (
                  <span className="text-success">Copied</span>
                ) : (
                  r.count
                )}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
              <div
                className="h-full rounded-full bg-primary/80"
                style={{ width: `${Math.round((r.count / max) * 100)}%` }}
              />
            </div>
            <span className="mt-1 block text-[10px] text-muted">Click to copy hostname</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function formatLeadContact(row: LeadAnalyticsRow): string {
  if (row.email) return row.email;
  if (row.phone) return row.phone;
  return "—";
}

function formatLeadDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function LeadRow({
  row,
  showGame,
  copiedId,
  onCopy,
}: {
  row: LeadAnalyticsRow;
  showGame: boolean;
  copiedId: string | null;
  onCopy: (id: string, text: string) => void;
}) {
  const contact = formatLeadContact(row);
  const canCopy = contact !== "—";

  return (
    <tr
      className={`border-b border-border/50 transition-colors ${
        canCopy ? "cursor-pointer hover:bg-foreground/[0.03]" : ""
      } ${copiedId === row.id ? "bg-success/5" : ""}`}
      onClick={() => {
        if (canCopy) onCopy(row.id, contact);
      }}
      onKeyDown={(e) => {
        if (canCopy && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onCopy(row.id, contact);
        }
      }}
      tabIndex={canCopy ? 0 : undefined}
      role={canCopy ? "button" : undefined}
    >
      <td className="py-3 pr-4">
        <span className="font-medium">{contact}</span>
        {copiedId === row.id ? (
          <span className="ml-2 text-xs font-medium text-success">Copied</span>
        ) : canCopy ? (
          <span className="ml-2 text-[10px] text-muted">tap to copy</span>
        ) : null}
        {row.email && row.phone ? <div className="text-xs text-muted">{row.phone}</div> : null}
      </td>
      {showGame ? <td className="py-3 pr-4 text-muted">{row.gameName ?? "—"}</td> : null}
      <td className="whitespace-nowrap py-3 tabular-nums text-muted">
        {formatLeadDate(row.createdAt)}
      </td>
    </tr>
  );
}

export function LeadsTable({
  rows,
  showGame = false,
}: {
  rows: LeadAnalyticsRow[];
  showGame?: boolean;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function handleCopy(id: string, text: string) {
    void copyToClipboard(text).then((ok) => {
      if (ok) {
        setCopiedId(id);
        window.setTimeout(() => setCopiedId(null), 1500);
      }
    });
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border bg-card2 px-4 py-8 text-center text-sm text-muted">
        No leads captured in this range yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[400px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
            <th className="pb-3 pr-4 font-semibold">Email / phone</th>
            {showGame ? <th className="pb-3 pr-4 font-semibold">Game</th> : null}
            <th className="pb-3 font-semibold">Captured</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <LeadRow
              key={row.id}
              row={row}
              showGame={showGame}
              copiedId={copiedId}
              onCopy={handleCopy}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GameBreakdownTable({ rows }: { rows: GameAnalyticsSummary[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted">No games yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
            <th className="pb-3 pr-4 font-semibold">Game</th>
            <th className="pb-3 pr-4 font-semibold">Plays</th>
            <th className="pb-3 pr-4 font-semibold">Completion</th>
            <th className="pb-3 pr-4 font-semibold">Leads</th>
            <th className="pb-3 font-semibold">Coupons</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr
              key={g.gameId}
              className="border-b border-border/50 transition-colors hover:bg-foreground/[0.02]"
            >
              <td className="py-3 pr-4">
                <Link
                  href={`/games/${g.gameId}/analytics`}
                  className="font-medium text-primary hover:underline"
                >
                  {g.name}
                </Link>
                <div className="mt-0.5 text-xs capitalize text-muted">
                  {g.template.replace(/_/g, " ")} · {g.status}
                </div>
              </td>
              <td className="py-3 pr-4 tabular-nums">{g.plays}</td>
              <td className="py-3 pr-4 tabular-nums">{Math.round(g.completionRate * 100)}%</td>
              <td className="py-3 pr-4 tabular-nums">
                {g.leadsCaptured > 0 ? (
                  <button
                    type="button"
                    className="rounded-md px-1.5 py-0.5 font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => scrollToAnalyticsSection(ANALYTICS_SECTION.leads)}
                  >
                    {g.leadsCaptured}
                  </button>
                ) : (
                  g.leadsCaptured
                )}
              </td>
              <td className="py-3 tabular-nums">{g.couponsClaimed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
