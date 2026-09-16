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

// ---------------------------------------------------------------------------
// Chain Pop — "Sweet Pop Co."
// ---------------------------------------------------------------------------

const chainPopTiles: ProcessedAsset[] = [
  asset("candy-1", "#E8567A", "🍬", { name: "Berry Twist", priceMinor: 500 }),
  asset("candy-2", "#F2A72E", "🍭", { name: "Citrus Pop", priceMinor: 450 }),
  asset("candy-3", "#6A4FB6", "🍫", { name: "Choc Bar", priceMinor: 600 }),
  asset("candy-4", "#3FAE8C", "🧁", { name: "Mint Cupcake", priceMinor: 700 }),
  asset("candy-5", "#E8567A", "🍪", { name: "Cookie Stack", priceMinor: 550 }),
];

export const chainPopGameSpec: GameSpec = {
  id: "demo-chain-pop",
  version: 1,
  template: "chain_pop",
  placements: ["section", "fullpage", "modal"],
  brand: {
    name: "Sweet Pop Co.",
    accent: "#E8567A",
    secondaryAccent: "#3FAE8C",
    background: "#FFF7F2",
    foreground: "#2B1A22",
    fontFamily: "Fraunces, system-ui, sans-serif",
    palette: ["#E8567A", "#F2A72E", "#6A4FB6", "#3FAE8C", "#FFF7F2"],
  },
  copy: {
    headline: "Pop your way to a treat",
    subhead: "Tap 3 or more matching candies to clear them — bigger chains score more.",
    ctaStart: "Start popping",
    ctaReplay: "Pop again",
    rewardIntro: "You earned",
    emailPrompt: "Email my code",
  },
  assets: chainPopTiles,
  roles: {
    tile: chainPopTiles.map((a) => a.id),
    stageBackground: { fallback: "brandGradient" },
  },
  rewards: [
    { minScore: 0, label: "10% off", percentOff: 10, code: "POP10" },
    { minScore: 500, label: "15% off", percentOff: 15, code: "POP15" },
    { minScore: 950, label: "20% off", percentOff: 20, code: "POP20" },
  ],
  durationSeconds: 45,
  tuning: {
    gridCols: 6,
    gridRows: 7,
    durationSec: 45,
    minChainLength: 3,
  },
  meta: {
    mode: "manual",
    generatedAt: GENERATED_AT,
    warnings: [FIXTURE_WARNING],
  },
};

// ---------------------------------------------------------------------------
// Chomp — "Corner Grocer"
// ---------------------------------------------------------------------------

const chompPellets: ProcessedAsset[] = [
  asset("grocery-1", "#D64545", "🍎", { name: "Honeycrisp Apple", priceMinor: 150 }),
  asset("grocery-2", "#E2A233", "🧀", { name: "Aged Cheddar Block", priceMinor: 900 }),
  asset("grocery-3", "#7A9E4C", "🥑", { name: "Avocado", priceMinor: 200 }),
  asset("grocery-4", "#C97A3E", "🥐", { name: "Butter Croissant", priceMinor: 350 }),
  asset("grocery-5", "#5E8D6A", "🥦", { name: "Broccoli Crown", priceMinor: 250 }),
  asset("grocery-6", "#B6472E", "🍅", { name: "Vine Tomatoes", priceMinor: 300 }),
];

