// lib/engine/compose.ts
//
// Builds the final GameSpec (build spec §5.1) from the matcher's role
// assignments and the AI layer's copy/rewards/tuning. Pure data-shaping —
// no image processing (sprites are already finalized by sprites.ts by the
// time this runs) and no I/O.

import { nanoid } from "nanoid";
import type {
  AssetInventory,
  BrainResponse,
  GameSpec,
  MatchReport,
  Placement,
  ProcessedAsset,
  RawAsset,
  RewardTier,
} from "@/lib/engine/types";
import { getCapability } from "@/lib/capabilities";
import { forceContrast, luminanceOfHex, saturationOfHex } from "./palette";

/** MVP scope (build spec §19 "Out"): no ad-platform export yet, even
 * though the capability schema already declares "ad" placement
 * constraints for Horizon 3. Never surface it as a buildable placement. */
const MVP_PLACEMENTS: Placement[] = ["section", "fullpage", "modal"];

const STAGE_BACKGROUND = "#FFFFFF"; // matches quality.ts's assumedStageBackground default
const DEFAULT_ACCENT = "#4F46E5"; // used only when no usable colour survived extraction
const DEFAULT_FOREGROUND = "#111827";
const DEFAULT_DURATION_SECONDS = 40;

export function compose(
  inventory: AssetInventory,
  match: MatchReport,
  brain: BrainResponse,
  mode: "auto" | "manual",
): GameSpec {
  const templateMatch = match.results.find((r) => r.template === brain.template);
  const cap = getCapability(brain.template);

  const assetsById = new Map(inventory.assets.map((a) => [a.id, a]));
  const usableIds = new Set(brain.usableAssetIds ?? inventory.assets.filter((a) => a.quality.score > 0).map((a) => a.id));

  const warnings: string[] = [...(templateMatch?.warnings ?? [])];
  for (const gap of templateMatch?.gaps ?? []) {
    warnings.push(`${gap.role}: needed ${gap.need}, had ${gap.have} (${gap.reason})`);
  }

  const roles = buildRoles(templateMatch?.assignments, usableIds, warnings);
  const assets = buildProcessedAssets(inventory.assets, usableIds);

  const brand = buildBrandKit(inventory, assetsById);
  const rewards = buildRewards(brain.rewards);
  const durationSeconds =
    (typeof brain.tuning.durationSec === "number" ? brain.tuning.durationSec : undefined) ??
    cap?.tuning.durationSec?.default ??
    DEFAULT_DURATION_SECONDS;

  const supportedPlacements: Placement[] = cap
    ? MVP_PLACEMENTS.filter((p) => Boolean(cap.placements[p]))
    : ["section"];
  const placements: Placement[] = supportedPlacements.length > 0 ? supportedPlacements : ["section"];

  return {
    id: `game_${nanoid(10)}`,
    version: 1,
    template: brain.template,
    placements,
    brand,
    copy: brain.copy,
    assets,
    roles,
    rewards,
    durationSeconds,
    tuning: brain.tuning,
    meta: {
      sourceUrl: inventory.source.url,
      mode,
      generatedAt: new Date().toISOString(),
      warnings,
    },
  };
}

function buildRoles(
  assignments: Record<string, string[] | { fallback: string } | string> | undefined,
  usableIds: Set<string>,
  warnings: string[],
): GameSpec["roles"] {
  const roles: GameSpec["roles"] = {};
  if (!assignments) return roles;

  for (const [roleId, value] of Object.entries(assignments)) {
    if (Array.isArray(value)) {
      const filtered = value.filter((id) => usableIds.has(id));
      if (filtered.length === 0 && value.length > 0) {
        warnings.push(`"${roleId}" lost all its assigned assets after AI review — this role will render empty`);
      }
      roles[roleId] = filtered;
    } else if (typeof value === "object" && value !== null && "fallback" in value) {
      roles[roleId] = value;
    }
    // A bare `string` assignment value (e.g. a hypothetical "priceSource"
    // convenience key) doesn't fit GameSpec.roles' stricter type and isn't
    // produced by this pipeline's matcher — nothing to map here.
  }
  return roles;
}

function buildProcessedAssets(assets: RawAsset[], usableIds: Set<string>): ProcessedAsset[] {
  const out: ProcessedAsset[] = [];
  for (const asset of assets) {
    if (!usableIds.has(asset.id) || !asset.processed) continue;
    // Sync the score/flags sprites.ts left as placeholders with the real
    // values quality.ts computed onto RawAsset.quality afterwards.
    out.push({ ...asset.processed, score: asset.quality.score, flags: asset.quality.flags });
  }
  return out;
}

function buildRewards(rewards: BrainResponse["rewards"]): RewardTier[] {
  return rewards.map((r) => ({ minScore: r.minScore, label: r.label, percentOff: r.percentOff }));
}

function buildBrandKit(inventory: AssetInventory, assetsById: Map<string, RawAsset>) {
  const logoAsset = inventory.brand.logo ? assetsById.get(inventory.brand.logo.assetId) : undefined;

  const accent = pickAccent(inventory.brand.palette);
  const foreground = forceContrast(DEFAULT_FOREGROUND, STAGE_BACKGROUND);

  return {
    name: deriveBrandName(inventory.source.url),
    logoUrl: logoAsset?.processed?.spriteUrl,
    accent,
    background: STAGE_BACKGROUND,
    foreground,
    fontFamily: mapToGoogleFont(inventory.brand.fontStack),
    palette: inventory.brand.palette,
  };
}

/** Prefers a palette colour with real saturation and reasonable contrast
 * against the stage background over whatever happens to be first (often
 * near-white background, not the actual brand colour). Falls back to a
 * safe default indigo if nothing usable survived extraction. */
function pickAccent(palette: string[]): string {
  const candidates = palette
    .filter((hex) => /^#[0-9a-f]{6}$/i.test(hex))
    .filter((hex) => saturationOfHex(hex) > 0.15)
    .sort((a, b) => saturationOfHex(b) - saturationOfHex(a));

  const best = candidates[0] ?? palette[0];
  if (!best) return DEFAULT_ACCENT;

  // A near-invisible accent against the stage would defeat the point of
  // having one — nudge toward the default rather than ship something
  // illegible (compose.ts, unlike palette.forceContrast's black/white
  // swap, has a real brand colour to prefer when there's a real choice).
  const contrastOk = Math.abs(luminanceOfHex(best) - luminanceOfHex(STAGE_BACKGROUND)) > 0.15;
  return contrastOk ? best : DEFAULT_ACCENT;
}

/** Build spec §23 gotcha: "Licensed web fonts → redistribution risk → map
 * to nearest Google Font; never re-serve theirs." This pipeline has no
 * real font-detection heuristic (that needs computed CSS, out of scope —
 * extract/index.ts seeds a safe default stack), so this mapping is mostly
 * a stable pass-through with a couple of generic-family fallbacks. */
function mapToGoogleFont(fontStack: string): string {
  const lower = fontStack.toLowerCase();
  if (lower.includes("mono")) return "Roboto Mono";
  if (lower.includes("serif") && !lower.includes("sans-serif")) return "Playfair Display";
  return "Inter";
}

function deriveBrandName(sourceUrl: string | undefined): string | undefined {
  if (!sourceUrl) return undefined;
  try {
    let host = new URL(sourceUrl).hostname.replace(/^www\./, "");
    host = host.replace(/\.[a-z]{2,}$/i, ""); // drop the TLD
    const words = host.split(/[.\-_]+/).filter(Boolean);
    if (words.length === 0) return undefined;
    return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  } catch {
    return undefined;
  }
}
