// scripts/test-theme.ts
//
// Checks GameSpec.meta.theme, the one field that lets a runtime module
// dress itself for a merchant's vertical (catch.ts's pet-supplies bowl and
// dog silhouettes today).
//
// The invariant that matters is the NEGATIVE one: a theme is decoration, so
// anything the pipeline can't render must arrive as `undefined` and every
// spec written before the field existed must keep rendering exactly as it
// did. A stray slug in a spec is a string nothing reads; a stray slug that
// a template half-recognises is a game that looks wrong for its brand.
//
// Run: npm run test:theme

import { normalizeTheme } from "../lib/engine/compose";
import { fixtureGameSpecs } from "../lib/runtime/fixtures/sampleGameSpec";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL  ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok    ${message}`);
}

// --- 1. only themes a runtime module can actually render survive ---------
const recognised: [string, string][] = [
  ["pet_supplies", "pet_supplies"],
  ["Pet Supplies", "pet_supplies"],
  ["pet-supplies", "pet_supplies"],
  ["  PET_SUPPLIES  ", "pet_supplies"],
];
for (const [input, expected] of recognised) {
  assert(normalizeTheme(input) === expected, `"${input}" normalizes to ${expected}`);
}

// "general_retail" is what deterministicFallback always emits, so it runs on
// every generation in an environment with no GEMINI_API_KEY. It has no
// dressing, so it must NOT reach the spec.
const dropped = ["general_retail", "coffee", "apparel", "", "  ", "pet_supplies_extra", undefined];
for (const input of dropped) {
  assert(normalizeTheme(input) === undefined, `${JSON.stringify(input)} is dropped, not carried into the spec`);
}

// --- 2. exactly the fixtures that opt in carry a theme ------------------
const themed = Object.entries(fixtureGameSpecs).filter(([, spec]) => spec.meta.theme !== undefined);
assert(
  themed.length === 1 && themed[0]?.[0] === "demo-catch-pets",
  `exactly one fixture carries a theme (${themed.map(([id]) => id).join(", ") || "none"})`,
);
assert(
  themed[0]?.[1].meta.theme === "pet_supplies",
  `demo-catch-pets carries theme "pet_supplies" (got ${JSON.stringify(themed[0]?.[1].meta.theme)})`,
);

// Every other fixture must be theme-free — that is the "renders exactly as
// it always did" guarantee for every spec already stored in a database.
const catchFixtures = Object.entries(fixtureGameSpecs).filter(([, s]) => s.template === "catch");
assert(catchFixtures.length > 1, `more than one catch fixture exists to compare against (${catchFixtures.length})`);
for (const [id, spec] of catchFixtures) {
  if (id === "demo-catch-pets") continue;
  assert(spec.meta.theme === undefined, `${id} (catch) stays untouched by the theme field`);
}

if (process.exitCode) console.error("\ntheme: FAILED");
else console.log("\ntheme: all checks passed");