export const chompGameSpec: GameSpec = {
  id: "demo-chomp",
  version: 1,
  template: "chomp",
  placements: ["section", "fullpage", "modal"],
  brand: {
    name: "Corner Grocer",
    accent: "#3F8F5E",
    secondaryAccent: "#D64545",
    background: "#FBF8F0",
    foreground: "#22301F",
    fontFamily: "Nunito, system-ui, sans-serif",
    palette: ["#3F8F5E", "#D64545", "#FBF8F0", "#22301F"],
  },
  copy: {
    headline: "Chomp your way through the aisle",
    subhead: "Steer around the board and eat the groceries before their clock runs out.",
    ctaStart: "Start chomping",
    ctaReplay: "Chomp again",
    rewardIntro: "You earned",
    emailPrompt: "Email my code",
  },
  assets: chompPellets,
  roles: {
    pellet: chompPellets.map((a) => a.id),
    chaser: { fallback: "generatedShape" },
    stageBackground: { fallback: "brandGradient" },
  },
  rewards: [
    { minScore: 0, label: "10% off", percentOff: 10, code: "CHOMP10" },
    { minScore: 450, label: "15% off", percentOff: 15, code: "CHOMP15" },
    { minScore: 850, label: "20% off", percentOff: 20, code: "CHOMP20" },
  ],
  durationSeconds: 40,
  tuning: {
    pelletCount: 10,
    moveSpeed: 260,
    pelletLifetimeSec: 4,
    durationSec: 40,
  },
  meta: {
    mode: "manual",
    generatedAt: GENERATED_AT,
    warnings: [FIXTURE_WARNING],
  },
};

// ---------------------------------------------------------------------------
// Space Shooter — "Nova Bites"
// ---------------------------------------------------------------------------

const shooterProducts: ProcessedAsset[] = [
  asset("bar-1", "#F2A72E", "🍫", { name: "Peanut Crunch Bar", priceMinor: 320, currency: "USD" }),
  asset("bar-2", "#6A4FB6", "🍪", { name: "Cookie Dough Bites", priceMinor: 280, currency: "USD" }),
  asset("bar-3", "#3FAE8C", "🥜", { name: "Almond Protein Bar", priceMinor: 350, currency: "USD" }),
  asset("bar-4", "#E8567A", "🍓", { name: "Berry Oat Bar", priceMinor: 300, currency: "USD" }),
  asset("bar-5", "#2E86F2", "🍯", { name: "Honey Granola Bar", priceMinor: 290, currency: "USD" }),
];

export const shooterGameSpec: GameSpec = {
  id: "demo-shooter",
  version: 1,
  template: "shooter",
  placements: ["section", "fullpage", "modal"],
  brand: {
    name: "Nova Bites",
    accent: "#2E86F2",
    secondaryAccent: "#F2A72E",
    background: "#0B0F1E",
    foreground: "#F5F7FF",
    fontFamily: "Space Grotesk, system-ui, sans-serif",
    palette: ["#2E86F2", "#F2A72E", "#6A4FB6", "#0B0F1E"],
  },
  copy: {
    headline: "Shoot your favorite bite",
    subhead: "We'll show you the target — blast it, dodge the rest.",
    ctaStart: "Launch",
    ctaReplay: "Fly again",
    rewardIntro: "You earned",
    emailPrompt: "Email my code",
  },
  assets: shooterProducts,
  roles: {
    product: shooterProducts.map((a) => a.id),
    ship: { fallback: "generatedShape" },
  },
  rewards: [
    { minScore: 0, label: "10% off", percentOff: 10, code: "NOVA10" },
    { minScore: 300, label: "15% off", percentOff: 15, code: "NOVA15" },
    { minScore: 550, label: "20% off", percentOff: 20, code: "NOVA20" },
  ],
  durationSeconds: 40,
  tuning: {
    fireRateHz: 2.2,
    spawnRateHz: 1.0,
    fallSpeed: 120,
    targetRatio: 0.4,
    durationSec: 40,
  },
  meta: {
    mode: "manual",
    generatedAt: GENERATED_AT,
    warnings: [FIXTURE_WARNING],
  },
};

// ---------------------------------------------------------------------------
// Whack — "Burrow Pet Co."
// ---------------------------------------------------------------------------

