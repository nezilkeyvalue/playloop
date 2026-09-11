// lib/engine/matcher.ts
//
// The matcher (build spec §10, capability schema §4): a PURE, deterministic
// function — AssetInventory x GameCapability[] -> MatchReport. No I/O, no
// sharp, no randomness. Every number it produces comes from fields the
// quality gate already computed.
//
//   roleScore     = fillRatio x meanAssetQuality
//                   x (1 + Σ prefersMet x weight)
//                   x (1 + Σ transformQualityDelta)
//   templateScore = Σ(roleScore x roleWeight) / Σ roleWeight
//
// A note on transformQualityDelta (documented limitation): this MVP's
// sprites.ts always runs cutout(flood)/trim/padSquare/resize, and shadow
// when the cutout isolated cleanly — those deltas are read back from the
// asset's own `quality.flags` (set by sprites.ts/quality.ts), so they're an
// honest account of what actually happened to that pixel buffer. Other
// transforms a role's capability lists (tint, cropAspect, blur, darken,
// outline) are not executed anywhere in this pipeline yet — they're the
// *declared* route for that role (future runtime/compose work), so their
// contribution to the score is the capability's stated qualityDelta, not a
// post-hoc pixel audit. cutout's "ml" mode is never reachable in this MVP
// (no ML cutout implemented — build spec §8), so cutout always scores as
// its "flood" mode wherever it's used, which every role that lists it also
// hard-requires `isolatable: true` for anyway.

import type {
  AssetInventory,
  CapabilityRole,
  FallbackKind,
  GameCapability,
  MatchGap,
  MatchReport,
  RawAsset,
  RoleAssignmentPlanStep,
  RolePreferences,
  RoleRequirements,
  TemplateId,
  TemplateMatch,
  TransformId,
} from "@/lib/engine/types";

const MIN_ASSETS_FOR_AUTO = Number(process.env.MIN_ASSETS_FOR_AUTO) || 4;

/** Transform catalogue (capability schema §3) — ms + qualityDelta per
 * transform. "cutout" here means its only implemented mode, flood. */
const TRANSFORM_CATALOGUE: Record<TransformId, { ms: number; qualityDelta: number }> = {
  cutout: { ms: 120, qualityDelta: 0.0 },
  trim: { ms: 30, qualityDelta: 0 },
  padSquare: { ms: 20, qualityDelta: 0 },
  resize: { ms: 40, qualityDelta: 0 },
  cropAspect: { ms: 40, qualityDelta: -0.1 },
  outline: { ms: 60, qualityDelta: 0.05 },
  shadow: { ms: 60, qualityDelta: 0.05 },
  tint: { ms: 30, qualityDelta: -0.05 },
  desaturate: { ms: 20, qualityDelta: -0.02 },
  blur: { ms: 50, qualityDelta: 0 },
  darken: { ms: 20, qualityDelta: 0 },
};

/** "Optional roles carry low weight" (build spec §10) — exact numbers are
 * an implementation detail the spec leaves open; these are ours, tuned so
 * a missing backdrop barely dents the score while missing collectibles
 * (a non-optional role with fallback "none") is fatal via eligibility, not
 * weight, since it blocks the template outright. */
const REQUIRED_ROLE_WEIGHT = 2;
const OPTIONAL_ROLE_WEIGHT = 0.5;

/** Flat per-criterion bonus for each `prefers` check a role's assigned
 * assets satisfy — the schema doesn't assign per-criterion weights, so we
 * use one small, documented constant applied uniformly. */
const PREFERS_WEIGHT = 0.1;

/** Neutral stand-ins used when a role is filled by its fallback instead of
 * real assets — a generated shape/gradient is "good enough", never as good
 * as a real, well-shot product photo. */
const FALLBACK_FILL_RATIO = 0.6;
const FALLBACK_ASSET_QUALITY = 0.6;

