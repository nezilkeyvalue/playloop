// lib/engine/brandThemes.ts
//
// Shared theme vocabulary for inferring brand context from a URL/catalog and
// scoring how well each game template matches that context. Used by
// suggestTemplates.ts and matcher.ts — pure, no I/O.

import type { AssetInventory, GameCapability, TemplateId } from "@/lib/engine/types";
/** Canonical theme tags — keep in sync with capability JSON `themeTags`. */
export const THEME_TAGS = [
  "athletic",
  "footwear",
  "sports",
  "energy",
  "youth",
  "fashion",
  "apparel",
  "accessories",
  "beauty",
  "cpg",
  "food",
  "snacks",
  "toys",
  "electronics",
  "luxury",
  "priced",
  "general",
] as const;

export type ThemeTag = (typeof THEME_TAGS)[number];

/** Related tags contribute partial credit when scoring template fit. */
const RELATED_THEMES: Record<string, string[]> = {
  athletic: ["sports", "footwear", "energy"],
  footwear: ["athletic", "sports", "apparel"],
  sports: ["athletic", "energy", "youth"],
  energy: ["athletic", "sports", "youth"],
  apparel: ["fashion", "accessories", "footwear"],
  fashion: ["apparel", "beauty", "luxury"],
  snacks: ["food", "cpg", "toys"],
  food: ["snacks", "cpg"],
  cpg: ["food", "snacks", "beauty"],
  priced: ["apparel", "accessories", "electronics"],
  general: [],
};

export interface InferSiteThemesInput {
  inventory: AssetInventory;
  businessName?: string;
  businessDescription?: string;
  sourceUrl?: string;
}

export function inferSiteThemes(input: InferSiteThemesInput): string[] {
  const corpus = buildCorpus(input);
  const found = new Set<string>();

  const rules: { theme: string; pattern: RegExp }[] = [
    { theme: "athletic", pattern: /\b(nike|adidas|puma|reebok|under armour|new balance|asics|sport|athletic|performance|running|training)\b/i },
    { theme: "footwear", pattern: /\b(shoe|sneaker|footwear|trainer|boot|sandal|slide)\b/i },
    { theme: "sports", pattern: /\b(sport|team|league|fitness|gym|workout|marathon)\b/i },
    { theme: "energy", pattern: /\b(energy|fast|action|performance|pro\b)\b/i },
    { theme: "youth", pattern: /\b(kids|youth|teen|school)\b/i },
    { theme: "beauty", pattern: /\b(beauty|cosmetic|skincare|makeup|fragrance|serum)\b/i },
    { theme: "fashion", pattern: /\b(fashion|streetwear|apparel|clothing|wear|outfit)\b/i },
    { theme: "apparel", pattern: /\b(shirt|dress|pants|jacket|hoodie|tee|mens|women|apparel)\b/i },
    { theme: "accessories", pattern: /\b(bag|watch|jewelry|accessory|sunglasses|hat)\b/i },
    { theme: "food", pattern: /\b(food|coffee|tea|beverage|drink|restaurant|grocery)\b/i },
    { theme: "snacks", pattern: /\b(snack|candy|chocolate|chip|cookie)\b/i },
    { theme: "toys", pattern: /\b(toy|game|plush|lego|playset)\b/i },
    { theme: "electronics", pattern: /\b(electronic|gadget|phone|laptop|audio|tech)\b/i },
    { theme: "luxury", pattern: /\b(luxury|premium|designer|couture)\b/i },
    { theme: "priced", pattern: /\b(\$\d|price|sale|discount|off\b)/i },
    { theme: "cpg", pattern: /\b(home|clean|vitamin|supplement|household)\b/i },
  ];

  for (const { theme, pattern } of rules) {
    if (pattern.test(corpus)) found.add(theme);
  }

  if (found.size === 0) found.add("general");
  return [...found];
}

function buildCorpus(input: InferSiteThemesInput): string {
  const parts: string[] = [];
  if (input.sourceUrl) {
    try {
      const u = new URL(input.sourceUrl);
      parts.push(u.hostname, u.pathname);
    } catch {
      parts.push(input.sourceUrl);
    }
  }
  if (input.businessName) parts.push(input.businessName);
  if (input.businessDescription) parts.push(input.businessDescription);
  for (const a of input.inventory.assets) {
    if (a.data?.name) parts.push(a.data.name);
    if (a.data?.category) parts.push(a.data.category);
  }
  return parts.join(" ").toLowerCase();
}

export function themeFitScore(cap: GameCapability, siteThemes: string[]): number {
  const tags = cap.themeTags;
  if (!tags || tags.length === 0) {
    return siteThemes.includes("general") ? 0.45 : 0.35;
  }

  const siteSet = new Set(siteThemes);
  let score = 0;
  let maxPossible = 0;

  for (const tag of tags) {
    maxPossible += 1;
    if (siteSet.has(tag)) {
      score += 1;
      continue;
    }
    const related = RELATED_THEMES[tag] ?? [];
    if (related.some((r) => siteSet.has(r))) score += 0.5;
  }

  if (maxPossible === 0) return 0.4;
  return clamp(score / maxPossible, 0.2, 1);
}

export function themePickReason(template: TemplateId, siteThemes: string[], cap?: GameCapability): string {
  const name = cap?.name ?? template;
  const athletic = siteThemes.some((t) => t === "athletic" || t === "sports" || t === "footwear");
  if (template === "runner" && athletic) {
    return "Athletic brand — Runner matches the sports energy of your catalog.";
  }
  if (cap?.brandFit) return cap.brandFit;
  if (siteThemes.length > 0 && siteThemes[0] !== "general") {
    const label = siteThemes.slice(0, 2).map(formatThemeLabel).join(" · ");
    return `${label} — ${name} fits what we detected on your site.`;
  }
  return cap?.summary ?? `${name} fits the products we found on your site.`;
}

function formatThemeLabel(tag: string): string {
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function themeAlignmentBonus(cap: GameCapability, siteThemes: string[]): number {
  const fit = themeFitScore(cap, siteThemes);
  let bonus = 0;
  if (fit > 0.5) bonus += 0.03 * ((fit - 0.5) / 0.5);
  bonus += themeRecommendationBoost(cap.id, siteThemes);
  return bonus;
}

/** Strong nudge for templates that are the canonical fit for a theme combo
 * (e.g. athletic footwear → runner), applied in matcher + suggestion ranking. */
export function themeRecommendationBoost(template: TemplateId, siteThemes: string[]): number {
  const set = new Set(siteThemes);
  const athletic = set.has("athletic") || set.has("sports");
  const footwear = set.has("footwear");
  if (template === "runner" && athletic && (footwear || set.has("sports"))) return 0.08;
  if (template === "shooter" && athletic && set.has("youth") && !footwear) return 0.04;
  if (template === "guess_price" && set.has("priced") && (set.has("apparel") || set.has("accessories"))) {
    return 0.05;
  }
  if (template === "chain_pop" && (set.has("beauty") || set.has("snacks"))) return 0.05;
  return 0;
}

export function categoryFromThemes(siteThemes: string[]): string | null {
  if (siteThemes.includes("athletic") || siteThemes.includes("footwear")) return "Athletic & footwear";
  if (siteThemes.includes("beauty")) return "Beauty";
  if (siteThemes.includes("food") || siteThemes.includes("snacks")) return "Food & beverage";
  if (siteThemes.includes("electronics")) return "Electronics";
  if (siteThemes.includes("fashion") || siteThemes.includes("apparel")) return "Fashion & apparel";
  if (siteThemes.includes("toys")) return "Toys & games";
  return null;
}
