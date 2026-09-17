// lib/analytics/aggregate.ts — pure aggregation over plays, leads, events, coupons.

import type { CouponTierStats, GameRecord, PlayRecord, RewardTier } from "@/lib/engine/types";
import type { LeadRecord } from "@/lib/engine/types";
import type {
  AccountAnalytics,
  AnalyticsDateRange,
  DeviceSegment,
  FunnelStep,
  GameAnalytics,
  GameAnalyticsEventRecord,
  GameAnalyticsSummary,
  GameStatsLegacy,
  LeadAnalyticsRow,
  ReferrerRow,
  ScoreBucket,
  TimeSeriesPoint,
} from "@/lib/analytics/types";

export function referrerHost(referrer: string | null): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname;
  } catch {
    return referrer.slice(0, 120);
  }
}

function topReferrersFromPlays(plays: PlayRecord[], limit = 10): ReferrerRow[] {
  const counts = new Map<string, number>();
  for (const p of plays) {
    const host = referrerHost(p.referrer);
    if (!host) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([referrer, count]) => ({ referrer, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function deviceSplitFromPlays(plays: PlayRecord[]): { mobile: number; desktop: number } {
  const split = { mobile: 0, desktop: 0 };
  for (const p of plays) {
    if (p.device === "mobile") split.mobile += 1;
    else if (p.device === "desktop") split.desktop += 1;
  }
  return split;
}

function deviceSegmentFromPlays(plays: PlayRecord[]): DeviceSegment {
  const mobilePlays = plays.filter((p) => p.device === "mobile");
  const desktopPlays = plays.filter((p) => p.device === "desktop");
  const mobileFinished = mobilePlays.filter((p) => p.finishedAt !== null);
  const desktopFinished = desktopPlays.filter((p) => p.finishedAt !== null);
  return {
    mobile: mobilePlays.length,
    desktop: desktopPlays.length,
    completionRateMobile:
      mobilePlays.length > 0 ? mobileFinished.length / mobilePlays.length : 0,
    completionRateDesktop:
      desktopPlays.length > 0 ? desktopFinished.length / desktopPlays.length : 0,
  };
}

function rewardsByTierFromPlays(
  plays: PlayRecord[],
  rewards: RewardTier[],
): { label: string; count: number }[] {
  const finished = plays.filter((p) => p.finishedAt !== null);
  const tierCounts = new Map<number, number>();
  for (const p of finished) {
    if (p.tierIndex !== null && p.tierIndex >= 0) {
      tierCounts.set(p.tierIndex, (tierCounts.get(p.tierIndex) ?? 0) + 1);
    }
  }
  const sortedRewards = [...rewards].sort((a, b) => a.minScore - b.minScore);
  return sortedRewards.map((tier, idx) => ({
    label: tier.label,
    count: tierCounts.get(idx) ?? 0,
  }));
}

function scoreHistogramFromPlays(plays: PlayRecord[]): ScoreBucket[] {
  const buckets: ScoreBucket[] = [
    { label: "0", count: 0 },
    { label: "1–25", count: 0 },
    { label: "26–50", count: 0 },
    { label: "51–75", count: 0 },
    { label: "76–100", count: 0 },
    { label: "100+", count: 0 },
  ];
  for (const p of plays) {
    if (p.finishedAt === null || p.score === null) continue;
    const s = p.score;
    if (s <= 0) buckets[0]!.count += 1;
    else if (s <= 25) buckets[1]!.count += 1;
    else if (s <= 50) buckets[2]!.count += 1;
    else if (s <= 75) buckets[3]!.count += 1;
    else if (s <= 100) buckets[4]!.count += 1;
    else buckets[5]!.count += 1;
  }
  return buckets;
}

function avgSessionSeconds(plays: PlayRecord[]): number {
  const durations: number[] = [];
  for (const p of plays) {
    if (!p.finishedAt) continue;
    const sec = (new Date(p.finishedAt).getTime() - new Date(p.startedAt).getTime()) / 1000;
    if (sec >= 0 && Number.isFinite(sec)) durations.push(sec);
  }
  if (durations.length === 0) return 0;
  return durations.reduce((a, b) => a + b, 0) / durations.length;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function buildTimeSeries(
  plays: PlayRecord[],
  leads: LeadRecord[],
  events: GameAnalyticsEventRecord[],
): TimeSeriesPoint[] {
  const map = new Map<string, TimeSeriesPoint>();

  function ensure(date: string): TimeSeriesPoint {
    let row = map.get(date);
    if (!row) {
      row = { date, plays: 0, completions: 0, leads: 0, impressions: 0 };
      map.set(date, row);
    }
    return row;
  }

  for (const p of plays) {
    const row = ensure(dayKey(p.startedAt));
    row.plays += 1;
    if (p.finishedAt) ensure(dayKey(p.finishedAt)).completions += 1;
  }
  for (const l of leads) {
    ensure(dayKey(l.createdAt)).leads += 1;
  }
  for (const e of events) {
    if (e.event === "impression") ensure(dayKey(e.createdAt)).impressions += 1;
  }

  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, v]) => v);
}

function distinctPlayIds(events: GameAnalyticsEventRecord[], event: string): number {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.event !== event || !e.playId) continue;
    ids.add(e.playId);
  }
  return ids.size;
}