const whackMoles: ProcessedAsset[] = [
  asset("toy-1", "#C97A3E", "🦴", { name: "Rope Chew Toy", priceMinor: 1200 }),
  asset("toy-2", "#5E8D6A", "🎾", { name: "Squeaky Ball", priceMinor: 800 }),
  asset("toy-3", "#7A6AB6", "🧸", { name: "Plush Otter", priceMinor: 1600 }),
  asset("toy-4", "#D6A63F", "🦆", { name: "Duck Squeaker", priceMinor: 1000 }),
  asset("toy-5", "#4E7A9C", "🪢", { name: "Tug Rope", priceMinor: 900 }),
  asset("toy-6", "#B6472E", "🐿️", { name: "Snuffle Mat", priceMinor: 1800 }),
];

const whackHazards: ProcessedAsset[] = [asset("hazard-sock", "#5A5A5A", "🧦", { name: "Chewed Sock" })];

export const whackGameSpec: GameSpec = {
  id: "demo-whack",
  version: 1,
  template: "whack",
  placements: ["section", "fullpage", "modal"],
  brand: {
    name: "Burrow Pet Co.",
    accent: "#C97A3E",
    secondaryAccent: "#5A5A5A",
    background: "#FBF6EF",
    foreground: "#2A211A",
    fontFamily: "Baloo 2, system-ui, sans-serif",
    palette: ["#C97A3E", "#5E8D6A", "#FBF6EF", "#2A211A"],
  },
  copy: {
    headline: "Whack your way to a deal",
    subhead: "Tap the toys before they duck back down. Leave the chewed sock alone.",
    ctaStart: "Start whacking",
    ctaReplay: "Whack again",
    rewardIntro: "You earned",
    emailPrompt: "Email my code",
  },
  assets: [...whackMoles, ...whackHazards],
  roles: {
    mole: whackMoles.map((a) => a.id),
    hazard: whackHazards.map((a) => a.id),
    stageBackground: { fallback: "brandGradient" },
  },
  rewards: [
    { minScore: 0, label: "10% off", percentOff: 10, code: "WHACK10" },
    { minScore: 400, label: "15% off", percentOff: 15, code: "WHACK15" },
    { minScore: 800, label: "20% off", percentOff: 20, code: "WHACK20" },
  ],
  durationSeconds: 35,
  tuning: {
    holeCount: 7,
    popRateHz: 1.1,
    upTimeSec: 0.9,
    durationSec: 35,
    hazardRatio: 0.2,
  },
  meta: {
    mode: "manual",
    generatedAt: GENERATED_AT,
    warnings: [FIXTURE_WARNING],
  },
};

// ---------------------------------------------------------------------------
// Sweet Spot — "Bloom Coffee Co."
// ---------------------------------------------------------------------------

const sweetSpotPrizes: ProcessedAsset[] = [
  asset("roast-1", "#7B4B2A", "\u2615", { name: "House Blend", priceMinor: 1400, currency: "USD" }),
  asset("roast-2", "#A2673B", "\u2615", { name: "Single Origin Kenya", priceMinor: 1900, currency: "USD" }),
  asset("roast-3", "#5E3A21", "\u2615", { name: "Cold Brew Concentrate", priceMinor: 1700, currency: "USD" }),
  asset("roast-4", "#8C5733", "\u2615", { name: "Seasonal Blend", priceMinor: 1800, currency: "USD" }),
];

export const sweetSpotGameSpec: GameSpec = {
  id: "demo-sweet-spot",
  version: 1,
  template: "sweet_spot",
  placements: ["section", "fullpage", "modal", "ad"],
  brand: {
    name: "Bloom Coffee Co.",
    accent: "#C2612F",
    secondaryAccent: "#2F6FC2",
    background: "#FBF7F2",
    foreground: "#1F1710",
    fontFamily: "Fraunces, Georgia, serif",
    palette: ["#C2612F", "#7B4B2A", "#FBF7F2", "#1F1710"],
  },
  copy: {
    headline: "Hit the sweet spot",
    subhead: "Stop the marker in the band. It gets narrower every time.",
    ctaStart: "Start tapping",
    ctaReplay: "Try again",
    rewardIntro: "You earned",
    emailPrompt: "Email my code",
  },
  assets: sweetSpotPrizes,
  roles: {
    prize: sweetSpotPrizes.map((a) => a.id),
    stageBackground: { fallback: "brandGradient" },
  },
  rewards: [
    { minScore: 0, label: "5% off", percentOff: 5, code: "BLOOM5" },
    { minScore: 240, label: "10% off", percentOff: 10, code: "BLOOM10" },
    { minScore: 520, label: "15% off", percentOff: 15, code: "BLOOM15" },
  ],
  durationSeconds: 40,
  tuning: {
    sweepSpeedHz: 0.7,
    zoneWidth: 0.2,
    zoneShrink: 0.9,
    lives: 3,
    durationSec: 40,
  },
  meta: {
    mode: "manual",
    generatedAt: GENERATED_AT,
    warnings: [FIXTURE_WARNING],
  },
};

