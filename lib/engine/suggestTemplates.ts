// lib/engine/suggestTemplates.ts
//
// After the deterministic matcher scores every template, one lightweight
// Gemini call infers site/brand context and re-ranks *eligible* templates.
// Eligibility and asset fit still come from matcher.ts — theme tags + AI
// reorder eligible games; they cannot surface a template the matcher ruled out.

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { Schema } from "@google/generative-ai";
import {
  categoryFromThemes,
  themeFitScore,
  themePickReason,
  themeRecommendationBoost,
} from "@/lib/engine/brandThemes";
import type {
  AssetInventory,
  GameCapability,
  MatchReport,
  SiteContext,
  TemplateId,
  TemplateMatch,
  TemplateRanking,
} from "@/lib/engine/types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const SUGGEST_TIMEOUT_MS = 20_000;
const MATCHER_WEIGHT = 0.3;
const THEME_WEIGHT = 0.35;
const AI_WEIGHT = 0.35;

export interface SuggestTemplatesInput {
  match: MatchReport;
  inventory: AssetInventory;
  capabilities: GameCapability[];
  businessName?: string;
  businessDescription?: string;
  sourceUrl?: string;
  /** Precomputed in runExtraction — shared with matcher theme bonus. */
  siteThemes: string[];
}

const SUGGEST_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    category: { type: SchemaType.STRING },
    brandSummary: { type: SchemaType.STRING },
    rankings: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          template: { type: SchemaType.STRING },
          contextualFit: { type: SchemaType.NUMBER },
          reason: { type: SchemaType.STRING },
        },
        required: ["template", "contextualFit", "reason"],
      },
    },
  },
  required: ["category", "brandSummary", "rankings"],
};

interface SuggestPayload {
  siteContext: SiteContext;
  rankings: TemplateRanking[];
}

export async function suggestTemplates(input: SuggestTemplatesInput): Promise<MatchReport> {
  const eligibleIds = new Set(
    input.match.results.filter((r) => r.eligible).map((r) => r.template),
  );
  if (eligibleIds.size <= 1) {
    return attachSiteContextOnly(input.match, input);
  }

  const fallback = deterministicSuggest(input);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return mergeSuggestions(input.match, fallback, input.capabilities, input.siteThemes, {
      suggestionSource: "deterministic",
      suggestionError: "GEMINI_API_KEY is not set",
    });
  }

  try {
    const raw = await Promise.race([callGeminiSuggest(apiKey, input, eligibleIds), suggestTimeout(SUGGEST_TIMEOUT_MS)]);
    const payload = validateSuggestResponse(raw, eligibleIds, input.capabilities, fallback, input.siteThemes);
    return mergeSuggestions(input.match, payload, input.capabilities, input.siteThemes, {
      suggestionSource: "gemini",
      suggestionError: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[suggestTemplates] Gemini template suggestion failed:", message);
    return mergeSuggestions(input.match, fallback, input.capabilities, input.siteThemes, {
      suggestionSource: "deterministic",
      suggestionError: message,
    });
  }
}

function attachSiteContextOnly(match: MatchReport, input: SuggestTemplatesInput): MatchReport {
  const category = categoryFromThemes(input.siteThemes);
  const summary = buildDeterministicSummary(input, category);
  return {
    ...match,
    siteContext: { category, summary, themes: input.siteThemes },
  };
}

function suggestTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Template suggestion timed out")), ms);
  });
}

async function callGeminiSuggest(
  apiKey: string,
  input: SuggestTemplatesInput,
  eligibleIds: Set<TemplateId>,
): Promise<unknown> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { responseMimeType: "application/json", responseSchema: SUGGEST_SCHEMA },
  });

  const request = buildSuggestRequest(input, eligibleIds);
  const prompt = [
    "You recommend mini-game templates for an e-commerce brand's playable ad.",
    "You may ONLY rank templates listed under `eligibleTemplates` — never invent ids.",
    "Use `contextualFit` 0..1 for how well the game matches this brand's category, catalog, and shopper vibe.",
    "Brand theme and identity may outweigh small gaps in `matcherScore` among eligible templates.",
    "Examples: athletic/footwear/sports brands (e.g. Nike, Puma) → `runner` must rank highest among eligible templates; then `shooter` or `catch`.",
    "Beauty/snacks with many distinct packshots → `chain_pop`. Priced apparel → `guess_price`.",
    "Use each template's `themeTags` and `themeFitScore` together with `siteThemes`.",
    "Keep each `reason` to one short sentence a merchant would understand.",
    "Respond ONLY with JSON matching the schema.",
    "",
    JSON.stringify(request, null, 2),
  ].join("\n");

  const result = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
  return JSON.parse(result.response.text());
}

