// lib/engine/brain.ts
//
// The AI layer (build spec §11): one Gemini call, pre-filtered by the
// matcher so the model only ever sees eligible templates and can never
// pick a game we can't build. Every field it returns is re-validated
// server-side before compose.ts sees it ("non-negotiable" per the spec).
//
// IMPORTANT — this sandbox has no network access to verify a live Gemini
// call against, and ships with no GEMINI_API_KEY. "No key" and "timeout"
// are deliberately the same code path (deterministicFallback), which is
// what actually runs on every generation in this environment. The Gemini
// call itself (callGemini/buildImageParts/RESPONSE_SCHEMA below) is
// written carefully against the documented @google/generative-ai API but
// is UNTESTED — smoke-test it for real once a GEMINI_API_KEY is available.
//
// sharp-dependent (image resizing for the vision call) — only reachable
// from a route declaring `export const runtime = "nodejs"`.

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { Schema } from "@google/generative-ai";
import sharp from "sharp";
import { safeFetchImage } from "@/lib/engine/safeFetch";
import type {
  AssetInventory,
  BrainRequest,
  BrainResponse,
  GameCapability,
  GameCopy,
  MatchReport,
  RawAsset,
  TemplateId,
} from "@/lib/engine/types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const BRAIN_TIMEOUT_MS = 15_000;
const MAX_CANDIDATE_IMAGES = Number(process.env.MAX_CANDIDATE_IMAGES) || 12;
const IMAGE_LONG_EDGE = 512;

export interface RunBrainInput {
  inventory: AssetInventory;
  match: MatchReport;
  capabilities: GameCapability[];
  pageText?: string;
  businessName?: string;
  businessDescription?: string;
}