// ---------------------------------------------------------------------------
// Simon — "Bright Beat Audio"
// ---------------------------------------------------------------------------

const simonTiles: ProcessedAsset[] = [
  asset("earbuds", "#E24E6B", "🎧", { name: "Wireless Earbuds" }),
  asset("speaker", "#3E8FB0", "🔊", { name: "Mini Speaker" }),
  asset("turntable", "#E2A233", "🎚️", { name: "USB Turntable" }),
  asset("headphones", "#5B4B8A", "🎵", { name: "Studio Headphones" }),
];

export const simonGameSpec: GameSpec = {
  id: "demo-simon",
  version: 1,
  template: "simon",
  placements: ["section", "fullpage", "modal"],
  brand: {
    name: "Bright Beat Audio",
    accent: "#E24E6B",
    secondaryAccent: "#3E8FB0",
    background: "#F5F1FA",
    foreground: "#231B33",
    fontFamily: "Space Grotesk, system-ui, sans-serif",
    palette: ["#E24E6B", "#3E8FB0", "#E2A233", "#5B4B8A"],
  },
  copy: {
    headline: "Remember the beat",
    subhead: "Watch the sequence, then tap it back. It gets longer — and faster — every round.",
    ctaStart: "Start listening",
    ctaReplay: "Play again",
    rewardIntro: "You earned",
    emailPrompt: "Email my code",
  },
  assets: simonTiles,
  roles: {
    tile: simonTiles.map((a) => a.id),
    stageBackground: { fallback: "brandGradient" },
  },
  rewards: [
    { minScore: 0, label: "10% off", percentOff: 10, code: "BEAT10" },
    { minScore: 350, label: "15% off", percentOff: 15, code: "BEAT15" },
    { minScore: 700, label: "20% off", percentOff: 20, code: "BEAT20" },
  ],
  durationSeconds: 60,
  tuning: {
    tileCount: 4,
    flashDurationSec: 0.55,
    gapDurationSec: 0.28,
    maxRounds: 12,
    durationSec: 60,
  },
  meta: {
    mode: "manual",
    generatedAt: GENERATED_AT,
    warnings: [FIXTURE_WARNING],
  },
};

// ---------------------------------------------------------------------------
// Slice — "Squeeze Co."
// ---------------------------------------------------------------------------

const sliceCollectibles: ProcessedAsset[] = [
  asset("juice-1", "#E8A93E", "🍊", { name: "Cold-Pressed Orange", priceMinor: 600 }),
  asset("juice-2", "#6FAE4A", "🥝", { name: "Kiwi Lime Blend", priceMinor: 700 }),
  asset("juice-3", "#D6456B", "🍓", { name: "Strawberry Basil", priceMinor: 650 }),
  asset("juice-4", "#E2C93E", "🍍", { name: "Pineapple Ginger", priceMinor: 700 }),
  asset("juice-5", "#8A5AA8", "🫐", { name: "Blueberry Beet", priceMinor: 750 }),
  asset("juice-6", "#4FA88A", "🥬", { name: "Green Detox", priceMinor: 680 }),
];