function buildSuggestRequest(input: SuggestTemplatesInput, eligibleIds: Set<TemplateId>) {
  const byTemplate = new Map(input.match.results.map((r) => [r.template, r]));
  const capsById = new Map(input.capabilities.map((c) => [c.id, c]));

  const eligibleTemplates = [...eligibleIds].map((id) => {
    const r = byTemplate.get(id);
    const cap = capsById.get(id);
    const assetCount = r
      ? Object.values(r.assignments ?? {}).reduce((sum, v) => sum + (Array.isArray(v) ? v.length : 0), 0)
      : 0;
    const themeFit = cap ? themeFitScore(cap, input.siteThemes) : 0.5;
    return {
      id,
      name: cap?.name ?? id,
      summary: cap?.summary ?? "",
      brandFit: cap?.brandFit ?? null,
      themeTags: cap?.themeTags ?? [],
      themeFitScore: themeFit,
      matcherScore: r?.score ?? 0,
      assetCount,
    };
  });

  const productNames = input.inventory.assets
    .map((a) => a.data?.name)
    .filter((n): n is string => Boolean(n))
    .slice(0, 12);
  const categories = [
    ...new Set(
      input.inventory.assets.map((a) => a.data?.category).filter((c): c is string => Boolean(c)),
    ),
  ].slice(0, 6);

  return {
    sourceUrl: input.sourceUrl ?? input.inventory.source.url ?? null,
    siteThemes: input.siteThemes,
    business: {
      name: input.businessName ?? null,
      description: input.businessDescription ?? null,
    },
    catalog: {
      productCount: input.inventory.assets.length,
      namedProducts: productNames,
      categories,
      withPrice: input.inventory.dataCoverage.withPrice,
      withName: input.inventory.dataCoverage.withName,
      platform: input.inventory.source.platform ?? null,
    },
    brand: {
      palette: input.inventory.brand.palette,
    },
    eligibleTemplates,
  };
}

function validateSuggestResponse(
  raw: unknown,
  eligibleIds: Set<TemplateId>,
  capabilities: GameCapability[],
  fallback: SuggestPayload,
  siteThemes: string[],
): SuggestPayload {
  if (!raw || typeof raw !== "object") return fallback;
  const obj = raw as Record<string, unknown>;

  const category =
    typeof obj.category === "string" && obj.category.trim() ? obj.category.trim() : fallback.siteContext.category;
  const summary =
    typeof obj.brandSummary === "string" && obj.brandSummary.trim()
      ? obj.brandSummary.trim()
      : fallback.siteContext.summary;

  const capsById = new Map(capabilities.map((c) => [c.id, c]));
  const rankings: TemplateRanking[] = [];
  const seen = new Set<TemplateId>();

  if (Array.isArray(obj.rankings)) {
    for (const row of obj.rankings) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const template = typeof rec.template === "string" ? (rec.template as TemplateId) : undefined;
      if (!template || !eligibleIds.has(template) || !capsById.has(template) || seen.has(template)) continue;
      seen.add(template);
      const cap = capsById.get(template)!;
      const themeFallback = themeFitScore(cap, siteThemes);
      const contextualFit = clampNumber(rec.contextualFit, 0, 1, themeFallback);
      const reason =
        typeof rec.reason === "string" && rec.reason.trim()
          ? rec.reason.trim()
          : themePickReason(template, siteThemes, cap);
      rankings.push({ template, contextualFit, reason });
    }
  }

  for (const id of eligibleIds) {
    if (seen.has(id)) continue;
    const fb = fallback.rankings.find((r) => r.template === id);
    rankings.push(
      fb ?? {
        template: id,
        contextualFit: themeFitScore(capsById.get(id)!, siteThemes),
        reason: themePickReason(id, siteThemes, capsById.get(id)),
      },
    );
  }

  return {
    siteContext: { category, summary, themes: siteThemes },
    rankings,
  };
}

