// lib/engine/specRules.ts
//
// The single definition of "what is a valid editable GameSpec value".
//
// Three places need these rules: the editor panel (inline, per-keystroke),
// the PATCH route's schema (server-side, authoritative), and brain.ts (which
// validates what the AI layer produced). Before this file they each carried
// their own copy and had already drifted — the editor happily wrote reward
// tiers the generator would have dropped. Anything that lives here is a rule
// all three must agree on.
//
// CLIENT-SAFE BY CONSTRUCTION: no node builtins, no `sharp`, no filesystem,
// and only a type-only import from the shared contract. The editor imports
// this into a "use client" component, so a single value import of anything
// server-side here would break its bundle.
//
// Every message in this file is rendered verbatim to a merchant — they are
// product copy, not developer diagnostics.

import type { CouponTerms, GameCopy, RewardTier } from "@/lib/engine/types";

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/** Six-digit hex only. BrandKit colours are produced by the palette
 * extractor and by `<input type="color">`, both of which always emit this
 * exact form — accepting shorthand or `rgb()` would let a value through that
 * mount.ts writes straight into a canvas fillStyle. */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_RE.test(value);
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export interface CopyFieldRule {
  /** Merchant-facing field name used verbatim in error copy. */
  label: string;
  /** An empty value is rejected — the runtime has no fallback for it. */
  required: boolean;
  /** Hard cap, enforced by maxLength in the UI and by the server schema. */
  max: number;
}

/** Caps are chosen against what mount.ts actually renders, not against a
 * round number: `headline` is a clamp(18px,4vw,26px) h2, and the CTAs go
 * through makeButton's 10px/20px pill, which a long string turns into a
 * button wider than the card. */
export const COPY_RULES: Record<keyof GameCopy, CopyFieldRule> = {
  headline: { label: "Headline", required: true, max: 60 },
  subhead: { label: "Subhead", required: false, max: 120 },
  ctaStart: { label: "Start button", required: true, max: 24 },
  ctaReplay: { label: "Replay button", required: true, max: 24 },
  rewardIntro: { label: "Reward intro", required: false, max: 120 },
  emailPrompt: { label: "Email placeholder", required: true, max: 40 },
};