const sliceHazards: ProcessedAsset[] = [asset("hazard-cup", "#5A5A5A", "🗑️", { name: "Empty Cup" })];

export const sliceGameSpec: GameSpec = {
  id: "demo-slice",
  version: 1,
  template: "slice",
  placements: ["section", "fullpage", "modal"],
  brand: {
    name: "Squeeze Co.",
    accent: "#E8A93E",
    secondaryAccent: "#5A5A5A",
    background: "#FBFAF3",
    foreground: "#233421",
    fontFamily: "Poppins, system-ui, sans-serif",
    palette: ["#E8A93E", "#6FAE4A", "#D6456B", "#FBFAF3"],
  },
  copy: {
    headline: "Slice into savings",
    subhead: "Swipe across the bottles before they drop. Leave the empty cups alone.",
    ctaStart: "Start slicing",
    ctaReplay: "Slice again",
    rewardIntro: "You earned",
    emailPrompt: "Email my code",
  },
  assets: [...sliceCollectibles, ...sliceHazards],
  roles: {
    collectible: sliceCollectibles.map((a) => a.id),
    hazard: sliceHazards.map((a) => a.id),
    stageBackground: { fallback: "brandGradient" },
  },
  rewards: [
    { minScore: 0, label: "10% off", percentOff: 10, code: "SLICE10" },
    { minScore: 400, label: "15% off", percentOff: 15, code: "SLICE15" },
    { minScore: 800, label: "20% off", percentOff: 20, code: "SLICE20" },
  ],
  durationSeconds: 35,
  tuning: {
    launchRateHz: 1.1,
    launchSpeed: 650,
    gravity: 1400,
    durationSec: 35,
    hazardRatio: 0.18,
  },
  meta: {
    mode: "manual",
    generatedAt: GENERATED_AT,
    warnings: [FIXTURE_WARNING],
  },
};

/** Zero-asset variant. Sweet Spot is the only template with no hard-required
 * role, so this is the fixture that proves the "site gave us almost nothing"
 * path really renders: no prize images, no backdrop, brand colour only. */
export const sweetSpotBareGameSpec: GameSpec = {
  ...sweetSpotGameSpec,
  id: "demo-sweet-spot-bare",
  assets: [],
  roles: {
    prize: { fallback: "logo" },
    stageBackground: { fallback: "brandGradient" },
  },
};

// ---------------------------------------------------------------------------
// Showcase skins — the same two templates restyled for different brands.
// Used only by the marketing homepage slideshow to prove the product works
// across verticals; real GameSpecs mounted through the real runtime, not
// screenshots.
// ---------------------------------------------------------------------------

const skincareCollectibles: ProcessedAsset[] = [
  asset("serum-1", "#C98BA5", "🧴", { name: "Rose Glow Serum", priceMinor: 3200, currency: "USD" }),
  asset("serum-2", "#B87A9B", "🧴", { name: "Vitamin C Drops", priceMinor: 2800, currency: "USD" }),
  asset("serum-3", "#A66B95", "🧴", { name: "Overnight Repair Oil", priceMinor: 3600, currency: "USD" }),
  asset("serum-4", "#D497AE", "🧴", { name: "Hydra Mist", priceMinor: 2200, currency: "USD" }),
  asset("serum-5", "#9C5F8E", "🧴", { name: "Retinol Complex", priceMinor: 4200, currency: "USD" }),
  asset("serum-6", "#C286A8", "🧴", { name: "Clay Mask Duo", priceMinor: 2600, currency: "USD" }),
  asset("serum-7", "#B074A0", "🧴", { name: "Eye Cream", priceMinor: 3100, currency: "USD" }),
  asset("serum-8", "#DA9FB8", "🧴", { name: "SPF Glow Fluid", priceMinor: 2900, currency: "USD" }),
];