function deterministicSuggest(input: SuggestTemplatesInput): SuggestPayload {
  const eligible = input.match.results.filter((r) => r.eligible);
  const capsById = new Map(input.capabilities.map((c) => [c.id, c]));

  const category = categoryFromThemes(input.siteThemes);
  const summary = buildDeterministicSummary(input, category);

  const rankings: TemplateRanking[] = eligible.map((r) => {
    const cap = capsById.get(r.template);
    const contextualFit = cap ? themeFitScore(cap, input.siteThemes) : 0.5;
    const reason = themePickReason(r.template, input.siteThemes, cap);
    return { template: r.template, contextualFit, reason };
  });

  return { siteContext: { category, summary, themes: input.siteThemes }, rankings };
}

function buildDeterministicSummary(input: SuggestTemplatesInput, category: string | null): string | null {
  const name = input.businessName?.trim();
  const n = input.inventory.dataCoverage.withName;
  if (name && category) return `${name} — ${category} catalog with ${n} named product(s) detected.`;
  if (name) return `${name} — ${n} product image(s) ready for a mini-game.`;
  if (input.businessDescription?.trim()) return input.businessDescription.trim().slice(0, 240);
  return null;
}

interface MergeMeta {
  suggestionSource: MatchReport["suggestionSource"];
  suggestionError?: string | null;
}

function mergeSuggestions(
  match: MatchReport,
  payload: SuggestPayload,
  capabilities: GameCapability[],
  siteThemes: string[],
  meta?: MergeMeta,
): MatchReport {
  const capsById = new Map(capabilities.map((c) => [c.id, c]));
  const rankingByTemplate = new Map(payload.rankings.map((r) => [r.template, r]));
  const eligible = match.results.filter((r) => r.eligible);

  let recommended = [...eligible]
    .sort(
      (a, b) =>
        blendedRankScore(b, rankingByTemplate, capsById, siteThemes) -
        blendedRankScore(a, rankingByTemplate, capsById, siteThemes),
    )
    .map((r) => r.template);
  recommended = applyThemePreferredOrder(
    recommended,
    siteThemes,
    new Set(eligible.map((r) => r.template)),
  );

  const results: TemplateMatch[] = match.results.map((r) => {
    const pick = rankingByTemplate.get(r.template);
    return pick ? { ...r, pickReason: pick.reason } : r;
  });

  return {
    ...match,
    results,
    recommended,
    siteContext: payload.siteContext,
    templateRankings: payload.rankings,
    suggestionSource: meta?.suggestionSource ?? "deterministic",
    suggestionError: meta?.suggestionError ?? null,
  };
}

function blendedRankScore(
  row: TemplateMatch,
  rankings: Map<TemplateId, TemplateRanking>,
  capsById: Map<TemplateId, GameCapability>,
  siteThemes: string[],
): number {
  const cap = capsById.get(row.template);
  const theme = cap ? themeFitScore(cap, siteThemes) : 0.5;
  const ai = rankings.get(row.template)?.contextualFit ?? theme;
  const boost = themeRecommendationBoost(row.template, siteThemes);
  return MATCHER_WEIGHT * row.score + THEME_WEIGHT * theme + AI_WEIGHT * ai + boost;
}

/** When catalog themes clearly call for a template (athletic footwear → runner),
 * pin it first if eligible — Gemini + matcher cannot demote below #1. */
function applyThemePreferredOrder(
  recommended: TemplateId[],
  siteThemes: string[],
  eligibleIds: Set<TemplateId>,
): TemplateId[] {
  const themes = new Set(siteThemes);
  const athletic = themes.has("athletic") || themes.has("sports");
  if (athletic && (themes.has("footwear") || themes.has("sports")) && eligibleIds.has("runner")) {
    return ["runner", ...recommended.filter((id) => id !== "runner")];
  }
  return recommended;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
