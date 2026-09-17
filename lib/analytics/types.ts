// lib/analytics/types.ts — owner-facing analytics DTOs (not GameSpec contract).

import type { AnalyticsEvent, CouponTierStats, GameStatus, TemplateId } from "@/lib/engine/types";
import type { Placement } from "@/lib/engine/types";

/** Persisted row for game_analytics_events / dev JSON store. */
export interface GameAnalyticsEventRecord {
  id: string;
  gameId: string;
  playId: string | null;
  event: AnalyticsEvent;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface AnalyticsDateRange {
  from: string | null;
  to: string | null;
}

export interface FunnelStep {
  key: string;
  label: string;
  count: number;
  rateFromPrevious: number | null;
}

export interface TimeSeriesPoint {
  date: string;
  plays: number;
  completions: number;
  leads: number;
  impressions: number;
}

export interface ScoreBucket {
  label: string;
  count: number;
}

export interface ReferrerRow {
  referrer: string;
  count: number;
}

/** Owner-facing lead row for analytics (PII — never expose outside owner APIs). */
export interface LeadAnalyticsRow {
  id: string;
  gameId: string;
  gameName?: string;
  email: string | null;
  phone: string | null;
  createdAt: string;
}

export interface DeviceSegment {
  mobile: number;
  desktop: number;
  completionRateMobile: number;
  completionRateDesktop: number;
}

export interface GameAnalyticsMeta {
  gameId: string;
  name: string;
  slug: string | null;
  template: TemplateId;
  placement: Placement;
  status: GameStatus;
  range: AnalyticsDateRange;
}

/** Legacy subset returned by GET /api/games/:id/stats */
export interface GameStatsLegacy {
  plays: number;
  completionRate: number;
  avgScore: number;
  replayRate: number;
  rewardsByTier: { label: string; count: number }[];
  leadsCaptured: number;
  deviceSplit: { mobile: number; desktop: number };
  topReferrers: ReferrerRow[];
}

export interface GameAnalytics extends GameStatsLegacy {
  meta: GameAnalyticsMeta;
  funnel: FunnelStep[];
  timeSeries: TimeSeriesPoint[];
  avgSessionSeconds: number;
  scoreHistogram: ScoreBucket[];
  couponTiers: CouponTierStats[];
  couponsClaimed: number;
  suspiciousPlays: number;
  deviceSegment: DeviceSegment;
  leads: LeadAnalyticsRow[];
}

export interface GameAnalyticsSummary {
  gameId: string;
  name: string;
  slug: string | null;
  status: GameStatus;
  template: TemplateId;
  plays: number;
  completionRate: number;
  leadsCaptured: number;
  couponsClaimed: number;
}

export interface AccountAnalytics {
  range: AnalyticsDateRange;
  plays: number;
  completionRate: number;
  avgScore: number;
  replayRate: number;
  leadsCaptured: number;
  couponsClaimed: number;
  impressions: number;
  funnel: FunnelStep[];
  timeSeries: TimeSeriesPoint[];
  deviceSplit: { mobile: number; desktop: number };
  topReferrers: ReferrerRow[];
  byGame: GameAnalyticsSummary[];
  leads: LeadAnalyticsRow[];
}

export type AnalyticsDaysParam = number | "all";

export function parseAnalyticsDays(raw: string | null): AnalyticsDaysParam {
  if (!raw || raw === "all") return "all";
  const n = Number.parseInt(raw, 10);
  if (n === 7 || n === 30 || n === 90) return n;
  return 30;
}

export function analyticsRangeFromDays(days: AnalyticsDaysParam): AnalyticsDateRange {
  if (days === "all") return { from: null, to: null };
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function inAnalyticsRange(iso: string, range: AnalyticsDateRange): boolean {
  if (!range.from && !range.to) return true;
  const t = new Date(iso).getTime();
  if (range.from && t < new Date(range.from).getTime()) return false;
  if (range.to && t > new Date(range.to).getTime()) return false;
  return true;
}