export const skincareGameSpec: GameSpec = {
  ...catchGameSpec,
  id: "demo-catch-lumen",
  brand: {
    name: "Lumen Skincare",
    accent: "#C98BA5",
    secondaryAccent: "#5B4B8A",
    background: "#FBF4F7",
    foreground: "#2B2230",
    fontFamily: "DM Sans, system-ui, sans-serif",
    palette: ["#C98BA5", "#5B4B8A", "#FBF4F7", "#2B2230"],
  },
  copy: {
    headline: "Catch your glow",
    subhead: "Drag the tray, catch the serums, dodge the empties.",
    ctaStart: "Start catching",
    ctaReplay: "Catch again",
    rewardIntro: "You earned",
    emailPrompt: "Email my code",
  },
  assets: skincareCollectibles,
  roles: {
    ...catchGameSpec.roles,
    collectible: skincareCollectibles.map((a) => a.id),
  },
  rewards: [
    { minScore: 0, label: "10% off", percentOff: 10, code: "GLOW10" },
    { minScore: 450, label: "15% off", percentOff: 15, code: "GLOW15" },
    { minScore: 900, label: "20% off", percentOff: 20, code: "GLOW20" },
  ],
};

const sneakerHeroes: ProcessedAsset[] = [
  asset("sneaker-1", "#1C1C1C", "👟", { name: "Air Runner Low", priceMinor: 8900, currency: "USD" }),
  asset("sneaker-2", "#D9772A", "👟", { name: "Trail Max", priceMinor: 11900, currency: "USD" }),
  asset("sneaker-3", "#2A2A2A", "👟", { name: "Court Classic", priceMinor: 7400, currency: "USD" }),
  asset("sneaker-4", "#B94A2C", "👟", { name: "Retro High", priceMinor: 13900, currency: "USD" }),
  asset("sneaker-5", "#333333", "👟", { name: "Featherlight Racer", priceMinor: 9900, currency: "USD" }),
  asset("sneaker-6", "#C25A1E", "👟", { name: "Street Slip-On", priceMinor: 6900, currency: "USD" }),
];

export const sneakerGameSpec: GameSpec = {
  ...guessPriceGameSpec,
  id: "demo-guess-price-kicks",
  brand: {
    name: "Kicks & Co",
    accent: "#D9772A",
    secondaryAccent: "#1C1C1C",
    background: "#F5F1EA",
    foreground: "#1C1C1C",
    fontFamily: "Montserrat, system-ui, sans-serif",
    palette: ["#D9772A", "#1C1C1C", "#F5F1EA", "#ffffff"],
  },
  copy: {
    headline: "How well do you know our drops?",
    subhead: "Guess the price. Get closer, save more.",
    ctaStart: "Start guessing",
    ctaReplay: "Try again",
    rewardIntro: "You earned",
    emailPrompt: "Email my code",
  },
  assets: sneakerHeroes,
  roles: {
    ...guessPriceGameSpec.roles,
    hero: sneakerHeroes.map((a) => a.id),
  },
  rewards: [
    { minScore: 0, label: "10% off", percentOff: 10, code: "KICKS10" },
    { minScore: 500, label: "15% off", percentOff: 15, code: "KICKS15" },
    { minScore: 950, label: "20% off", percentOff: 20, code: "KICKS20" },
  ],
};

/** Keyed by the slug app/play/[slug]/page.tsx serves directly, no DB hit. */
export const fixtureGameSpecs: Record<string, GameSpec> = {
  "demo-catch": catchGameSpec,
  "demo-guess-price": guessPriceGameSpec,
  "demo-chain-pop": chainPopGameSpec,
  "demo-chomp": chompGameSpec,
  "demo-whack": whackGameSpec,
  "demo-simon": simonGameSpec,
  "demo-slice": sliceGameSpec,
  "demo-shooter": shooterGameSpec,
  "demo-catch-lumen": skincareGameSpec,
  "demo-guess-price-kicks": sneakerGameSpec,
  "demo-sweet-spot": sweetSpotGameSpec,
  "demo-sweet-spot-bare": sweetSpotBareGameSpec,
};
