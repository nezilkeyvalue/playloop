// lib/engine/quality.ts
//
// Quality gate (build spec §9): "Most output quality comes from rejecting
// assets, not improving them." Runs after sprites.ts has downloaded and
// decoded every candidate, before the matcher sees the inventory.
//
// Reject-rule table (build spec §9):
//   resolution        short edge < 300px
//   coverage          alpha fill < 5% or > 95%
//   aspect            beyond ~3:1 either way
//   background        high corner variance -> cutout will have failed
//   duplicates        phash Hamming distance < 6
//   text density      burned-in "50% OFF" style badges
//   contrast          sprite luminance too close to the stage background
//
// Text density has no OCR here — see estimateTextDensity()'s doc comment
// for exactly what it approximates and where that approximation is weak.

import type { RawAsset } from "@/lib/engine/types";
import { contrastRatioFromLuminance, luminanceOfHex } from "./palette";
import { hammingDistance } from "./cutout";

export interface QualityGateOptions {
  /** Hex used as the assumed stage backdrop for the contrast check. The
   * final BrandKit.background isn't chosen until compose.ts (after the AI
   * layer runs), so this is a best-effort guess — pass the brand palette's
   * lead colour or a page's theme-color when available; defaults to a
   * light stage, the common case for e-commerce product photography. */
  assumedStageBackground?: string;
  /** Asset ids to exempt from the resolution (short-edge) reject — the
   * logo ladder's last resort is deliberately a favicon (build spec §7:
   * "favicon last"), often ~32px, which would otherwise always fail the
   * 300px floor. A brand mark shown small in the UI doesn't need
   * collectible-sprite resolution; every other check still applies. */
  exemptFromResolutionCheck?: Set<string>;
}

export interface RejectedAsset {
  asset: RawAsset;
  reasons: string[];
}

export interface QualityGateResult {
  /** Survivors, with `quality.score` / `quality.flags` / `content.textDensity`
   * finalized. Order is stable relative to the input. */
  assets: RawAsset[];
  rejected: RejectedAsset[];
}

const MIN_SHORT_EDGE = 300;
const MIN_COVERAGE = 0.05;
const MAX_COVERAGE = 0.95;
const MAX_ASPECT_RATIO = 3.0; // "beyond ~3:1 either way"
const MIN_UNIFORMITY_FOR_ISOLATION = 0.6; // below this the cutout is unreliable even if it "succeeded"
const DUPLICATE_HAMMING_THRESHOLD = 6; // "within Hamming distance 6" — i.e. distance < 6 is a duplicate
const HIGH_TEXT_DENSITY = 0.3; // hard reject — see estimateTextDensity()
const POSSIBLE_TEXT_DENSITY = HIGH_TEXT_DENSITY / 2; // soft flag only
const MIN_STAGE_CONTRAST = 1.6; // soft luminance-distance signal, not full WCAG (that's palette.ts's job for copy text)

export function runQualityGate(assets: RawAsset[], options: QualityGateOptions = {}): QualityGateResult {
  const stageLuminance = luminanceOfHex(options.assumedStageBackground ?? "#FFFFFF");
  const exempt = options.exemptFromResolutionCheck ?? new Set<string>();

  const survivors: RawAsset[] = [];
  const rejected: RejectedAsset[] = [];

  for (const asset of assets) {
    const reasons: string[] = [];
    // Preserve the transform provenance flags sprites.ts already recorded
    // (e.g. "transform:cutout:flood", "transform:shadow") — matcher.ts
    // reads these back to score the actually-applied transform route.
    const flags: string[] = [...asset.quality.flags];

    const shortEdge = Math.min(asset.pixels.width, asset.pixels.height);
    if (shortEdge > 0 && shortEdge < MIN_SHORT_EDGE && !exempt.has(asset.id)) {
      reasons.push(`short edge ${shortEdge}px is under the ${MIN_SHORT_EDGE}px floor`);
    }

    const coverage = asset.alpha.coverage;
    if (coverage !== null) {
      if (coverage < MIN_COVERAGE) {
        reasons.push(`alpha coverage ${(coverage * 100).toFixed(1)}% is under ${MIN_COVERAGE * 100}%`);
      } else if (coverage > MAX_COVERAGE) {
        reasons.push(`alpha coverage ${(coverage * 100).toFixed(1)}% is over ${MAX_COVERAGE * 100}%`);
      }
    }

    const aspect = asset.pixels.aspect || 1;
    if (aspect > MAX_ASPECT_RATIO || aspect < 1 / MAX_ASPECT_RATIO) {
      reasons.push(`aspect ratio ${aspect.toFixed(2)} is beyond ${MAX_ASPECT_RATIO}:1`);
    }

    if (!asset.background.isolatable && asset.background.uniformity < MIN_UNIFORMITY_FOR_ISOLATION) {
      reasons.push(
        `background too non-uniform for a clean cutout (uniformity ${asset.background.uniformity.toFixed(2)})`,
      );
    }

    const textDensity = estimateTextDensity(asset);
    asset.content.textDensity = textDensity;
    if (textDensity > HIGH_TEXT_DENSITY) {
      reasons.push(`estimated text density ${textDensity.toFixed(2)} looks like a burned-in badge/label`);
    } else if (textDensity > POSSIBLE_TEXT_DENSITY) {
      flags.push("possible_text_overlay");
    }

    const contrast = contrastRatioFromLuminance(asset.colour.meanLuminance, stageLuminance);
    if (contrast < MIN_STAGE_CONTRAST) {
      // Soft signal only — not an outright reject. A near-white product on
      // a light stage can still work with an outline; this mostly feeds
      // the matcher's `prefers.contrastAgainst` scoring.
      flags.push("low_stage_contrast");
    }

    if (reasons.length > 0) {
      rejected.push({ asset, reasons });
      continue;
    }

    asset.quality = { score: scoreAsset(asset, contrast), flags };
    survivors.push(asset);
  }

  return dedupeByPhash(survivors, rejected);
}

