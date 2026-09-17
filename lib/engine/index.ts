// lib/engine/index.ts
//
// The pipeline orchestrator (build spec §6), split into two phases at the
// "choosing" pause (see docs/ARCHITECTURE.md): fetching -> extracting ->
// downloading -> processing -> quality -> matching (runExtraction), then —
// once the user has picked a template from the eligible list — thinking ->
// composing (runComposition). Reports progress at every stage transition
// with human-readable messages from the build spec's §6 table.
//
// Neither function touches any database — the API route calls them and
// persists progress/results itself. This is the integration seam between
// tracks; keep it clean.
//
// Sharp runs transitively (sprites.ts, brain.ts's image resizing) — the
// calling route MUST declare `export const runtime = "nodejs"`.

import type {
  AssetInventory,
  GameSpec,
  JobStage,
  MatchReport,
  RawAsset,
  TemplateId,
} from "@/lib/engine/types";
import { listCapabilities } from "@/lib/capabilities";
import { extractFromUrl } from "./extract";
import { deriveBrandNameFromUrl, makeRawAsset } from "./extract/util";
import { processSprites } from "./sprites";
import { runQualityGate } from "./quality";
import { matchAssets } from "./matcher";
import { suggestTemplates } from "./suggestTemplates";
import { runBrain } from "./brain";
import { compose } from "./compose";

export interface GenerationCallbacks {
  onProgress: (patch: { stage: JobStage; percent: number; message?: string }) => Promise<void> | void;
}

export interface GenerationInput {
  mode: "auto" | "manual";
  sourceUrl?: string;
  /** Manual mode's pre-uploaded assets (build spec §1: "Upload images,
   * enter copy"). `url` is expected to already be reachable (e.g. a blob
   * URL from /api/upload) — this pipeline downloads and processes it the
   * same way it would any extracted candidate. */
  manualAssets?: { url: string; name?: string; priceMinor?: number }[];
}

export interface ExtractionOutput {
  inventory: AssetInventory;
  match: MatchReport;
  /** Carried into runComposition() so brain.ts's copy generation still has
   * the business context extraction found, without re-scraping the site
   * after the "choosing" pause. */
  businessName?: string;
  businessDescription?: string;
  /** Images that failed to download/decode during processing — an
   * inventory-wide fact (not per-template), so it's carried alongside the
   * match report and folded into whichever GameSpec eventually gets
   * composed as a `meta.warnings` entry. */
  droppedCount: number;
}

/**
 * Phase 1: everything up through the matcher. Stops right after scoring
 * every template against what was actually found — deliberately does NOT
 * pick a template or generate copy, so the caller can show the user the
 * eligible list and let them choose before any AI/copy cost is spent.
 */
export async function runExtraction(
  input: GenerationInput,
  callbacks: GenerationCallbacks,
): Promise<ExtractionOutput> {
  const emit = async (stage: JobStage, percent: number, message?: string) => {
    await callbacks.onProgress({ stage, percent, message });
  };

  await emit("fetching", 5, "Reading your site…");

  let inventory: AssetInventory;
  let businessName: string | undefined;
  let businessDescription: string | undefined;

  if (input.mode === "auto") {
    if (!input.sourceUrl) throw new Error("runExtraction: auto mode requires sourceUrl");
    const extracted = await extractFromUrl(input.sourceUrl);
    inventory = extracted.inventory;
    // og:site_name beats a domain guess when markup was actually readable;
    // when it wasn't (a blocked/unreachable site — extractFromUrl degrades
    // to an empty inventory rather than throwing, see its own comment), a
    // real name beats brain.ts's generic "this brand" copy fallback. Free —
    // pure string parsing of the URL the user already gave us.
    businessName = extracted.siteName ?? deriveBrandNameFromUrl(input.sourceUrl);
    businessDescription = extracted.description;
    await emit(
      "extracting",
      18,
      inventory.assets.length > 0 ? `Found ${inventory.assets.length} products` : "Couldn't find much on that page",
    );
  } else {
    inventory = buildManualInventory(input.manualAssets ?? []);
    await emit("extracting", 18, `${inventory.assets.length} asset(s) ready`);
  }

  await emit("downloading", 25, "Downloading images…");
  const { processed, dropped } = await processSprites(inventory.assets, {
    alwaysInclude: inventory.brand.logo ? new Set([inventory.brand.logo.assetId]) : undefined,
  });

  await emit("processing", 55, "Preparing your products…");
  inventory = { ...inventory, assets: processed };

  const gate = runQualityGate(inventory.assets, {
    assumedStageBackground: inventory.brand.palette[0],
    // The logo is exempt from the whole gate, not just resolution — see
    // quality.ts's QualityGateOptions.exemptFromGate doc comment for why.
    exemptFromGate: inventory.brand.logo ? new Set([inventory.brand.logo.assetId]) : undefined,
  });
  await emit("quality", 65);

  const survivorIds = new Set(gate.assets.map((a) => a.id));
  inventory = {
    ...inventory,
    assets: gate.assets,
    brand: {
      ...inventory.brand,
      logo:
        inventory.brand.logo && survivorIds.has(inventory.brand.logo.assetId) ? inventory.brand.logo : undefined,
      // Extraction only ever seeded the palette from theme-color/manifest;
      // now that every surviving asset's real dominant colours are known
      // (palette.ts, run inside sprites.ts), fold those in too.
      palette: refineBrandPalette(inventory.brand.palette, gate.assets),
    },
    dataCoverage: computeDataCoverage(gate.assets),
  };

  const capabilities = listCapabilities();
  let match = matchAssets(inventory, capabilities);
  await emit("matching", 68, "Matching games to your brand…");

  if (input.mode === "auto" && match.results.some((r) => r.eligible)) {
    await emit("matching", 69, "Finding the best games for your brand…");
    match = await suggestTemplates({
      match,
      inventory,
      capabilities,
      businessName,
      businessDescription,
      sourceUrl: input.sourceUrl,
    });
  }

  return { inventory, match, businessName, businessDescription, droppedCount: dropped.length };
}

