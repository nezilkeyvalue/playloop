// lib/runtime/reward.ts
//
// Score → tier lookup against GameSpec.rewards, plus the reveal sequencing
// (an animated count-up before the tier is shown) used by mount.ts's reward
// screen. Build spec §1 "The reward mechanic" / §5.1 RewardTier.

import type { RewardTier } from "@/lib/engine/types";

export interface ResolvedReward {
  tier: RewardTier;
  /** Index into the *original* (unsorted) rewards array, or -1 if the spec
   * declared no reward tiers at all (defensive — should not happen for a
   * valid GameSpec, but the runtime must not crash on a malformed fixture). */
  tierIndex: number;
}

const NO_REWARD_FALLBACK: RewardTier = {
  minScore: 0,
  label: "Thanks for playing",
  percentOff: null,
};

/**
 * Highest tier whose `minScore` the score clears. Tiers need not arrive
 * sorted (nothing in GameSpec guarantees order), so this sorts a copy.
 */
export function resolveReward(score: number, rewards: RewardTier[]): ResolvedReward {
  if (rewards.length === 0) {
    return { tier: NO_REWARD_FALLBACK, tierIndex: -1 };
  }

  const withIndex = rewards.map((tier, index) => ({ tier, index }));
  withIndex.sort((a, b) => a.tier.minScore - b.tier.minScore);

  const first = withIndex[0];
  if (!first) {
    // Unreachable — rewards.length > 0 here — but keeps this function
    // total under strict/noUncheckedIndexedAccess without a non-null
    // assertion.
    return { tier: NO_REWARD_FALLBACK, tierIndex: -1 };
  }

  let best = first;
  for (const entry of withIndex) {
    if (score >= entry.tier.minScore) best = entry;
  }

  return { tier: best.tier, tierIndex: best.index };
}

/**
 * Animates a numeric value from `from` to `to` over `durationMs`, calling
 * `onTick` every frame — used to count the score up before revealing the
 * reward tier, per the "earned, not handed" framing in build spec §1.
 * Resolves once the animation completes. Safe to await; never rejects.
 */
export function animateCountUp(
  from: number,
  to: number,
  durationMs: number,
  onTick: (value: number) => void,
): Promise<void> {
  return new Promise((resolve) => {
    if (durationMs <= 0 || from === to || typeof requestAnimationFrame === "undefined") {
      onTick(to);
      resolve();
      return;
    }

    const start = typeof performance !== "undefined" ? performance.now() : Date.now();

    function step(now: number) {
      const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
      void now;
      const t = Math.min(1, elapsed / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      onTick(Math.round(from + (to - from) * eased));
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        resolve();
      }
    }

    requestAnimationFrame(step);
  });
}