function distinctCouponCopyPlays(events: GameAnalyticsEventRecord[]): number {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.event !== "reward_revealed" || !e.playId) continue;
    if (e.detail?.coupon === "claimed") ids.add(e.playId);
  }
  return ids.size;
}

export function buildFunnel(input: {
  plays: PlayRecord[];
  leads: LeadRecord[];
  events: GameAnalyticsEventRecord[];
  claimedPlayIds: Set<string>;
}): FunnelStep[] {
  const { plays, leads, events, claimedPlayIds } = input;
  const impressions = events.filter((e) => e.event === "impression").length;
  const starts = plays.length;
  const completes = plays.filter((p) => p.finishedAt !== null).length;
  const tierEarned = plays.filter(
    (p) => p.finishedAt !== null && p.tierIndex !== null && p.tierIndex >= 0,
  ).length;
  const rewardRevealed = distinctPlayIds(events, "reward_revealed");
  const couponCopied = Math.max(distinctCouponCopyPlays(events), claimedPlayIds.size);
  const leadCount = leads.length;

  const steps: { key: string; label: string; count: number }[] = [
    { key: "impression", label: "Impressions", count: impressions },
    { key: "start", label: "Starts", count: starts },
    { key: "complete", label: "Completes", count: completes },
    { key: "tier", label: "Tier earned", count: tierEarned },
    { key: "reward", label: "Reward shown", count: rewardRevealed },
    { key: "coupon", label: "Coupon copied", count: couponCopied },
    { key: "lead", label: "Leads", count: leadCount },
  ];

  return steps.map((step, idx) => {
    const prev = idx > 0 ? steps[idx - 1]!.count : null;
    const rateFromPrevious =
      prev !== null && prev > 0 ? step.count / prev : prev === 0 ? 0 : null;
    return { ...step, rateFromPrevious };
  });
}

export function leadRowsFromRecords(
  leads: LeadRecord[],
  gameNameById?: Map<string, string>,
): LeadAnalyticsRow[] {
  return [...leads]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((l) => ({
      id: l.id,
      gameId: l.gameId,
      gameName: gameNameById?.get(l.gameId),
      email: l.email,
      phone: l.phone,
      createdAt: l.createdAt,
    }));
}

function legacyStatsFromPlays(
  plays: PlayRecord[],
  leads: LeadRecord[],
  rewards: RewardTier[],
): GameStatsLegacy {
  const totalPlays = plays.length;
  const finished = plays.filter((p) => p.finishedAt !== null);
  const completionRate = totalPlays > 0 ? finished.length / totalPlays : 0;

  const scored = finished.filter((p) => p.score !== null) as (PlayRecord & { score: number })[];
  const avgScore =
    scored.length > 0 ? scored.reduce((sum, p) => sum + p.score, 0) / scored.length : 0;

  const replays = plays.filter((p) => p.replayOf !== null);
  const replayRate = totalPlays > 0 ? replays.length / totalPlays : 0;

  return {
    plays: totalPlays,
    completionRate,
    avgScore,
    replayRate,
    rewardsByTier: rewardsByTierFromPlays(plays, rewards),
    leadsCaptured: leads.length,
    deviceSplit: deviceSplitFromPlays(plays),
    topReferrers: topReferrersFromPlays(plays),
  };
}

