/** DOM ids for scroll targets — keep in sync with AnalyticsSection `sectionId` props. */
export const ANALYTICS_SECTION = {
  funnel: "analytics-funnel",
  timeline: "analytics-timeline",
  leads: "analytics-leads",
  games: "analytics-games",
  devices: "analytics-devices",
  referrers: "analytics-referrers",
  rewards: "analytics-rewards",
} as const;

export type AnalyticsSectionId = (typeof ANALYTICS_SECTION)[keyof typeof ANALYTICS_SECTION];

export function scrollToAnalyticsSection(sectionId: string): void {
  const el = document.getElementById(sectionId);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.dataset.highlight = "true";
  window.setTimeout(() => {
    delete el.dataset.highlight;
  }, 1600);
}

/** Funnel step key → section to scroll when the step is clicked. */
export const FUNNEL_STEP_SCROLL: Record<string, AnalyticsSectionId> = {
  impression: ANALYTICS_SECTION.timeline,
  start: ANALYTICS_SECTION.timeline,
  complete: ANALYTICS_SECTION.timeline,
  tier: ANALYTICS_SECTION.funnel,
  reward: ANALYTICS_SECTION.funnel,
  coupon: ANALYTICS_SECTION.games,
  lead: ANALYTICS_SECTION.leads,
};

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}
