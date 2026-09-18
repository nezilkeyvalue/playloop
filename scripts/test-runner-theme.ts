// scripts/test-runner-theme.ts
//
// Checks lib/runtime/games/runnerTheme.ts — the runner template's brand
// skin. Three things are worth protecting:
//
//   1. No undefined colours, ever. runner.ts paints every field of this
//      object straight into a canvas fillStyle; one undefined leaf is a
//      transparent sky or a black board, on a merchant's live embed.
//   2. The brand tints the environment, it does not replace it. The sky
//      must stay a sky when the brand's primary is bright red — the
//      "cohesive palette, not a monochrome screen" rule.
//   3. Merge precedence: derived < named preset < host override, with
//      untouched fields preserved at every step.
//
// Run: npm run test:runner-theme

import {
  RUNNER_THEME_PRESETS,
  deriveTheme,
  mixHex,
  resolveRunnerTheme,
  type RunnerTheme,
} from "../lib/runtime/games/runnerTheme";
import type { BrandKit } from "../lib/engine/types";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL  ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok    ${message}`);
}

const COLOR = /^(#[0-9a-f]{6}|rgba?\([^)]+\))$/i;

/** Every string leaf under the colour-bearing sections. */
function colourLeaves(theme: RunnerTheme): [string, string][] {
  const sections = ["colors", "environment", "character", "hurdle", "ui"] as const;
  const out: [string, string][] = [];
  for (const section of sections) {
    for (const [key, value] of Object.entries(theme[section])) {
      if (typeof value === "string") out.push([`${section}.${key}`, value]);
    }
  }
  out.push(["advertising.wallBackground", theme.advertising.wallBackground]);
  out.push(["advertising.wallText", theme.advertising.wallText]);
  out.push(["advertising.accentColor", theme.advertising.accentColor]);
  return out;
}

function distance(a: string, b: string): number {
  const rgb = (hex: string) => {
    const n = parseInt(hex.replace("#", ""), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  };
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return Math.sqrt((r1! - r2!) ** 2 + (g1! - g2!) ** 2 + (b1! - b2!) ** 2);
}

function brand(overrides: Partial<BrandKit> = {}): BrandKit {
  return {
    accent: "#e11d2f",
    background: "#ffffff",
    foreground: "#101010",
    fontFamily: "Inter",
    palette: [],
    ...overrides,
  };
}

// --- 1. no undefined / malformed colours, on any input ---------------------
const inputs: [string, BrandKit][] = [
  ["a normal brand", brand()],
  ["a brand with a secondary accent", brand({ secondaryAccent: "#123456", name: "Pacer" })],
  ["a brand whose accent is malformed", brand({ accent: "not-a-colour" })],
  ["a brand whose accent is 3-digit hex", brand({ accent: "#f00" })],
];
for (const [label, kit] of inputs) {
  const theme = deriveTheme(kit);
  const bad = colourLeaves(theme).filter(([, value]) => !COLOR.test(value));
  assert(bad.length === 0, `${label}: every colour is a usable hex/rgba (${bad.map(([k]) => k).join(", ") || "none bad"})`);
}

// --- 2. the brand tints the world, it doesn't take it over -----------------
const red = deriveTheme(brand({ accent: "#ff0000" }));
assert(red.character.shirt === "#ff0000", "the brand primary lands on the kit outright");
assert(red.hurdle.stripe === "#ff0000", "the brand primary lands on the hurdle stripe outright");
assert(
  distance(red.environment.skyTop, "#ff0000") > 150,
  `a red brand keeps a blue sky (distance ${Math.round(distance(red.environment.skyTop, "#ff0000"))} from pure red)`,
);
assert(
  distance(red.environment.grass, "#ff0000") > 120,
  "a red brand keeps green grass",
);
const blue = deriveTheme(brand({ accent: "#0044ff" }));
assert(
  distance(red.environment.trackNear, blue.environment.trackNear) > 8,
  "two different brands still get visibly different track surfaces (the tint is real)",
);
assert(
  distance(red.environment.trackNear, "#d2703f") < 60,
  "…but the track stays recognisably terracotta either way",
);

// --- 3. merge precedence ---------------------------------------------------
const derived = deriveTheme(brand());
const withPreset = resolveRunnerTheme(brand(), "runner:midnight");
assert(
  withPreset.environment.skyTop === RUNNER_THEME_PRESETS["runner:midnight"]!.environment!.skyTop,
  "a named preset overrides the derived environment",
);
assert(
  withPreset.character.shirt === derived.character.shirt,
  "a preset that says nothing about the kit leaves the derived kit alone",
);

const hosted = resolveRunnerTheme(brand(), "runner:midnight", {
  character: { shoes: "#00ff88" },
  environment: { skyTop: "#ffffff" },
  advertising: { slogans: ["HOST SLOGAN"] },
});
assert(hosted.environment.skyTop === "#ffffff", "the host override beats the preset");
assert(hosted.character.shoes === "#00ff88", "the host override reaches the character");
assert(hosted.character.shirt === derived.character.shirt, "an unmentioned character field survives both merges");
assert(hosted.advertising.slogans.join() === "HOST SLOGAN", "advertising copy is host-configurable");
assert(
  resolveRunnerTheme(brand(), undefined, { advertising: { primaryMessage: "GO FURTHER" } }).advertising.primaryMessage ===
    "GO FURTHER",
  "a host headline message reaches the boards",
);
assert(hosted.advertising.panels.length === derived.advertising.panels.length, "the panel cycle survives a slogans-only override");

// --- 4. the no-theme path is a complete theme ------------------------------
const bare = resolveRunnerTheme(brand(), undefined, undefined);
assert(colourLeaves(bare).every(([, v]) => COLOR.test(v)), "no theme supplied still yields a complete palette");
assert(bare.advertising.slogans.length === 0, "no slogans are invented for a merchant who wrote none");
assert(bare.advertising.panels.length > 0, "the wall still has a board cycle without any slogans");
assert(bare.advertising.primaryMessage === undefined, "no headline ad copy is invented either");
assert(bare.branding.logoPosition === "none", "no logo in the BrandKit means no logo in the world");
assert(
  resolveRunnerTheme(brand({ logoUrl: "https://x/logo.png" })).branding.logoPosition === "banner",
  "a logo in the BrandKit switches the world's logo slots on",
);
assert(
  resolveRunnerTheme(brand(), "some_other_templates_theme").environment.skyTop === derived.environment.skyTop,
  "an unknown theme key is ignored rather than breaking the palette",
);

// --- 5. mixHex degrades rather than painting black -------------------------
assert(mixHex("#ff0000", "oops", 0.5) === "#ff0000", "mixHex returns the base colour when the other side is malformed");
assert(mixHex("#000000", "#ffffff", 0.5) === "#808080", "mixHex blends linearly");

console.log(process.exitCode ? "\nrunner theme: FAILURES" : "\nrunner theme: all checks passed");
