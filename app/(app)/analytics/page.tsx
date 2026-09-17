"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/AuthGate";
import {
  AnalyticsLoadingSkeleton,
  AnalyticsPageHero,
  AnalyticsSection,
} from "@/components/analytics/AnalyticsSection";
import {
  AnalyticsRangePicker,
  rangeToQueryParam,
  type AnalyticsRangeDays,
} from "@/components/analytics/AnalyticsRangePicker";
import { ANALYTICS_SECTION } from "@/components/analytics/interaction";
import {
  DevicePieChart,
  FunnelChart,
  GameBreakdownTable,
  LeadsTable,
  MetricCard,
  ReferrerList,
  TimeSeriesChart,
} from "@/components/analytics/charts";
import type { AccountAnalytics } from "@/lib/analytics/types";

export default function AccountAnalyticsPage() {
  return (
    <AuthGate title="Sign in to see analytics" description="Account-wide play and lead metrics.">
      <AccountAnalyticsDashboard />
    </AuthGate>
  );
}

function AccountAnalyticsDashboard() {
  const [rangeDays, setRangeDays] = useState<AnalyticsRangeDays>(30);
  const [data, setData] = useState<AccountAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [funnelFocus, setFunnelFocus] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    fetch(`/api/analytics/account?days=${rangeToQueryParam(rangeDays)}`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("Could not load analytics.");
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load."));
  }, [rangeDays]);

  const rangeControl = (
    <AnalyticsRangePicker value={rangeDays} onChange={setRangeDays} />
  );

  return (
    <div className="space-y-8">
      <AnalyticsPageHero
        title="Analytics"
        subtitle="Track impressions, plays, rewards, and leads across every published game. Click any metric or funnel step to jump to details."
        rangeControl={rangeControl}
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
              label="Impressions"
              value={String(data.impressions)}
              hint="Embed loaded"
              tone="secondary"
              scrollToSection={ANALYTICS_SECTION.timeline}
              onClick={() => setFunnelFocus("impression")}
            />
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
              scrollToSection={ANALYTICS_SECTION.games}
              onClick={() => setFunnelFocus("coupon")}
            />
            <MetricCard
              label="Replay rate"
              value={`${Math.round(data.replayRate * 100)}%`}
              tone="secondary"
              scrollToSection={ANALYTICS_SECTION.funnel}
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

          <AnalyticsSection
            sectionId={ANALYTICS_SECTION.leads}
            title="Leads"
            description="Click a row to copy the email or phone."
          >
            <LeadsTable rows={data.leads} showGame />
          </AnalyticsSection>

          <AnalyticsSection
            sectionId={ANALYTICS_SECTION.games}
            title="Performance by game"
            description="Open a game or click its lead count to scroll to leads."
          >
            <GameBreakdownTable rows={data.byGame} />
          </AnalyticsSection>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <AnalyticsSection
              sectionId={ANALYTICS_SECTION.devices}
              title="Devices"
              description="Filter the donut by device type."
            >
              <DevicePieChart mobile={data.deviceSplit.mobile} desktop={data.deviceSplit.desktop} />
            </AnalyticsSection>

            <AnalyticsSection
              sectionId={ANALYTICS_SECTION.referrers}
              title="Top referrers"
              description="Click a hostname to copy it."
            >
              <ReferrerList rows={data.topReferrers} />
            </AnalyticsSection>
          </div>
        </>
      )}
    </div>
  );
}