export function matchAssets(inventory: AssetInventory, capabilities: GameCapability[]): MatchReport {
  const results: TemplateMatch[] = capabilities.map((cap) => matchOneTemplate(inventory, cap));

  const eligible = results.filter((r) => r.eligible).sort((a, b) => b.score - a.score);
  const recommended: TemplateId[] = eligible.map((r) => r.template);

  // MIN_ASSETS_FOR_AUTO is a related floor, not a replacement for real
  // role-fit gating (build spec §18/§10): both conditions are enforced
  // independently. A handful of great assets that satisfy no template is
  // still "manual"; a large-but-unusable inventory is still "manual" too.
  const fallbackMode = eligible.length === 0 || inventory.assets.length < MIN_ASSETS_FOR_AUTO ? "manual" : null;

  return {
    version: 1,
    inventoryId: `inv_${hashInventory(inventory)}`,
    results: results.sort((a, b) => b.score - a.score),
    recommended,
    fallbackMode,
  };
}

function matchOneTemplate(inventory: AssetInventory, cap: GameCapability): TemplateMatch {
  const warnings: string[] = [];
  const gaps: MatchGap[] = [];

  let availableAssets = inventory.assets.filter((a) => assetMeetsDataRequirements(a, cap));
  if (availableAssets.length < inventory.assets.length) {
    warnings.push(
      `${inventory.assets.length - availableAssets.length} asset(s) lack required data (${cap.data.required.join(", ")}) for ${cap.name}`,
    );
  }

  const assignments: TemplateMatch["assignments"] = {};
  const plan: RoleAssignmentPlanStep[] = [];
  const roleScores: { score: number; weight: number }[] = [];
  let ineligible = false;
  let estimatedBuildMs = cap.cost.buildMs;

  for (const role of cap.roles) {
    const eligibleForRole = availableAssets.filter((a) => assetMeetsRequirements(a, role.requires));
    eligibleForRole.sort((a, b) => b.quality.score - a.quality.score);

    const wantCount = Math.min(role.count.max, eligibleForRole.length);
    const meetsMin = wantCount >= role.count.min;

    if (wantCount > 0 && meetsMin) {
      const chosen = eligibleForRole.slice(0, wantCount);
      assignments[role.id] = chosen.map((a) => a.id);
      availableAssets = availableAssets.filter((a) => !chosen.some((c) => c.id === a.id));

      const roleScore = scoreRealRole(role, chosen);
      roleScores.push({ score: roleScore, weight: roleWeight(role) });

      for (const asset of chosen) {
        plan.push(buildPlanStep(asset, role));
      }
      estimatedBuildMs += chosen.length * transformsMs(role.transforms);
    } else if (wantCount === 0 && role.count.min === 0) {
      // Genuinely empty and genuinely optional (e.g. no hazard images, and
      // none were required) — leave it out of the score entirely rather
      // than dragging templateScore down for a slot nobody needed filled.
      assignments[role.id] = [];
    } else if (role.fallback !== "none") {
      assignments[role.id] = { fallback: role.fallback };
      roleScores.push({ score: FALLBACK_FILL_RATIO * FALLBACK_ASSET_QUALITY, weight: roleWeight(role) });
      if (!role.optional) {
        warnings.push(`"${role.purpose}" used a ${describeFallback(role.fallback)} fallback — no suitable asset found`);
      } else {
        warnings.push(`No ${describeRoleSubject(role)} found — using a ${describeFallback(role.fallback)}`);
      }
      if (role.count.min > 0) {
        gaps.push({
          role: role.id,
          need: role.count.min,
          have: eligibleForRole.length,
          reason: `Only ${eligibleForRole.length} asset(s) met "${role.id}"'s requirements; needed ${role.count.min}`,
        });
      }
    } else {
      // fallback "none": this role MUST be filled by a real asset, or the
      // whole template is ineligible (capability schema §2: "Role must be
      // filled by a real asset, or the template is ineligible").
      gaps.push({
        role: role.id,
        need: role.count.min,
        have: eligibleForRole.length,
        reason: `Only ${eligibleForRole.length} asset(s) passed the gate for "${role.id}"; needed ${role.count.min}, and this role has no fallback`,
      });
      if (!role.optional) ineligible = true;
    }
  }

  const totalWeight = roleScores.reduce((sum, r) => sum + r.weight, 0);
  // An ineligible template's score is meaningless for ranking (capability
  // schema §4's own example shows an ineligible template scored 0.0) —
  // don't let a well-filled optional role make a template that's missing a
  // hard-required role look like a viable, nearly-eligible option.
  const score = ineligible
    ? 0
    : totalWeight > 0
      ? roleScores.reduce((sum, r) => sum + r.score * r.weight, 0) / totalWeight
      : 0;

  return {
    template: cap.id,
    eligible: !ineligible,
    score: Number(clamp(score, 0, 1).toFixed(3)),
    assignments,
    plan,
    gaps,
    warnings,
    estimatedBuildMs,
  };
}

