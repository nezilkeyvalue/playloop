// lib/engine/index.ts
//
// runGeneration() — the pipeline orchestrator (build spec §6): fetching ->
// extracting -> downloading -> processing -> quality -> matching ->
// thinking -> composing, reporting progress at every stage transition
// with the human-readable messages from the build spec's §6 table.
//
// This function does NOT touch any database — a different track's API
// route calls it and persists progress/results itself. This is the
// integration seam between tracks; keep it clean.
//
// Sharp runs transitively (sprites.ts, brain.ts's image resizing) — the
// calling route MUST declare `export const runtime = "nodejs"`.

import type { AssetInventory, GameSpec, JobStage, MatchReport, RawAsset } from "@/lib/engine/types";
import { listCapabilities } from "@/lib/capabilities";
import { extractFromUrl } from "./extract";
import { makeRawAsset } from "./extract/util";
import { processSprites } from "./sprites";
import { runQualityGate } from "./quality";
import { matchAssets } from "./matcher";
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

export interface GenerationOutput {
  inventory: AssetInventory;
  match: MatchReport;
  spec: GameSpec;
}

export async function runGeneration(
  input: GenerationInput,
  callbacks: GenerationCallbacks,
): Promise<GenerationOutput> {
  const emit = async (stage: JobStage, percent: number, message?: string) => {
    await callbacks.onProgress({ stage, percent, message });
  };

  await emit("fetching", 5, "Reading your site…");

  let inventory: AssetInventory;
  let businessName: string | undefined;
  let businessDescription: string | undefined;

  if (input.mode === "auto") {
    if (!input.sourceUrl) throw new Error("runGeneration: auto mode requires sourceUrl");
    const extracted = await extractFromUrl(input.sourceUrl);
    inventory = extracted.inventory;
    businessName = extracted.siteName;
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
  const { processed, dropped } = await processSprites(inventory.assets);

  await emit("processing", 55, "Preparing your products…");
  inventory = { ...inventory, assets: processed };

  const gate = runQualityGate(inventory.assets, {
    assumedStageBackground: inventory.brand.palette[0],
    exemptFromResolutionCheck: inventory.brand.logo ? new Set([inventory.brand.logo.assetId]) : undefined,
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
  const match = matchAssets(inventory, capabilities);
  await emit("matching", 68);

  await emit("thinking", 75, "Choosing your game…");
  const brain = await runBrain({ inventory, match, capabilities, businessName, businessDescription });

  await emit("composing", 92, "Almost there…");
  const spec = compose(inventory, match, brain, input.mode);

  if (dropped.length > 0) {
    spec.meta.warnings.push(`${dropped.length} image(s) could not be downloaded or decoded and were skipped`);
  }
  if (match.fallbackMode === "manual") {
    spec.meta.warnings.push(
      "No template cleared the eligibility bar with confidence — consider switching to manual mode and adding a few more images.",
    );
  }

  await emit("done", 100);

  return { inventory, match, spec };
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
