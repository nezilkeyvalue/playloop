#!/usr/bin/env tsx
// scripts/test-matcher.ts
//
// Deterministic matcher regression tests for SPA-style e-commerce inventories
// (named catalogue photos, no prices, no packshot isolation). Usage:
//   npm run test:matcher

import { listCapabilities } from "../lib/capabilities";
import { matchAssets } from "../lib/engine/matcher";
import type { AssetInventory, RawAsset, TemplateId } from "../lib/engine/types";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function mockCatalogueAsset(index: number): RawAsset {
  const phash = `${index.toString(16).padStart(16, "0")}`;
  return {
    id: `a_test${index}`,
    url: `https://cdn.example.com/uploads/catalog/product/item-${index}.jpg`,
    origin: "dom",
    pixels: { width: 320, height: 320, aspect: 1 },
    alpha: { has: true, coverage: 0.85 },
    background: { uniformity: 0.4, dominant: "#e8e8e8", isolatable: false },
    colour: { dominant: ["#e8e8e8"], meanLuminance: 0.7, saturation: 0.2 },
    content: { subjectType: "product", textDensity: 0.12, subjectCount: 1 },
    phash,
    data: { name: `Catalogue Product ${index + 1}` },
    quality: { score: 0.82, flags: ["transform:cutout:failed"] },
  };
}

function buildSpaInventory(count: number): AssetInventory {
  const assets = Array.from({ length: count }, (_, i) => mockCatalogueAsset(i));
  return {
    version: 1,
    source: { mode: "auto", url: "https://www.thesouledstore.com/men" },
    currency: "USD",
    assets,
    brand: { palette: ["#111111"], fontStack: "Inter, system-ui, sans-serif" },
    dataCoverage: { withName: count, withPrice: 0, withCategory: 0 },
  };
}

function isEligible(match: ReturnType<typeof matchAssets>, template: TemplateId): boolean {
  return match.results.some((r) => r.template === template && r.eligible);
}

const inventory = buildSpaInventory(6);
const capabilities = listCapabilities();
const match = matchAssets(inventory, capabilities);

const shouldBeEligible: TemplateId[] = [
  "whack",
  "catch",
  "chomp",
  "slice",
  "chain_pop",
  "simon",
  "shooter",
  "sweet_spot",
];

for (const template of shouldBeEligible) {
  assert(isEligible(match, template), `${template} is eligible on SPA catalogue inventory`);
}

assert(!isEligible(match, "guess_price"), "guess_price is ineligible without prices");

const recommended = match.recommended[0];
const productInteraction: TemplateId[] = ["whack", "catch", "chomp", "slice"];
assert(
  recommended !== undefined && productInteraction.includes(recommended),
  `recommended template is a product-interaction game (got ${recommended ?? "none"})`,
);

if (process.exitCode === 1) {
  console.error("\nMatcher fixture tests failed.");
  process.exit(1);
}

console.log("\nAll matcher fixture tests passed.");