function scoreAsset(asset: RawAsset, stageContrast: number): number {
  let score = 1;

  const shortEdge = Math.min(asset.pixels.width, asset.pixels.height);
  if (shortEdge > 0) {
    // Headroom above the 300px floor, saturating once we're 2x over it.
    const headroom = clamp((shortEdge - MIN_SHORT_EDGE) / MIN_SHORT_EDGE, 0, 1);
    score *= clamp(0.5 + 0.5 * headroom, 0.5, 1);
  }

  score *= clamp(asset.background.uniformity || 0.5, 0.5, 1);

  const coverage = asset.alpha.coverage;
  if (coverage !== null) {
    const inIdealBand = coverage >= 0.25 && coverage <= 0.85; // capability schema's common `prefers.coverageRange`
    score *= inIdealBand ? 1 : 0.85;
  }

  score *= clamp(0.6 + 0.4 * Math.min(1, stageContrast / MIN_STAGE_CONTRAST), 0.6, 1);
  score *= clamp(1 - asset.content.textDensity, 0.5, 1);

  return clamp(Number(score.toFixed(3)), 0, 1);
}

/**
 * APPROXIMATION, not OCR. We have no text-detection model in this pipeline,
 * so this estimates "burned-in badge/label" risk from signals available
 * for free off already-computed asset fields:
 *   - non-isolatable backgrounds correlate with promotional graphics (solid
 *     colour blocks, banner sale tiles) that often carry text;
 *   - very high colour saturation combined with a non-square aspect is a
 *     mild banner/badge signal.
 * This will both miss real burned-in text on an otherwise clean packshot
 * (false negative) and flag busy-but-textless lifestyle photography (false
 * positive). It is deliberately capped well below 1.0 — the intent is a
 * soft prior for the matcher's `maxTextDensity` gate, not a confident
 * number. Treat any asset near the HIGH_TEXT_DENSITY threshold as "genuinely
 * unknown", not "verified"; a real OCR/vision pass (build spec §24 open
 * decision) is the correct fix, not a bigger heuristic.
 */
function estimateTextDensity(asset: RawAsset): number {
  let estimate = 0;
  if (!asset.background.isolatable && asset.background.uniformity < 0.5) estimate += 0.15;
  if (asset.colour.saturation > 0.6 && (asset.pixels.aspect > 1.6 || asset.pixels.aspect < 0.6)) estimate += 0.1;
  return clamp(estimate, 0, 1);
}

function dedupeByPhash(survivors: RawAsset[], rejected: RejectedAsset[]): QualityGateResult {
  const originalOrder = new Map(survivors.map((a, i) => [a.id, i]));
  // Keep the highest-quality copy of any near-duplicate pair.
  const byScoreDesc = [...survivors].sort((a, b) => b.quality.score - a.quality.score);

  const kept: RawAsset[] = [];
  for (const asset of byScoreDesc) {
    if (!asset.phash) {
      kept.push(asset);
      continue;
    }
    const duplicateOf = kept.find(
      (existing) => existing.phash && hammingDistance(existing.phash, asset.phash) < DUPLICATE_HAMMING_THRESHOLD,
    );
    if (duplicateOf) {
      rejected.push({ asset, reasons: [`duplicate of ${duplicateOf.id} (phash distance < ${DUPLICATE_HAMMING_THRESHOLD})`] });
      continue;
    }
    kept.push(asset);
  }

  const keptIds = new Set(kept.map((a) => a.id));
  const assets = survivors
    .filter((a) => keptIds.has(a.id))
    .sort((a, b) => (originalOrder.get(a.id) ?? 0) - (originalOrder.get(b.id) ?? 0));

  return { assets, rejected };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
