"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AuthGate } from "@/components/AuthGate";
import { GameSubNav } from "@/components/GameSubNav";
import {
  AnalyticsLoadingSkeleton,
  AnalyticsPageHero,
  AnalyticsSection,
} from "@/components/analytics/AnalyticsSection";
import { ANALYTICS_SECTION } from "@/components/analytics/interaction";
import {
  AnalyticsRangePicker,
  rangeToQueryParam,
  type AnalyticsRangeDays,
} from "@/components/analytics/AnalyticsRangePicker";
import {
  DevicePieChart,
  FunnelChart,
  LeadsTable,
  MetricCard,
  ReferrerList,
  TierBarChart,
  TimeSeriesChart,
} from "@/components/analytics/charts";
import type { GameAnalytics } from "@/lib/analytics/types";

export default function GameAnalyticsPage() {
  return (
    <AuthGate
      title="Sign in to see analytics"
      description="These pages show one game's spec, stats and embed code. Sign in to the account that owns it."
    >
      <GameAnalyticsDashboard />
    </AuthGate>
  );
}

function GameAnalyticsDashboard() {
  const { id } = useParams<{ id: string }>();
  const [rangeDays, setRangeDays] = useState<AnalyticsRangeDays>(30);
  const [data, setData] = useState<GameAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [funnelFocus, setFunnelFocus] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    fetch(`/api/games/${id}/analytics?days=${rangeToQueryParam(rangeDays)}`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("Could not load analytics.");
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [id, rangeDays]);

  const subtitle = data
    ? `${data.meta.template.replace(/_/g, " ")} · ${data.meta.placement} · ${data.meta.status}${data.meta.slug ? ` · /${data.meta.slug}` : ""}`
    : undefined;

  return (
    <div className="space-y-8">
      <GameSubNav gameId={id} />

      <AnalyticsPageHero
        title={data?.meta.name ?? "Game analytics"}
        subtitle={subtitle}
        rangeControl={<AnalyticsRangePicker value={rangeDays} onChange={setRangeDays} />}
      />

      {error && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {!data && !error && <AnalyticsLoadingSkeleton />}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 lg:gap-4">
            <MetricCard
              label="Plays"
              value={String(data.plays)}
              tone="primary"
              scrollToSection={ANALYTICS_SECTION.funnel}
              onClick={() => setFunnelFocus("start")}
            />
            <MetricCard
              label="Completion rate"
              value={`${Math.round(data.completionRate * 100)}%`}
              tone="success"
              scrollToSection={ANALYTICS_SECTION.funnel}
              onClick={() => setFunnelFocus("complete")}
            />
            <MetricCard
              label="Avg score"
              value={String(Math.round(data.avgScore))}
              tone="secondary"
              scrollToSection={ANALYTICS_SECTION.funnel}
            />
            <MetricCard
              label="Replay rate"
              value={`${Math.round(data.replayRate * 100)}%`}
              tone="secondary"
              scrollToSection={ANALYTICS_SECTION.funnel}
            />
            <MetricCard
              label="Leads"
              value={String(data.leadsCaptured)}
              tone="warning"
              scrollToSection={ANALYTICS_SECTION.leads}
              onClick={() => setFunnelFocus("lead")}
            />
            <MetricCard
              label="Coupons copied"
              value={String(data.couponsClaimed)}
              tone="primary"
              scrollToSection={ANALYTICS_SECTION.rewards}
              onClick={() => setFunnelFocus("coupon")}
            />
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <AnalyticsSection
              sectionId={ANALYTICS_SECTION.funnel}
              title="Conversion funnel"
              description="Click a step to highlight it and jump to related data."
            >
              <FunnelChart
                steps={data.funnel}
                focusedStep={funnelFocus}
                onFocusStep={setFunnelFocus}
                stepScrollOverrides={{ coupon: ANALYTICS_SECTION.rewards }}
              />
            </AnalyticsSection>

            <AnalyticsSection
              sectionId={ANALYTICS_SECTION.timeline}
              title="Activity over time"
              description="Toggle series with the pills below the chart."
            >
              <TimeSeriesChart data={data.timeSeries} />
            </AnalyticsSection>
          </div>

          <div
            id={ANALYTICS_SECTION.rewards}
            className="scroll-mt-24 grid grid-cols-1 gap-6 lg:grid-cols-2"
          >
            <AnalyticsSection title="Rewards by tier" description="Earned tiers in this range.">
              <TierBarChart data={data.rewardsByTier} />
            </AnalyticsSection>

            <AnalyticsSection title="Coupon pools" description="Stock remaining per tier.">
              {data.couponTiers.length === 0 ? (
                <p className="text-sm text-muted">No coupon pools configured.</p>
              ) : (
                <ul className="space-y-3">
                  {data.couponTiers.map((t) => {
                    const usedPct =
                      t.total > 0 ? Math.round((t.claimed / t.total) * 100) : 0;
                    return (
                      <li key={t.tierIndex}>
                        <div className="mb-1 flex justify-between text-sm">
                          <span className="font-medium">Tier {t.tierIndex + 1}</span>
                          <span className="text-muted">
                            {t.claimed} claimed · {t.remaining} left
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
                          <div
                            className="h-full rounded-full bg-primary/80"
                            style={{ width: `${usedPct}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </AnalyticsSection>
          </div>

          <AnalyticsSection
            sectionId={ANALYTICS_SECTION.leads}
            title="Leads"
            description="Click a row to copy the email or phone."
          >
            <LeadsTable rows={data.leads} />
          </AnalyticsSection>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <AnalyticsSection
              sectionId={ANALYTICS_SECTION.devices}
              title="Devices"
              description="Filter the donut by device type."
            >
              <DevicePieChart mobile={data.deviceSplit.mobile} desktop={data.deviceSplit.desktop} />
              <p className="mt-4 rounded-lg bg-card2 px-3 py-2 text-xs text-muted">
                Completion rate — mobile{" "}
                <span className="font-medium text-foreground">
                  {Math.round(data.deviceSegment.completionRateMobile * 100)}%
                </span>
                , desktop{" "}
                <span className="font-medium text-foreground">
                  {Math.round(data.deviceSegment.completionRateDesktop * 100)}%
                </span>
              </p>
            </AnalyticsSection>

            <AnalyticsSection
              sectionId={ANALYTICS_SECTION.referrers}
              title="Top referrers"
              description="Click a hostname to copy it."
            >
              <ReferrerList rows={data.topReferrers} />
            </AnalyticsSection>
          </div>

          <AnalyticsSection
            title="Session quality"
            description="Timing and anti-abuse signals for completed plays."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-border bg-card2 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">
                  Avg session length
                </p>
                <p className="mt-2 font-display text-3xl font-semibold tabular-nums">
                  {Math.round(data.avgSessionSeconds)}
                  <span className="text-lg text-muted">s</span>
                </p>
                <p className="mt-1 text-xs text-muted">Completed plays only</p>
              </div>
              <div className="rounded-xl border border-border bg-card2 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">
                  Flagged plays
                </p>
                <p className="mt-2 font-display text-3xl font-semibold tabular-nums">
                  {data.suspiciousPlays}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Finished with a score but no tier — usually too fast or above the realistic score
                  ceiling.
                </p>
              </div>
            </div>
          </AnalyticsSection>
        </>
      )}
    </div>
  );
}