export interface CompositionInput {
  inventory: AssetInventory;
  match: MatchReport;
  /** The template the user picked from the eligible list shown after
   * runExtraction(). Must be one of match.results' eligible templates. */
  template: TemplateId;
  mode: "auto" | "manual";
  businessName?: string;
  businessDescription?: string;
  /** See ExtractionOutput.droppedCount — pass it straight through. */
  droppedCount?: number;
}

export interface GenerationOutput {
  inventory: AssetInventory;
  match: MatchReport;
  spec: GameSpec;
}

/**
 * Phase 2: thinking -> composing. Runs once the user has chosen a template,
 * generating copy/rewards/tuning for exactly that template (brain.ts never
 * gets to pick a different one — see RunBrainInput.forcedTemplate) and
 * assembling the final GameSpec.
 */
export async function runComposition(
  input: CompositionInput,
  callbacks: GenerationCallbacks,
): Promise<GenerationOutput> {
  const emit = async (stage: JobStage, percent: number, message?: string) => {
    await callbacks.onProgress({ stage, percent, message });
  };

  const capabilities = listCapabilities();

  await emit("thinking", 75, "Writing your game…");
  const brain = await runBrain({
    inventory: input.inventory,
    match: input.match,
    capabilities,
    businessName: input.businessName,
    businessDescription: input.businessDescription,
    forcedTemplate: input.template,
  });

  await emit("composing", 92, "Almost there…");
  const spec = compose(input.inventory, input.match, brain, input.mode);

  if (input.droppedCount) {
    spec.meta.warnings.push(`${input.droppedCount} image(s) could not be downloaded or decoded and were skipped`);
  }
  if (input.match.fallbackMode === "manual") {
    // fallbackMode covers two different situations (matcher.ts) — "nothing
    // was eligible at all" vs. "something was eligible, just off a thin
    // inventory". The user already picked a template from the eligible
    // list by the time this runs, so the first message would flatly
    // contradict what they just did — only show it when that's actually
    // what happened.
    const eligibleCount = input.match.results.filter((r) => r.eligible).length;
    spec.meta.warnings.push(
      eligibleCount > 0
        ? "Only a few usable images were found on this site, so the game may look sparse — consider manual mode to add more."
        : "No template cleared the eligibility bar with confidence — consider switching to manual mode and adding a few more images.",
    );
  }

  await emit("done", 100);

  return { inventory: input.inventory, match: input.match, spec };
}

function buildManualInventory(manualAssets: { url: string; name?: string; priceMinor?: number }[]): AssetInventory {
  const assets: RawAsset[] = manualAssets.map((m) =>
    makeRawAsset({ url: m.url, origin: "upload", name: m.name, priceMinor: m.priceMinor }),
  );
  return {
    version: 1,
    source: { mode: "manual" },
    currency: "USD",
    assets,
    brand: { palette: [], fontStack: "Inter, system-ui, sans-serif" },
    dataCoverage: computeDataCoverage(assets),
  };
}

function computeDataCoverage(assets: RawAsset[]): AssetInventory["dataCoverage"] {
  return assets.reduce(
    (acc, a) => ({
      withName: acc.withName + (a.data?.name ? 1 : 0),
      withPrice: acc.withPrice + (a.data?.priceMinor !== undefined ? 1 : 0),
      withCategory: acc.withCategory + (a.data?.category ? 1 : 0),
    }),
    { withName: 0, withPrice: 0, withCategory: 0 },
  );
}

/** Cheap colour-frequency merge of the theme-color seed and every
 * surviving asset's own dominant colours — not a proper clustering pass,
 * just "what showed up most often", capped to a small palette. */
function refineBrandPalette(seed: string[], assets: RawAsset[]): string[] {
  const tally = new Map<string, number>();
  for (const hex of seed) tally.set(hex, (tally.get(hex) ?? 0) + 2); // slight bias toward the page's own declared theme colour
  for (const asset of assets) {
    for (const hex of asset.colour.dominant) {
      tally.set(hex, (tally.get(hex) ?? 0) + 1);
    }
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([hex]) => hex);
}
