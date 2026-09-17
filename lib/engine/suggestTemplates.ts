// lib/engine/suggestTemplates.ts
//
// After the deterministic matcher scores every template, one lightweight
// Gemini call infers site/brand context and re-ranks *eligible* templates.
// Eligibility and asset fit still come from matcher.ts — AI only breaks ties
// and writes picker copy; it cannot surface a template the matcher ruled out.

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { Schema } from "@google/generative-ai";
import type {
  AssetInventory,
  GameCapability,
  MatchReport,
  SiteContext,
  TemplateId,
  TemplateMatch,
  TemplateRanking,
} from "@/lib/engine/types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const SUGGEST_TIMEOUT_MS = 12_000;
const MATCHER_WEIGHT = 0.55;
const AI_WEIGHT = 0.45;

export interface SuggestTemplatesInput {
  match: MatchReport;
  inventory: AssetInventory;
  capabilities: GameCapability[];
  businessName?: string;
  businessDescription?: string;
  sourceUrl?: string;
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
  if (eligibleIds.size <= 1) return input.match;

  const fallback = deterministicSuggest(input);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return mergeSuggestions(input.match, fallback, input.capabilities);

  try {
    const raw = await Promise.race([callGeminiSuggest(apiKey, input, eligibleIds), suggestTimeout(SUGGEST_TIMEOUT_MS)]);
    const payload = validateSuggestResponse(raw, eligibleIds, input.capabilities, fallback);
    return mergeSuggestions(input.match, payload, input.capabilities);
  } catch {
    return mergeSuggestions(input.match, fallback, input.capabilities);
  }
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
    "Respect `matcherScore` — do not rank a much lower matcher score far above a much higher one unless brand context strongly favors it.",
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
    return {
      id,
      name: cap?.name ?? id,
      summary: cap?.summary ?? "",
      brandFit: cap?.brandFit ?? null,
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
): SuggestPayload {
  if (!raw || typeof raw !== "object") return fallback;
  const obj = raw as Record<string, unknown>;

  const category =
    typeof obj.category === "string" && obj.category.trim() ? obj.category.trim() : fallback.siteContext.category;
  const summary =
    typeof obj.brandSummary === "string" && obj.brandSummary.trim()
      ? obj.brandSummary.trim()
      : fallback.siteContext.summary;

  const capsById = new Set(capabilities.map((c) => c.id));
  const rankings: TemplateRanking[] = [];
  const seen = new Set<TemplateId>();

  if (Array.isArray(obj.rankings)) {
    for (const row of obj.rankings) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const template = typeof rec.template === "string" ? (rec.template as TemplateId) : undefined;
      if (!template || !eligibleIds.has(template) || !capsById.has(template) || seen.has(template)) continue;
      seen.add(template);
      const contextualFit = clampNumber(rec.contextualFit, 0, 1, 0.5);
      const reason =
        typeof rec.reason === "string" && rec.reason.trim()
          ? rec.reason.trim()
          : (fallback.rankings.find((r) => r.template === template)?.reason ?? "Good match for your catalog.");
      rankings.push({ template, contextualFit, reason });
    }
  }

  for (const id of eligibleIds) {
    if (seen.has(id)) continue;
    const fb = fallback.rankings.find((r) => r.template === id);
    rankings.push(
      fb ?? {
        template: id,
        contextualFit: 0.5,
        reason: "Eligible based on your product images.",
      },
    );
  }

  return {
    siteContext: { category, summary },
    rankings,
  };
}

function deterministicSuggest(input: SuggestTemplatesInput): SuggestPayload {
  const eligible = input.match.results.filter((r) => r.eligible).sort((a, b) => b.score - a.score);
  const capsById = new Map(input.capabilities.map((c) => [c.id, c]));

  const category = guessCategory(input);
  const summary = buildDeterministicSummary(input, category);

  const rankings: TemplateRanking[] = eligible.map((r) => {
    const cap = capsById.get(r.template);
    const reason = cap?.brandFit
      ? cap.brandFit
      : cap?.summary
        ? cap.summary
        : "Fits the products we found on your site.";
    return {
      template: r.template,
      contextualFit: clampNumber(r.score, 0, 1, 0.5),
      reason,
    };
  });

  return { siteContext: { category, summary }, rankings };
}

function guessCategory(input: SuggestTemplatesInput): string | null {
  const fromAssets = input.inventory.assets
    .map((a) => a.data?.category)
    .find((c): c is string => Boolean(c));
  if (fromAssets) return fromAssets;
  const desc = input.businessDescription?.toLowerCase() ?? "";
  if (/shoe|sneaker|footwear|running/i.test(desc)) return "Footwear & athletic";
  if (/beauty|cosmetic|skincare/i.test(desc)) return "Beauty";
  if (/food|coffee|snack|grocery/i.test(desc)) return "Food & beverage";
  return null;
}

function buildDeterministicSummary(input: SuggestTemplatesInput, category: string | null): string | null {
  const name = input.businessName?.trim();
  const n = input.inventory.dataCoverage.withName;
  if (name && category) return `${name} — ${category} catalog with ${n} named product(s) detected.`;
  if (name) return `${name} — ${n} product image(s) ready for a mini-game.`;
  if (input.businessDescription?.trim()) return input.businessDescription.trim().slice(0, 240);
  return null;
}

function mergeSuggestions(
  match: MatchReport,
  payload: SuggestPayload,
  capabilities: GameCapability[],
): MatchReport {
  const rankingByTemplate = new Map(payload.rankings.map((r) => [r.template, r]));
  const eligible = match.results.filter((r) => r.eligible);

  const recommended = [...eligible]
    .sort((a, b) => blendedRankScore(b, rankingByTemplate) - blendedRankScore(a, rankingByTemplate))
    .map((r) => r.template);

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
  };
}

function blendedRankScore(row: TemplateMatch, rankings: Map<TemplateId, TemplateRanking>): number {
  const ai = rankings.get(row.template)?.contextualFit ?? 0.5;
  return MATCHER_WEIGHT * row.score + AI_WEIGHT * ai;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