// ---------------------------------------------------------------------------
// Per-asset requirement / preference checks
// ---------------------------------------------------------------------------

function assetMeetsDataRequirements(asset: RawAsset, cap: GameCapability): boolean {
  for (const field of cap.data.required) {
    if (field === "priceMinor" && asset.data?.priceMinor === undefined) return false;
    if (field === "name" && !asset.data?.name) return false;
    if (field === "category" && !asset.data?.category) return false;
    if (field === "sku" && !asset.data?.sku) return false;
  }
  return true;
}

function assetMeetsRequirements(asset: RawAsset, req: RoleRequirements): boolean {
  if (req.subjectTypeIn && !req.subjectTypeIn.includes(asset.content.subjectType)) return false;
  if (req.isolatable !== undefined && asset.background.isolatable !== req.isolatable) return false;
  if (req.minShortEdge !== undefined) {
    const shortEdge = Math.min(asset.pixels.width, asset.pixels.height);
    if (shortEdge < req.minShortEdge) return false;
  }
  if (req.aspectRange) {
    const [min, max] = req.aspectRange;
    if (asset.pixels.aspect < min || asset.pixels.aspect > max) return false;
  }
  if (req.maxTextDensity !== undefined && asset.content.textDensity > req.maxTextDensity) return false;
  if (req.maxSubjectCount !== undefined && asset.content.subjectCount > req.maxSubjectCount) return false;
  return true;
}

function scoreRealRole(role: CapabilityRole, chosen: RawAsset[]): number {
  const fillRatio = clamp(chosen.length / role.count.ideal, 0, 1);
  const meanAssetQuality = mean(chosen.map((a) => a.quality.score));

  const prefersMetCount = countPrefersMet(role.prefers, chosen);
  const prefersTerm = 1 + prefersMetCount * PREFERS_WEIGHT;

  const transformDelta = sumTransformDeltas(role, chosen);
  const transformTerm = 1 + transformDelta;

  return fillRatio * meanAssetQuality * prefersTerm * transformTerm;
}

function countPrefersMet(prefers: RolePreferences | undefined, chosen: RawAsset[]): number {
  if (!prefers || chosen.length === 0) return 0;
  let met = 0;

  if (prefers.distinctPhash) {
    const allDistinct = chosen.every((a, i) =>
      chosen.every((b, j) => i === j || !a.phash || !b.phash || hammingDistanceSafe(a.phash, b.phash) >= 6),
    );
    if (allDistinct) met += 1;
  }

  if (prefers.coverageRange) {
    const [min, max] = prefers.coverageRange;
    const covered = chosen.filter((a) => a.alpha.coverage !== null);
    const meanCoverage = covered.length > 0 ? mean(covered.map((a) => a.alpha.coverage as number)) : null;
    if (meanCoverage !== null && meanCoverage >= min && meanCoverage <= max) met += 1;
  }

  if (prefers.aspectRange) {
    const [min, max] = prefers.aspectRange;
    const inRange = chosen.filter((a) => a.pixels.aspect >= min && a.pixels.aspect <= max).length;
    if (inRange / chosen.length >= 0.75) met += 1;
  }

  if (prefers.uniformScale) {
    const aspects = chosen.map((a) => a.pixels.aspect);
    const spread = Math.max(...aspects) - Math.min(...aspects);
    if (spread <= 0.5) met += 1;
  }

  if (prefers.contrastAgainst) {
    // "stage.background" isn't finalized until compose.ts; use the
    // low_stage_contrast flag quality.ts already computed against its best
    // guess as a proxy rather than re-deriving it here (matcher stays pure
    // over already-computed fields).
    const goodContrast = chosen.filter((a) => !a.quality.flags.includes("low_stage_contrast")).length;
    if (goodContrast / chosen.length >= 0.75) met += 1;
  }

  return met;
}