export function buildGameAnalytics(input: {
  game: GameRecord;
  range: AnalyticsDateRange;
  plays: PlayRecord[];
  leads: LeadRecord[];
  events: GameAnalyticsEventRecord[];
  couponTiers: CouponTierStats[];
  claimedPlayIds: Set<string>;
}): GameAnalytics {
  const { game, range, plays, leads, events, couponTiers, claimedPlayIds } = input;
  const legacy = legacyStatsFromPlays(plays, leads, game.spec.rewards);
  const finished = plays.filter((p) => p.finishedAt !== null);
  const suspiciousPlays = finished.filter(
    (p) => p.tierIndex === null && p.score !== null && p.score > 0,
  ).length;

  return {
    ...legacy,
    meta: {
      gameId: game.id,
      name: game.name,
      slug: game.slug,
      template: game.spec.template,
      placement: game.placement,
      status: game.status,
      range,
    },
    funnel: buildFunnel({ plays, leads, events, claimedPlayIds }),
    timeSeries: buildTimeSeries(plays, leads, events),
    avgSessionSeconds: avgSessionSeconds(plays),
    scoreHistogram: scoreHistogramFromPlays(plays),
    couponTiers,
    couponsClaimed: claimedPlayIds.size,
    suspiciousPlays,
    deviceSegment: deviceSegmentFromPlays(plays),
    leads: leadRowsFromRecords(leads),
  };
}

export function buildAccountAnalytics(input: {
  range: AnalyticsDateRange;
  games: GameRecord[];
  plays: PlayRecord[];
  leads: LeadRecord[];
  events: GameAnalyticsEventRecord[];
  claimedByGame: Map<string, Set<string>>;
}): AccountAnalytics {
  const { range, games, plays, leads, events, claimedByGame } = input;
  const allClaimed = new Set<string>();
  for (const set of claimedByGame.values()) {
    for (const id of set) allClaimed.add(id);
  }

  const legacy = legacyStatsFromPlays(
    plays,
    leads,
    games[0]?.spec.rewards ?? [],
  );

  const byGame: GameAnalyticsSummary[] = games.map((g) => {
    const gPlays = plays.filter((p) => p.gameId === g.id);
    const gLeads = leads.filter((l) => l.gameId === g.id);
    const gLegacy = legacyStatsFromPlays(gPlays, gLeads, g.spec.rewards);
    const claimed = claimedByGame.get(g.id)?.size ?? 0;
    return {
      gameId: g.id,
      name: g.name,
      slug: g.slug,
      status: g.status,
      template: g.spec.template,
      plays: gLegacy.plays,
      completionRate: gLegacy.completionRate,
      leadsCaptured: gLegacy.leadsCaptured,
      couponsClaimed: claimed,
    };
  });

  byGame.sort((a, b) => b.plays - a.plays);

  const gameNameById = new Map(games.map((g) => [g.id, g.name]));

  return {
    range,
    plays: legacy.plays,
    completionRate: legacy.completionRate,
    avgScore: legacy.avgScore,
    replayRate: legacy.replayRate,
    leadsCaptured: legacy.leadsCaptured,
    couponsClaimed: allClaimed.size,
    impressions: events.filter((e) => e.event === "impression").length,
    funnel: buildFunnel({ plays, leads, events, claimedPlayIds: allClaimed }),
    timeSeries: buildTimeSeries(plays, leads, events),
    deviceSplit: legacy.deviceSplit,
    topReferrers: topReferrersFromPlays(plays),
    byGame,
    leads: leadRowsFromRecords(leads, gameNameById),
  };
}
