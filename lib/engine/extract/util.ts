// lib/engine/extract/util.ts
//
// Shared helpers for the extraction ladder (build spec §7). Not one of the
// files named in the track brief, but kept private to lib/engine/extract/ —
// no other track touches this directory, and it removes ~20 lines of
// duplicated "fill in the RawAsset defaults" boilerplate from every ladder
// step. If in doubt, treat it as part of extract/index.ts split out for
// readability.

import { nanoid } from "nanoid";
import type { AssetOrigin, RawAsset, SubjectType } from "@/lib/engine/types";

export interface CandidateAssetInput {
  url: string;
  origin: AssetOrigin;
  name?: string;
  priceMinor?: number;
  category?: string;
  sku?: string;
  /** The product's own page on the storefront — see RawAsset.data's doc
   * comment in types.ts. */
  productUrl?: string;
  /** Set when the ladder step structurally knows the subject type (e.g. the
   * logo ladder always knows it found a logo) — better than leaving it
   * "unknown" for something downstream heuristics can't reliably guess either. */
  subjectTypeHint?: SubjectType;
}

/**
 * Extraction only ever sees markup — no decoded pixels yet. This fills every
 * field RawAsset requires (pixels/alpha/background/colour/content/phash/
 * quality) with sensible "not yet known" defaults; sprites.ts, cutout.ts and
 * quality.ts overwrite them once the image is actually downloaded and decoded.
 */
export function makeRawAsset(input: CandidateAssetInput): RawAsset {
  const hasData =
    input.name !== undefined ||
    input.priceMinor !== undefined ||
    input.category !== undefined ||
    input.sku !== undefined ||
    input.productUrl !== undefined;

  return {
    id: `a_${nanoid(8)}`,
    url: input.url,
    origin: input.origin,
    pixels: { width: 0, height: 0, aspect: 0 },
    alpha: { has: false, coverage: null },
    background: { uniformity: 0, dominant: "#FFFFFF", isolatable: false },
    colour: { dominant: [], meanLuminance: 0.5, saturation: 0 },
    content: {
      subjectType: input.subjectTypeHint ?? "unknown",
      textDensity: 0,
      subjectCount: 1,
    },
    phash: "",
    data: hasData
      ? {
          name: input.name,
          priceMinor: input.priceMinor,
          category: input.category,
          sku: input.sku,
          productUrl: input.productUrl,
        }
      : undefined,
    quality: { score: 0, flags: ["unprocessed"] },
  };
}

/** Origin trust ranking, capability schema §1 field notes: products_json >
 * jsonld > og > dom > upload. Used to break ties when the same image URL
 * surfaces from two ladder steps. */
export const ORIGIN_RANK: Record<AssetOrigin, number> = {
  products_json: 5,
  jsonld: 4,
  og: 3,
  dom: 2,
  upload: 1,
};

/** Merges assets from multiple ladder steps, keeping the highest-trust
 * origin whenever the same image URL (ignoring query/hash) turns up twice. */
export function dedupeByUrl(assets: RawAsset[]): RawAsset[] {
  const seen = new Map<string, RawAsset>();
  for (const asset of assets) {
    const key = normalizeUrlForDedupe(asset.url);
    const existing = seen.get(key);
    if (!existing || ORIGIN_RANK[asset.origin] > ORIGIN_RANK[existing.origin]) {
      seen.set(key, asset);
    }
  }
  return [...seen.values()];
}

function normalizeUrlForDedupe(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

export function resolveUrl(maybeRelative: string, base: string): string | null {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}

/**
 * A safe, always-available brand-name guess from the bare hostname (e.g.
 * "https://www.uniqlo.com/" → "Uniqlo") — pure string parsing of the URL
 * the caller already has, no network involved, so it never depends on any
 * fetch having succeeded. Used as compose.ts's `BrandKit.name` fallback,
 * and — since the same gap exists one level up — as `runExtraction()`'s
 * fallback for the business name fed to `brain.ts`'s copy generation, for
 * exactly the case a real og:site_name can't: a site whose root document
 * fetch itself failed entirely (see extract/index.ts's resilience comment)
 * has no markup to read a name from at all, but still has the URL the user
 * gave us — "Uniqlo" beats brain.ts's generic "this brand" fallback.
 */
export function deriveBrandNameFromUrl(sourceUrl: string | undefined): string | undefined {
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