function hammingDistanceSafe(a: string, b: string): number {
  // Local, dependency-free re-implementation avoided — reuse cutout.ts's
  // hammingDistance via a thin import would create a sharp-adjacent import
  // in a file that must stay pure/Edge-safe-in-principle; inlined instead.
  const len = Math.max(a.length, b.length);
  let distance = 0;
  for (let i = 0; i < len; i++) {
    const x = Number.parseInt(a[i] ?? "0", 16) || 0;
    const y = Number.parseInt(b[i] ?? "0", 16) || 0;
    let xor = x ^ y;
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

function sumTransformDeltas(role: CapabilityRole, chosen: RawAsset[]): number {
  let total = 0;
  for (const transformId of role.transforms) {
    if (transformId === "shadow") {
      // Real signal: only counted for assets sprites.ts actually shadowed.
      const shadowedFraction =
        chosen.length > 0 ? chosen.filter((a) => a.quality.flags.includes("transform:shadow")).length / chosen.length : 0;
      total += TRANSFORM_CATALOGUE.shadow.qualityDelta * shadowedFraction;
    } else {
      total += TRANSFORM_CATALOGUE[transformId].qualityDelta;
    }
  }
  return total;
}

function buildPlanStep(asset: RawAsset, role: CapabilityRole): RoleAssignmentPlanStep {
  const steps = role.transforms.map((t) => formatTransformStep(t));
  const estimatedMs = transformsMs(role.transforms);
  const delta = sumTransformDeltas(role, [asset]);
  const confidence = clamp(asset.quality.score * (1 + delta), 0, 1);
  return { assetId: asset.id, role: role.id, steps, estimatedMs, confidence: Number(confidence.toFixed(3)) };
}

function formatTransformStep(id: TransformId): string {
  if (id === "cutout") return "cutout:flood";
  if (id === "resize") return `resize:${Number(process.env.SPRITE_SIZE) || 256}`;
  return id;
}

function transformsMs(transforms: TransformId[]): number {
  return transforms.reduce((sum, t) => sum + TRANSFORM_CATALOGUE[t].ms, 0);
}

function roleWeight(role: CapabilityRole): number {
  return role.optional ? OPTIONAL_ROLE_WEIGHT : REQUIRED_ROLE_WEIGHT;
}

function describeFallback(fallback: FallbackKind): string {
  switch (fallback) {
    case "generatedShape":
      return "generated shape";
    case "brandGradient":
      return "brand gradient backdrop";
    case "logo":
      return "logo";
    case "solid":
      return "solid colour";
    default:
      return "fallback";
  }
}

function describeRoleSubject(role: CapabilityRole): string {
  const types = role.requires.subjectTypeIn;
  if (types && types.length > 0) return `a ${types.join("/")} image`;
  return "a suitable image";
}

function mean(nums: number[]): number {
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Deterministic id for a MatchReport tying it back to this inventory —
 * not a cryptographic hash, just stable enough to spot "same inventory,
 * same report" across a demo/dev cycle without pulling in a uuid/nanoid
 * dependency for a non-persisted, purely informational id. */
function hashInventory(inventory: AssetInventory): string {
  const basis = `${inventory.source.url ?? ""}|${inventory.assets.length}|${inventory.assets.map((a) => a.id).join(",")}`;
  let h = 0;
  for (let i = 0; i < basis.length; i++) {
    h = (h * 31 + basis.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