export async function runBrain(input: RunBrainInput): Promise<BrainResponse> {
  const eligible = input.match.results.filter((r) => r.eligible).sort((a, b) => b.score - a.score);
  const bestByScore = eligible[0]?.template;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || eligible.length === 0) {
    return deterministicFallback(input, bestByScore);
  }

  try {
    const raw = await Promise.race([
      callGemini(apiKey, input, eligible.map((r) => r.template)),
      timeout(BRAIN_TIMEOUT_MS),
    ]);
    return validateBrainResponse(raw, input);
  } catch {
    // Any failure at all — network, parse, timeout, 429 quota, whatever —
    // degrades to the same deterministic path. "A degraded game beats a
    // failed generation" (build spec §11).
    return deterministicFallback(input, bestByScore);
  }
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Brain call timed out after ${ms}ms`)), ms);
  });
}

// ---------------------------------------------------------------------------
// Live Gemini call — see the file-level warning: unverified in this sandbox.
// ---------------------------------------------------------------------------

const RESPONSE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    category: { type: SchemaType.STRING },
    template: { type: SchemaType.STRING },
    reason: { type: SchemaType.STRING },
    usableAssetIds: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    logoAssetId: { type: SchemaType.STRING },
    copy: {
      type: SchemaType.OBJECT,
      properties: {
        headline: { type: SchemaType.STRING },
        subhead: { type: SchemaType.STRING },
        ctaStart: { type: SchemaType.STRING },
        ctaReplay: { type: SchemaType.STRING },
        rewardIntro: { type: SchemaType.STRING },
        emailPrompt: { type: SchemaType.STRING },
      },
      required: ["headline", "subhead", "ctaStart", "ctaReplay", "rewardIntro", "emailPrompt"],
    },
    rewards: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          minScore: { type: SchemaType.NUMBER },
          label: { type: SchemaType.STRING },
          percentOff: { type: SchemaType.NUMBER },
        },
        required: ["minScore", "label", "percentOff"],
      },
    },
    // Free-form tuning keys vary per template (spawnRateHz vs roundCount,
    // etc.) — Gemini's schema subset doesn't cleanly express "any numeric
    // properties", so this is left loose and clamped hard in
    // validateBrainResponse instead of relied on for correctness.
    tuning: { type: SchemaType.OBJECT },
  },
  required: ["category", "template", "reason", "copy", "rewards", "tuning"],
};

async function callGemini(apiKey: string, input: RunBrainInput, eligibleTemplates: TemplateId[]): Promise<unknown> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
  });

  const request = buildBrainRequest(input, eligibleTemplates);
  const imageParts = await buildImageParts(input.inventory.assets);

  const promptText = [
    "You are choosing and writing copy for a short branded mini-game (a 'playable ad') for an e-commerce brand.",
    "You may ONLY set `template` to one of the ids listed under `eligible` below — any other value is invalid and will be discarded.",
    "Keep copy short, upbeat, and specific to the brand where possible. Respond ONLY with JSON matching the response schema.",
    "",
    input.pageText ? `Page text (may be truncated):\n${input.pageText.slice(0, 4000)}` : "",
    "",
    JSON.stringify(request, null, 2),
  ]
    .filter(Boolean)
    .join("\n");

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: promptText }, ...imageParts] }],
  });

  return JSON.parse(result.response.text());
}

function buildBrainRequest(input: RunBrainInput, eligibleTemplates: TemplateId[]): BrainRequest {
  const byTemplate = new Map(input.match.results.map((r) => [r.template, r]));

  const eligible = eligibleTemplates.map((t) => {
    const r = byTemplate.get(t);
    const assetCount = r
      ? Object.values(r.assignments ?? {}).reduce((sum, v) => sum + (Array.isArray(v) ? v.length : 0), 0)
      : 0;
    return {
      template: t,
      score: r?.score ?? 0,
      assetCount,
      hasPrices: input.inventory.dataCoverage.withPrice > 0,
    };
  });

  const sampleAssets = input.inventory.assets.slice(0, 12).map((a) => ({
    id: a.id,
    name: a.data?.name,
    priceMinor: a.data?.priceMinor,
  }));

  return {
    business: {
      name: input.businessName,
      description: input.businessDescription,
      category: null,
    },
    eligible,
    sampleAssets,
    brand: { palette: input.inventory.brand.palette, fontStack: input.inventory.brand.fontStack },
  };
}

/** Re-downloads (safeFetch-cached, so cheap on repeat runs) and downsizes
 * up to MAX_CANDIDATE_IMAGES surviving assets to 512px long edge, per
 * build spec §11: "Resize images to 512px on the long edge before
 * sending." Only assets that passed the quality gate are sent. */
async function buildImageParts(assets: RawAsset[]): Promise<{ inlineData: { data: string; mimeType: string } }[]> {
  const candidates = assets.filter((a) => a.quality.score > 0).slice(0, MAX_CANDIDATE_IMAGES);

  const parts = await Promise.all(
    candidates.map(async (asset) => {
      try {
        const res = await safeFetchImage(asset.url);
        if (!res.ok) return null;
        const resized = await sharp(res.buffer, { failOn: "none" })
          .resize(IMAGE_LONG_EDGE, IMAGE_LONG_EDGE, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        return { inlineData: { data: resized.toString("base64"), mimeType: "image/jpeg" } };
      } catch {
        return null;
      }
    }),
  );

  return parts.filter((p): p is { inlineData: { data: string; mimeType: string } } => p !== null);
}

// ---------------------------------------------------------------------------
// Server-side validation (build spec §11 — "non-negotiable")
// ---------------------------------------------------------------------------

function validateBrainResponse(raw: unknown, input: RunBrainInput): BrainResponse {
  const eligible = input.match.results.filter((r) => r.eligible).sort((a, b) => b.score - a.score);
  const eligibleIds = new Set(eligible.map((r) => r.template));
  const bestByScore = eligible[0]?.template;

  if (!raw || typeof raw !== "object") return deterministicFallback(input, bestByScore);
  const obj = raw as Record<string, unknown>;

  // "template must be in the eligible list, else fall back to highest matcher score."
  const templateRaw = typeof obj.template === "string" ? (obj.template as TemplateId) : undefined;
  const template = templateRaw && eligibleIds.has(templateRaw) ? templateRaw : bestByScore;
  if (!template) return deterministicFallback(input, bestByScore);

  const cap = input.capabilities.find((c) => c.id === template);
  if (!cap) return deterministicFallback(input, bestByScore);

  const passedIds = new Set(input.inventory.assets.filter((a) => a.quality.score > 0).map((a) => a.id));

  const rawUsable = Array.isArray(obj.usableAssetIds) ? (obj.usableAssetIds as unknown[]) : [];
  // "usableAssetIds intersected with what actually passed the gate."
  const usableAssetIds = rawUsable.filter((id): id is string => typeof id === "string" && passedIds.has(id));

  const logoAssetId =
    typeof obj.logoAssetId === "string" && passedIds.has(obj.logoAssetId)
      ? obj.logoAssetId
      : input.inventory.brand.logo?.assetId;

  return {
    category: typeof obj.category === "string" && obj.category.trim() ? obj.category : "general_retail",
    template,
    reason: typeof obj.reason === "string" && obj.reason.trim() ? obj.reason : "Selected by matcher score.",
    usableAssetIds: usableAssetIds.length > 0 ? usableAssetIds : Array.from(passedIds),
    logoAssetId,
    copy: validateCopy(obj.copy, input.businessName),
    rewards: validateRewards(obj.rewards, cap),
    tuning: clampTuning(obj.tuning, cap),
  };
}

function validateCopy(raw: unknown, businessName: string | undefined): GameCopy {
  const fallback = templatedCopy(businessName);
  if (!raw || typeof raw !== "object") return fallback;
  const obj = raw as Record<string, unknown>;
  const pick = (key: keyof GameCopy): string => {
    const value = obj[key];
    return typeof value === "string" && value.trim() ? value : fallback[key];
  };
  return {
    headline: pick("headline"),
    subhead: pick("subhead"),
    ctaStart: pick("ctaStart"),
    ctaReplay: pick("ctaReplay"),
    rewardIntro: pick("rewardIntro"),
    emailPrompt: pick("emailPrompt"),
  };
}

/** "tuning values clamped to the capability's declared ranges." */
function clampTuning(raw: unknown, cap: GameCapability): Record<string, number> {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const tuning: Record<string, number> = {};
  for (const [key, range] of Object.entries(cap.tuning)) {
    const value = typeof obj[key] === "number" ? (obj[key] as number) : range.default;
    tuning[key] = clampNumber(value, range.min, range.max);
  }
  return tuning;
}

/** "Reward thresholds validated against scoring.maxRealistic — a tier
 * nobody can reach is worse than no tier" -> such tiers are dropped, not
 * repaired, since there's no honest score to repair them to. */
function validateRewards(raw: unknown, cap: GameCapability): BrainResponse["rewards"] {
  const maxRealistic = cap.scoring.maxRealistic;
  const list = Array.isArray(raw) ? (raw as unknown[]) : [];

  const parsed: BrainResponse["rewards"] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const minScore = typeof obj.minScore === "number" ? obj.minScore : undefined;
    const label = typeof obj.label === "string" ? obj.label : undefined;
    const percentOff = typeof obj.percentOff === "number" ? obj.percentOff : undefined;
    if (minScore === undefined || !label || percentOff === undefined) continue;
    if (minScore >= maxRealistic) continue; // nobody can reach it — drop it
    if (minScore < 0 || percentOff <= 0 || percentOff > 90) continue;
    parsed.push({ minScore: Math.round(minScore), label, percentOff: Math.round(percentOff) });
  }

  parsed.sort((a, b) => a.minScore - b.minScore);
  const deduped = parsed.filter((tier, i) => i === 0 || tier.minScore > (parsed[i - 1]?.minScore ?? -1));

  if (deduped.length === 0 || deduped[0]?.minScore !== 0) {
    deduped.unshift({ minScore: 0, label: "10% off", percentOff: 10 });
  }
  return deduped;
}

function clampNumber(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// Deterministic fallback — the path this sandbox actually always takes.
// Must work with zero API key configured; "no key" and "timeout" share it.
// ---------------------------------------------------------------------------

/** A handful of hand-written copy templates (build spec §11: "templated
 * copy with the brand name substituted in") — picked deterministically from
 * the brand name so the same site always gets the same fallback copy. */
const COPY_TEMPLATES: ((name: string) => GameCopy)[] = [
  (name) => ({
    headline: `Play the ${name} game`,
    subhead: "Score points, unlock a discount.",
    ctaStart: "Start playing",
    ctaReplay: "Play again",
    rewardIntro: "You've earned",
    emailPrompt: "Email me my code",
  }),
  (name) => ({
    headline: `How well do you know ${name}?`,
    subhead: "Play a quick round and reveal your reward.",
    ctaStart: "Let's go",
    ctaReplay: "Try again",
    rewardIntro: "Nice — you unlocked",
    emailPrompt: "Send my code by email",
  }),
  (name) => ({
    headline: `${name}: one quick game, one real reward`,
    subhead: "Your score decides your discount.",
    ctaStart: "Play now",
    ctaReplay: "One more round",
    rewardIntro: "You scored your way to",
    emailPrompt: "Email my discount code",
  }),
];

function templatedCopy(businessName: string | undefined): GameCopy {
  const name = businessName?.trim() || "this brand";
  // Deterministic-but-varied: keyed off the name (not Math.random) so a
  // given brand always gets the same fallback copy across repeat demos.
  const index = hashString(name) % COPY_TEMPLATES.length;
  const template = COPY_TEMPLATES[index] ?? COPY_TEMPLATES[0];
  return template!(name);
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function deterministicFallback(input: RunBrainInput, template: TemplateId | undefined): BrainResponse {
  const eligible = input.match.results.filter((r) => r.eligible).sort((a, b) => b.score - a.score);
  const chosenTemplate: TemplateId | undefined = template ?? eligible[0]?.template ?? input.capabilities[0]?.id;
  const cap = input.capabilities.find((c) => c.id === chosenTemplate) ?? input.capabilities[0];

  const tuning: Record<string, number> = {};
  if (cap) {
    for (const [key, range] of Object.entries(cap.tuning)) tuning[key] = range.default;
  }

  const maxRealistic = cap?.scoring.maxRealistic ?? 1000;
  const rewards: BrainResponse["rewards"] = [
    { minScore: 0, label: "10% off", percentOff: 10 },
    { minScore: Math.round(maxRealistic * 0.3), label: "15% off", percentOff: 15 },
    { minScore: Math.round(maxRealistic * 0.65), label: "20% off", percentOff: 20 },
  ];

  const passedAssetIds = input.inventory.assets.filter((a) => a.quality.score > 0).map((a) => a.id);

  return {
    category: "general_retail",
    template: (cap?.id ?? "guess_price") as TemplateId,
    reason:
      "Deterministic fallback: no Gemini call was made (missing API key, timeout, or error) — template chosen by matcher score alone.",
    usableAssetIds: passedAssetIds,
    logoAssetId: input.inventory.brand.logo?.assetId,
    copy: templatedCopy(input.businessName),
    rewards,
    tuning,
  };
}