export function validateCopyField(
  field: keyof GameCopy,
  value: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const rule = COPY_RULES[field];
  const trimmed = value.trim();

  if (rule.required && trimmed.length === 0) {
    const message =
      field === "ctaStart" || field === "ctaReplay"
        ? `${rule.label} can't be empty — players would see a blank button.`
        : `${rule.label} can't be empty.`;
    return { ok: false, message };
  }

  if (trimmed.length > rule.max) {
    const over = trimmed.length - rule.max;
    return {
      ok: false,
      message: `${rule.label} is ${over} characters over the ${rule.max}-character limit.`,
    };
  }

  return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------------
// Reward tiers
// ---------------------------------------------------------------------------

export const PERCENT_OFF_MIN = 1;
export const PERCENT_OFF_MAX = 90;
export const REWARD_LABEL_MAX = 48;
export const REWARD_CODE_MAX = 32;

/** What a coupon code may contain after uppercasing. Deliberately narrow:
 * the value is shown on the end screen and typed into a checkout box by
 * hand, so spaces and punctuation that look alike are excluded. */
const REWARD_CODE_RE = /^[A-Z0-9._-]+$/;

export interface RewardTierDraft {
  minScore: number;
  label: string;
  percentOff: number | null;
  code?: string;
  coupon?: CouponTerms;
}

export type RewardTierField =
  | "minScore"
  | "label"
  | "percentOff"
  | "code"
  // Dotted so the editor can key an error to the exact coupon input; the
  // PATCH route turns these into paths like "rewards.1.coupon.offerUrl".
  | "coupon.terms"
  | "coupon.expiresAt"
  | "coupon.offerUrl";

export interface RewardTierIssue {
  field: RewardTierField;
  /** Merchant-facing, rendered verbatim under the offending input. */
  message: string;
}

export interface RewardTierContext {
  /** Ceiling for this game's template AND tuning. Omit for no upper bound. */
  maxScore?: number;
  /** Every other tier's minScore, for the duplicate-threshold check. */
  otherMinScores?: number[];
}

/** Rounds numbers, trims label, trims + uppercases code, drops an empty
 *  code to undefined. Never throws. Does NOT clamp — validate separately. */
export function normalizeRewardTier(draft: RewardTierDraft): RewardTier {
  // NaN -> 0 keeps the returned object JSON-safe (NaN serializes to null and
  // would reach the runtime as a broken threshold); validateRewardTier still
  // reports the unparseable input, so nothing is silently accepted.
  const minScore = Number.isNaN(draft.minScore) ? 0 : Math.round(draft.minScore);

  // `== null` is load-bearing: percentOff === null means "no discount, just a
  // thank-you" and is a different tier from 0% off. Only null/undefined may
  // collapse to null here.
  const percentOff = draft.percentOff == null ? null : Math.round(draft.percentOff);

  const code = draft.code?.trim().toUpperCase() || undefined;

  const tier: RewardTier = { minScore, label: draft.label.trim(), percentOff };
  if (code !== undefined) tier.code = code;
  // Dropped entirely when every field is blank, rather than stored as an
  // empty object: the runtime treats `coupon` being present as "there are
  // terms to render", and {} would reserve space for nothing.
  const coupon = normalizeCouponTerms(draft.coupon);
  if (coupon !== undefined) tier.coupon = coupon;
  return tier;
}

/** [] means valid. Runs against the NORMALIZED tier. */
export function validateRewardTier(
  draft: RewardTierDraft,
  ctx?: RewardTierContext,
): RewardTierIssue[] {
  const tier = normalizeRewardTier(draft);
  const issues: RewardTierIssue[] = [];
  const { maxScore, otherMinScores } = ctx ?? {};

  // Read finiteness off the draft, not the normalized tier: normalization
  // deliberately turns NaN into 0 so the object stays well-formed, which
  // would otherwise make "the merchant typed letters" look like "the
  // merchant asked for 0".
  if (!Number.isFinite(draft.minScore)) {
    issues.push({ field: "minScore", message: "Enter a number." });
  } else if (tier.minScore < 0) {
    issues.push({ field: "minScore", message: "Min score can't be negative." });
  } else if (maxScore !== undefined && tier.minScore >= maxScore) {
    issues.push({
      field: "minScore",
      message: `No player can reach this — the highest realistic score for this game is ${maxScore}.`,
    });
  } else if (otherMinScores?.includes(tier.minScore)) {
    // Both reward resolvers sort and take the last match, so a duplicate
    // threshold doesn't error anywhere — one of the two tiers just never
    // pays out. That silence is why it's rejected here.
    issues.push({
      field: "minScore",
      message: "Another tier already unlocks at this score.",
    });
  }

  for (const issue of validateCouponTerms(draft.coupon)) {
    issues.push({ field: `coupon.${issue.field}` as RewardTierField, message: issue.message });
  }

  if (tier.label.length === 0) {
    issues.push({
      field: "label",
      message: "Give this tier a label — players see it on the end screen.",
    });
  } else if (tier.label.length > REWARD_LABEL_MAX) {
    issues.push({
      field: "label",
      message: `Keep the label under ${REWARD_LABEL_MAX} characters.`,
    });
  }

  if (tier.percentOff !== null) {
    if (!Number.isFinite(tier.percentOff)) {
      issues.push({
        field: "percentOff",
        message: "Enter a number, or leave blank for a no-discount tier.",
      });
    } else if (tier.percentOff < PERCENT_OFF_MIN || tier.percentOff > PERCENT_OFF_MAX) {
      issues.push({
        field: "percentOff",
        message: `Discounts must be between ${PERCENT_OFF_MIN}% and ${PERCENT_OFF_MAX}%.`,
      });
    }
  }

  const code = tier.code;
  if (code !== undefined && (code.length > REWARD_CODE_MAX || !REWARD_CODE_RE.test(code))) {
    issues.push({
      field: "code",
      message: "Use letters, numbers, dots, dashes or underscores only.",
    });
  }

  return issues;
}

/** Per-index issues for a whole array; includes the duplicate check across
 *  the array. [] means the whole list is valid. */
export function validateRewardList(
  drafts: RewardTierDraft[],
  ctx?: { maxScore?: number },
): { index: number; issues: RewardTierIssue[] }[] {
  // Compare normalized thresholds: 40 and 40.2 are the same tier once
  // they're rounded, so the duplicate check has to run on the rounded values.
  const minScores = drafts.map((draft) => normalizeRewardTier(draft).minScore);

  const results: { index: number; issues: RewardTierIssue[] }[] = [];
  drafts.forEach((draft, index) => {
    const issues = validateRewardTier(draft, {
      maxScore: ctx?.maxScore,
      otherMinScores: minScores.filter((_, i) => i !== index),
    });
    if (issues.length > 0) results.push({ index, issues });
  });
  return results;
}

/** True when the list is empty, or its lowest minScore is exactly 0.
 *  This is brain.ts's invariant expressed as a predicate. */
export function hasBaselineTier(tiers: { minScore: number }[]): boolean {
  if (tiers.length === 0) return true;
  return Math.min(...tiers.map((tier) => tier.minScore)) === 0;
}

/** Threshold for a newly added tier that cannot collide with an existing
 *  one: 0 when the list is empty, else max(existing)+1 clamped below
 *  maxScore (or halfway between max(existing) and maxScore when there is
 *  headroom). */
export function suggestNextMinScore(
  existing: { minScore: number }[],
  maxScore?: number,
): number {
  if (existing.length === 0) return 0;
  const top = Math.max(...existing.map((tier) => tier.minScore));
  // Halfway only when there's real room; with 2 points or less of headroom
  // the midpoint rounds back onto `top` and collides with the tier we're
  // trying to sit above.
  if (maxScore !== undefined && maxScore - top > 2) return Math.round((top + maxScore) / 2);
  return top + 1;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Clamp rather than reject: mount.ts re-clamps tuning on every mount, so
 * refusing an out-of-range value would be stricter than the runtime itself.
 * NaN collapses to `min`, matching brain.ts's clampNumber. */
export function clampTuningValue(value: number, range: { min: number; max: number }): number {
  if (Number.isNaN(value)) return range.min;
  return Math.min(range.max, Math.max(range.min, value));
}

// ---------------------------------------------------------------------------
// Reward tier lookup
// ---------------------------------------------------------------------------

/**
 * Maps the SORTED tier index that lib/db/queries.ts#finishPlay writes into
 * `plays.tier_index` back to that tier's position in the spec's own
 * `rewards` array.
 *
 * This exists because the two indices are genuinely different numbers and
 * conflating them silently pays out the wrong tier. finishPlay sorts the
 * rewards by minScore and records the winner's index in the SORTED list;
 * coupon pools are keyed by the tier's position in the array the merchant
 * edits. For `[{min:0},{min:50}]` the two agree; for `[{min:50},{min:0}]`
 * they are swapped, and a merchant reordering tiers in the editor is enough
 * to trigger it.
 *
 * Returns -1 for a null/out-of-range input, which callers must read as "this
 * play earned nothing".
 *
 * The stored sorted-index semantics are deliberately left as they are:
 * changing them would silently rewrite the meaning of historical rows that
 * the stats dashboard already aggregates.
 */
export function originalTierIndexFromSortedIndex(
  rewards: RewardTier[],
  sortedIndex: number | null,
): number {
  if (sortedIndex === null || !Number.isInteger(sortedIndex) || sortedIndex < 0) return -1;

  const withIndex = rewards.map((tier, index) => ({ tier, index }));
  // Same comparator as finishPlay's, and Array.prototype.sort is specified
  // as stable, so equal minScores keep their original relative order in both
  // places — which is what makes this mapping exact rather than approximate.
  withIndex.sort((a, b) => a.tier.minScore - b.tier.minScore);

  const entry = withIndex[sortedIndex];
  return entry ? entry.index : -1;
}

// ---------------------------------------------------------------------------
// Coupon terms
// ---------------------------------------------------------------------------

export const COUPON_TERMS_MAX = 600;

export interface CouponTermsIssue {
  field: "terms" | "expiresAt" | "offerUrl";
  message: string;
}

/** Canonical, JSON-safe CouponTerms, or undefined when nothing was supplied. */
export function normalizeCouponTerms(draft: CouponTerms | undefined): CouponTerms | undefined {
  if (!draft) return undefined;
  const terms = draft.terms?.trim() || undefined;
  const expiresAt = draft.expiresAt?.trim() || undefined;
  const offerUrl = draft.offerUrl?.trim() || undefined;
  if (!terms && !expiresAt && !offerUrl) return undefined;

  const out: CouponTerms = {};
  if (terms) out.terms = terms;
  if (expiresAt) out.expiresAt = expiresAt;
  if (offerUrl) out.offerUrl = offerUrl;
  return out;
}

/** [] means valid. Messages are shown to the merchant verbatim. */
export function validateCouponTerms(draft: CouponTerms | undefined): CouponTermsIssue[] {
  const terms = normalizeCouponTerms(draft);
  if (!terms) return [];
  const issues: CouponTermsIssue[] = [];

  if (terms.terms && terms.terms.length > COUPON_TERMS_MAX) {
    issues.push({
      field: "terms",
      message: `Keep the terms under ${COUPON_TERMS_MAX} characters — players read this on a phone.`,
    });
  }

  if (terms.expiresAt !== undefined) {
    // Date-only (YYYY-MM-DD), not a full timestamp: an expiry is a calendar
    // date to a merchant, and accepting a timezone-bearing datetime here
    // invites "expired a day early" bugs for players in other zones.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(terms.expiresAt)) {
      issues.push({ field: "expiresAt", message: "Use a date in YYYY-MM-DD form." });
    } else if (Number.isNaN(Date.parse(`${terms.expiresAt}T00:00:00Z`))) {
      issues.push({ field: "expiresAt", message: "That isn't a real date." });
    }
  }

  if (terms.offerUrl !== undefined) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(terms.offerUrl);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      issues.push({ field: "offerUrl", message: "Enter a full link, starting with https://" });
    } else if (parsed.protocol !== "https:") {
      // The embed runs on https storefronts; an http link is a mixed-content
      // warning at best and blocked at worst.
      issues.push({ field: "offerUrl", message: "The offer link must start with https://" });
    }
  }

  return issues;
}

/**
 * True when this tier's coupon offer has passed its expiry date.
 *
 * Compared at END of the expiry day in UTC, so a coupon marked 2026-09-30 is
 * still valid throughout the 30th rather than dying at midnight UTC.
 */
export function isCouponExpired(terms: CouponTerms | undefined, now: Date = new Date()): boolean {
  const expiresAt = terms?.expiresAt;
  if (!expiresAt) return false;
  const endOfDay = Date.parse(`${expiresAt}T23:59:59.999Z`);
  if (Number.isNaN(endOfDay)) return false; // unparseable: don't block payouts
  return now.getTime() > endOfDay;
}
