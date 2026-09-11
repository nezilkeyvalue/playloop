// lib/runtime/fixtures/sampleGameSpec.ts
//
// Hand-written, complete, valid GameSpec fixtures — one per MVP template —
// so the runtime track is testable with zero pipeline/database dependency
// (build spec §20, Track B: "Never blocked, because the contract exists
// from hour one"). Every image is an inline SVG data: URI, so these work
// offline, in CI, and with no blob storage or CDN in the loop.
//
// `id` doubles as the public slug ("demo-catch", "demo-guess-price") —
// app/play/[slug]/page.tsx serves these two slugs directly, and mount.ts
// falls back to `spec.id` for telemetry when no explicit slug is passed.

import type { GameSpec, ProcessedAsset } from "@/lib/engine/types";

/** A small square sprite as an inline SVG data URI — no network, no CORS. */
function colorSprite(hex: string, label: string, textColor = "#ffffff"): string {
  const safeLabel = label.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">` +
    `<rect width="256" height="256" rx="32" fill="${hex}"/>` +
    `<text x="128" y="150" font-family="system-ui, sans-serif" font-size="72" ` +
    `font-weight="700" text-anchor="middle" fill="${textColor}">${safeLabel}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function asset(
  id: string,
  hex: string,
  label: string,
  data?: ProcessedAsset["data"],
): ProcessedAsset {
  return {
    id,
    spriteUrl: colorSprite(hex, label),
    width: 256,
    height: 256,
    coverage: 0.62,
    phash: `fixture-${id}`,
    score: 0.9,
    flags: [],
    data,
  };
}

const GENERATED_AT = "2026-09-01T12:00:00.000Z";
const FIXTURE_WARNING =
  "Hand-written fixture (build spec §20, Track B) — no generation pipeline ran; colours, copy and prices are illustrative.";

// ---------------------------------------------------------------------------
// Catch — "Bloom Coffee Co."
// ---------------------------------------------------------------------------

const catchCollectibles: ProcessedAsset[] = [
  asset("bean-1", "#8A5A34", "☕", { name: "House Blend 250g", priceMinor: 1400, currency: "USD" }),
  asset("bean-2", "#C77B45", "☕", { name: "Single Origin Kenya", priceMinor: 1900, currency: "USD" }),
  asset("bean-3", "#6E4A2E", "☕", { name: "Dark Roast Decaf", priceMinor: 1500, currency: "USD" }),
  asset("bean-4", "#B4713F", "☕", { name: "Cold Brew Concentrate", priceMinor: 1700, currency: "USD" }),
  asset("bean-5", "#9C6537", "☕", { name: "Espresso Blend", priceMinor: 1600, currency: "USD" }),
  asset("bean-6", "#7A5232", "☕", { name: "Light Roast Ethiopia", priceMinor: 2100, currency: "USD" }),
  asset("bean-7", "#A96A3B", "☕", { name: "Seasonal Blend", priceMinor: 1800, currency: "USD" }),
  asset("bean-8", "#835939", "☕", { name: "Decaf Colombia", priceMinor: 1550, currency: "USD" }),
];

export const catchGameSpec: GameSpec = {
  id: "demo-catch",
  version: 1,
  template: "catch",
  placements: ["section", "fullpage", "modal"],
  brand: {
    name: "Bloom Coffee Co.",
    accent: "#E1663B",
    background: "#FBF7F2",
    foreground: "#241a12",
    fontFamily: "Poppins, system-ui, sans-serif",
    palette: ["#E1663B", "#2F6F5E", "#FBF7F2", "#241a12"],
  },
  copy: {
    headline: "Catch today's roast",
    subhead: "Drag the basket, catch the beans, dodge the burnt batches.",
    ctaStart: "Start catching",
    ctaReplay: "Catch again",
    rewardIntro: "You earned",
    emailPrompt: "Email my code",
  },
  assets: catchCollectibles,
  roles: {
    collectible: catchCollectibles.map((a) => a.id),
    catcher: { fallback: "generatedShape" },
    hazard: { fallback: "generatedShape" },
    stageBackground: { fallback: "brandGradient" },
  },
  rewards: [
    { minScore: 0, label: "10% off", percentOff: 10, code: "CATCH10" },
    { minScore: 450, label: "15% off", percentOff: 15, code: "CATCH15" },
    { minScore: 900, label: "20% off", percentOff: 20, code: "CATCH20" },
  ],
  durationSeconds: 40,
  tuning: {
    spawnRateHz: 1.2,
    fallSpeed: 170,
    durationSec: 40,
    hazardRatio: 0.2,
  },
  meta: {
    mode: "manual",
    generatedAt: GENERATED_AT,
    warnings: [FIXTURE_WARNING],
  },
};

// ---------------------------------------------------------------------------
// Guess the Price — "Nordic Sock Co."
// ---------------------------------------------------------------------------

const guessPriceHeroes: ProcessedAsset[] = [
  asset("sock-1", "#2F5D73", "🧦", { name: "Merino Crew Sock", priceMinor: 1800, currency: "USD" }),
  asset("sock-2", "#3E7A63", "🧦", { name: "Striped Ankle Sock", priceMinor: 1200, currency: "USD" }),
  asset("sock-3", "#8A4B6B", "🧦", { name: "Wool Hiking Sock", priceMinor: 2400, currency: "USD" }),
  asset("sock-4", "#C97A3E", "🧦", { name: "No-Show Everyday Sock", priceMinor: 900, currency: "USD" }),
  asset("sock-5", "#4A5A8A", "🧦", { name: "Cozy Cabin Sock", priceMinor: 2000, currency: "USD" }),
  asset("sock-6", "#6B6B45", "🧦", { name: "Athletic Compression Sock", priceMinor: 1600, currency: "USD" }),
];

export const guessPriceGameSpec: GameSpec = {
  id: "demo-guess-price",
  version: 1,
  template: "guess_price",
  placements: ["section", "fullpage", "modal"],
  brand: {
    name: "Nordic Sock Co.",
    accent: "#2F5D73",
    background: "#F4F1EC",
    foreground: "#1C2430",
    fontFamily: "Inter, system-ui, sans-serif",
    palette: ["#2F5D73", "#C97A3E", "#F4F1EC", "#1C2430"],
  },
  copy: {
    headline: "How well do you know our socks?",
    subhead: "Guess the price. Get closer, save more.",
    ctaStart: "Start guessing",
    ctaReplay: "Try again",
    rewardIntro: "You earned",
    emailPrompt: "Email my code",
  },
  assets: guessPriceHeroes,
  roles: {
    hero: guessPriceHeroes.map((a) => a.id),
    stageBackground: { fallback: "brandGradient" },
  },
  rewards: [
    { minScore: 0, label: "10% off", percentOff: 10, code: "GUESS10" },
    { minScore: 500, label: "15% off", percentOff: 15, code: "GUESS15" },
    { minScore: 950, label: "20% off", percentOff: 20, code: "GUESS20" },
  ],
  durationSeconds: 42,
  tuning: {
    roundCount: 6,
    roundSeconds: 7,
    durationSec: 42,
    tolerancePercent: 15,
  },
  meta: {
    mode: "manual",
    generatedAt: GENERATED_AT,
    warnings: [FIXTURE_WARNING],
  },
};

/** Keyed by the slug app/play/[slug]/page.tsx serves directly, no DB hit. */
export const fixtureGameSpecs: Record<string, GameSpec> = {
  "demo-catch": catchGameSpec,
  "demo-guess-price": guessPriceGameSpec,
};
