// lib/engine/types.ts
//
// The shared contract. GameSpec is the keystone: auto mode produces it,
// manual mode produces it, the editor mutates it, the runtime renders it,
// and the future ad exporter will compile it. Everything else in this repo
// is a boundary around this file — change it deliberately, and in one PR
// that updates every consumer (matcher, compose, runtime, api routes).
//
// Source: PlayLoop build spec §5 (Core schemas) + PlayLoop capability
// schema doc §1-4 (AssetInventory, GameCapability, MatchReport).

// ---------------------------------------------------------------------------
// 5.1 GameSpec
// ---------------------------------------------------------------------------

export type Placement = "section" | "fullpage" | "modal" | "ad";
export type TemplateId = "catch" | "guess_price" | "chain_pop" | "shooter" | "match" | "stack";

/**
 * How a sprite's background should be treated by a renderer that frames it
 * (e.g. inside a tile/chip) rather than floating it directly over a stage —
 * added because relaxing chain_pop's tile role to accept non-isolated real
 * photos (see lib/capabilities/chain_pop.json) surfaced a real aesthetic
 * bug: a photo's own studio backdrop clashing against an unrelated brand-
 * colour frame reads as an amateur "sticker in a box", not a designed tile.
 *
 * - "isolated": background was cleanly cut out (real transparency) — safe
 *   to float on any colour, or frame with a flat brand-colour chip.
 * - "photographic": background is a real, uncut photo backdrop — a
 *   renderer should never crop into the image to "fit" it (that cuts off
 *   real content, e.g. a model's head or feet) — always show the full
 *   image, and use `backgroundTreatment`/`backgroundColor` to fill
 *   whatever space is left around it instead.
 *
 * Set deterministically today (sprites.ts, from the cutout step's own
 * `isolatable` result); `brain.ts`'s `imagePresentation` lets a real
 * Gemini vision pass override it per asset when a key is configured — same
 * call/fallback pattern as every other AI-assisted field in this pipeline
 * (see brain.ts's file-level comment on why that path is unverified in
 * this sandbox but written to the same contract either way).
 */
export type AssetPresentation = "isolated" | "photographic";

/**
 * How to fill the space around a "photographic" image that isn't covered
 * by the image itself (it is never cropped — see AssetPresentation):
 * - "solid": fill with `backgroundColor` — right when the photo's own
 *   backdrop is already close to a single flat colour (high corner
 *   uniformity, just not white/bright enough to have isolated cleanly), so
 *   a flat fill is indistinguishable from more of the same photo.
 * - "blurFill": fill with a blurred, zoomed-in copy of the *same* image —
 *   right for a busy/contextual backdrop (a real room, outdoor scene, etc.)
 *   where a flat colour would look like an obvious patch; a blurred
 *   self-extension reads as an intentional, professional treatment
 *   instead (the same technique Spotify/Apple Music use for album art).
 * Deterministic today (sprites.ts, from the cutout step's own corner-
 * uniformity score); `brain.ts`'s `imageBackgroundTreatment` can override
 * it per asset the same way `imagePresentation` overrides `presentation`.
 */
export type AssetBackgroundTreatment = "solid" | "blurFill";

/**
 * Normalized (0..1, relative to the sprite's own square canvas — see
 * `ProcessedAsset.width`/`height`) bounding box of the *real subject* within
 * the frame — everything outside it is safe padding/backdrop, not content.
 *
 * This refines, not contradicts, AssetPresentation's "never crop" rule: a
 * renderer may crop toward `subjectBounds` (tightening the frame around a
 * subject that's small/off-centre in its source photo, e.g. a product shot
 * on a huge white void) but must never crop *into* it — the region this
 * rect describes is exactly the part that rule protects. Cropping outside
 * it removes only padding, which is what makes a genuinely amateur "tiny
 * lost product" tile look intentional instead.
 *
 * `{ x: 0, y: 0, width: 1, height: 1 }` (the whole frame is "subject") is
 * always a safe, conservative value — a renderer that ignores this field
 * entirely, or gets exactly that value, behaves identically to before this
 * field existed.
 *
 * For an "isolated" asset this is computed exactly, for free, from
 * sprites.ts's own trim step (the alpha-trimmed content rect within the
 * padded square — no guessing needed). For a "photographic" asset there is
 * no reliable way to segment subject from backdrop without real vision
 * judgment, so sprites.ts's deterministic fallback is the full frame (no
 * crop) and only `brain.ts`'s `imageSubjectBounds` (Gemini, when a key is
 * configured) can tighten it — same call/fallback pattern as
 * `imagePresentation`.
 */
export interface SubjectBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Multiplicative brightness/contrast/saturation nudge (1 = no change),
 * meant to be applied as a cheap canvas filter (`ctx.filter =
 * "brightness(b) contrast(c) saturate(s)"`) at draw time. Exists to correct
 * for the fact that a site's product photos rarely share one consistent
 * exposure/colour grade (different photographers, lighting, years) — a
 * grid of tiles with visibly inconsistent brightness reads as scraped, not
 * designed, even once presentation/backgroundTreatment are both right.
 *
 * There is no deterministic heuristic for this today — guessing "correct"
 * exposure from pixel statistics alone is as likely to make an image worse
 * as better without real judgment, which is worse than doing nothing. So
 * the fallback is always the neutral, no-op `{ brightness: 1, contrast: 1,
 * saturation: 1 }` (equivalently: omit the field entirely — a renderer must
 * treat "absent" the same as neutral), and only `brain.ts`'s
 * `imageColorAdjust` (Gemini, when a key is configured) ever sets a real
 * value. Each field is clamped server-side to [0.5, 1.5] — see
 * brain.ts's parseColorAdjustValue — a correction, not a re-edit.
 */
export interface ColorAdjust {
  brightness: number;
  contrast: number;
  saturation: number;
}

export interface ProcessedAsset {
  id: string;
  spriteUrl: string; // square, transparent, trimmed
  width: number;
  height: number;
  coverage: number; // 0..1 non-transparent fill
  phash: string;
  score: number; // 0..1 quality gate confidence
  flags: string[];
  data?: { name?: string; priceMinor?: number; currency?: string };
  /** Optional — absent on older/fixture specs, which a renderer should
   * treat exactly like "isolated" (today's default, unchanged look). */
  presentation?: AssetPresentation;
  /** The original image's sampled dominant background colour (hex).
   * Populated whenever `presentation` is "photographic"; meaningless (and
   * typically absent) otherwise. */
  backgroundColor?: string;
  /** Populated whenever `presentation` is "photographic"; meaningless (and
   * typically absent) otherwise. Absent-but-photographic should be treated
   * as "solid" (the original, simpler behaviour) for backward compatibility. */
  backgroundTreatment?: AssetBackgroundTreatment;
  /** Absent means "whole frame is subject" — see SubjectBounds' doc comment. */
  subjectBounds?: SubjectBounds;
  /** Absent means neutral/no-op — see ColorAdjust's doc comment. */
  colorAdjust?: ColorAdjust;
}

export interface BrandKit {
  name?: string;
  logoUrl?: string;
  accent: string; // hex — the primary brand colour (buttons, CTAs, reward tier)
  /** Secondary accent — optional so older specs without it keep working
   * (the runtime falls back to a neutral tone wherever it's used, e.g.
   * catch.ts's hazard colour). Editor-settable; not auto-derived yet. */
  secondaryAccent?: string;
  background: string;
  foreground: string; // contrast-forced against background
  fontFamily: string; // mapped Google Font
  palette: string[];
}

export interface GameCopy {
  headline: string;
  subhead: string;
  ctaStart: string;
  ctaReplay: string;
  rewardIntro: string;
  emailPrompt: string;
}

export interface RewardTier {
  minScore: number;
  label: string;
  percentOff: number | null;
  code?: string; // placeholder until Horizon 2 coupon APIs
}

export interface GameSpec {
  id: string;
  version: 1;
  template: TemplateId;
  placements: Placement[];
  brand: BrandKit;
  copy: GameCopy;
  assets: ProcessedAsset[];
  roles: Record<string, string[] | { fallback: string }>; // role -> asset ids
  rewards: RewardTier[];
  durationSeconds: number;
  tuning: Record<string, number>; // clamped to capability ranges
  meta: {
    sourceUrl?: string;
    mode: "auto" | "manual";
    generatedAt: string;
    warnings: string[];
  };
}

// ---------------------------------------------------------------------------
// Capability schema §1 — AssetInventory
// What we actually have, after extraction and the quality gate.
// ---------------------------------------------------------------------------

export type AssetOrigin = "products_json" | "jsonld" | "og" | "dom" | "upload";
export type SubjectType =
  | "product"
  | "lifestyle"
  | "logo"
  | "text_graphic"
  | "person"
  | "pattern"
  | "unknown";

/** A candidate asset before it has been transformed into a ProcessedAsset. */
export interface RawAsset {
  id: string;
  url: string;
  origin: AssetOrigin;

  pixels: { width: number; height: number; aspect: number };
  alpha: { has: boolean; coverage: number | null };
  background: { uniformity: number; dominant: string; isolatable: boolean };
  colour: { dominant: string[]; meanLuminance: number; saturation: number };
  content: { subjectType: SubjectType; textDensity: number; subjectCount: number };
  phash: string;

  data?: {
    name?: string;
    priceMinor?: number;
    category?: string;
    sku?: string;
  };

  quality: { score: number; flags: string[] };

  /** Populated once sprites.ts has produced a transformed sprite for this asset. */
  processed?: ProcessedAsset;
}

export interface AssetInventory {
  version: 1;
  source: { mode: "auto" | "manual"; url?: string; platform?: string };
  currency: string;
  assets: RawAsset[];
  brand: {
    logo?: { assetId: string; confidence: number };
    palette: string[];
    fontStack: string;
  };
  dataCoverage: { withName: number; withPrice: number; withCategory: number };
}

// ---------------------------------------------------------------------------
// Capability schema §2 — GameCapability
// One per template. Declares what a template needs in terms of roles, not
// files. `requires` is a hard gate; `prefers` feeds the fit score.
// ---------------------------------------------------------------------------

export interface RoleRequirements {
  subjectTypeIn?: SubjectType[];
  isolatable?: boolean;
  minShortEdge?: number;
  aspectRange?: [number, number];
  maxTextDensity?: number;
  maxSubjectCount?: number;
}

export interface RolePreferences {
  distinctPhash?: boolean;
  coverageRange?: [number, number];
  uniformScale?: boolean;
  contrastAgainst?: string;
  aspectRange?: [number, number];
}

export type FallbackKind =
  | "none"
  | "generatedShape"
  | "brandGradient"
  | "logo"
  | "solid";

export type TransformId =
  | "cutout"
  | "trim"
  | "padSquare"
  | "resize"
  | "cropAspect"
  | "outline"
  | "shadow"
  | "tint"
  | "desaturate"
  | "blur"
  | "darken";

export interface CapabilityRole {
  id: string;
  purpose: string;
  count: { min: number; ideal: number; max: number };
  requires: RoleRequirements;
  prefers?: RolePreferences;
  transforms: TransformId[];
  fallback: FallbackKind;
  optional?: boolean;
}

export interface PlacementConstraint {
  minWidth?: number;
  minHeight?: number;
  preferredAspect?: number;
  sizes?: string[];
  excluded?: string[];
}

export interface GameCapability {
  version: 1;
  id: TemplateId;
  name: string;
  summary: string;
  roles: CapabilityRole[];
  data: { required: string[]; optional: string[] };
  placements: Partial<Record<Placement, PlacementConstraint>>;
  tuning: Record<string, { min: number; default: number; max: number }>;
  scoring: { maxRealistic: number; rewardTierHint: [number, number] };
  cost: { buildMs: number; runtimeKb: number };
}

// ---------------------------------------------------------------------------
// Transform catalogue (capability schema §3) — shared vocabulary so the
// matcher can plan a route from raw asset to filled role.
// ---------------------------------------------------------------------------

export interface TransformMode {
  id: string;
  requires: Record<string, string>;
  ms: number;
  qualityDelta: number;
}

export interface TransformSpec {
  modes?: TransformMode[];
  requires: Record<string, string>;
  ms: number;
  qualityDelta: number;
  produces?: Record<string, unknown>;
  note?: string;
}

// ---------------------------------------------------------------------------
// Capability schema §4 — MatchReport
// ---------------------------------------------------------------------------

export interface RoleAssignmentPlanStep {
  assetId: string;
  role: string;
  steps: string[];
  estimatedMs: number;
  confidence: number;
}

export interface MatchGap {
  role: string;
  need: number;
  have: number;
  reason: string;
}

export interface TemplateMatch {
  template: TemplateId;
  eligible: boolean;
  score: number;
  assignments?: Record<string, string[] | { fallback: string } | string>;
  plan?: RoleAssignmentPlanStep[];
  gaps?: MatchGap[];
  warnings: string[];
  estimatedBuildMs?: number;
}

export interface MatchReport {
  version: 1;
  inventoryId: string;
  results: TemplateMatch[];
  recommended: TemplateId[];
  fallbackMode: "manual" | null;
}

// ---------------------------------------------------------------------------
// AI layer contract (build spec §11)
// ---------------------------------------------------------------------------

export interface BrainRequest {
  business: { name?: string; description?: string; category: string | null };
  eligible: { template: TemplateId; score: number; assetCount: number; hasPrices: boolean }[];
  sampleAssets: { id: string; name?: string; priceMinor?: number }[];
  brand: { palette: string[]; fontStack: string };
}

export interface BrainResponse {
  category: string;
  template: TemplateId;
  reason: string;
  usableAssetIds?: string[];
  logoAssetId?: string;
  copy: GameCopy;
  rewards: { minScore: number; label: string; percentOff: number }[];
  tuning: Record<string, number>;
  /** Per-asset-id override for AssetPresentation (see ProcessedAsset) —
   * only set on a real Gemini response, since vision judgment of "does
   * this look like a clean cutout or a real photo backdrop" beats the
   * deterministic isolatable-based guess sprites.ts makes. Absent on the
   * deterministic fallback; compose.ts keeps the heuristic value for any
   * asset id not present here. */
  imagePresentation?: Record<string, AssetPresentation>;
  /** Per-asset-id override for AssetBackgroundTreatment (see
   * ProcessedAsset) — same reasoning and fallback behaviour as
   * `imagePresentation`. */
  imageBackgroundTreatment?: Record<string, AssetBackgroundTreatment>;
  /** Per-asset-id override for SubjectBounds (see ProcessedAsset) — the
   * only source of a tightened crop for a "photographic" asset, since
   * sprites.ts's deterministic fallback is always the full frame for those
   * (no reliable heuristic). Still useful, if less impactful, for an
   * "isolated" asset too — Gemini can judge padding a plain alpha-trim
   * can't (e.g. a product shot deliberately off-centre within its own
   * cutout). Absent on the deterministic fallback. */
  imageSubjectBounds?: Record<string, SubjectBounds>;
  /** Per-asset-id override for ColorAdjust (see ProcessedAsset) — this
   * field has no deterministic source at all (see ColorAdjust's doc
   * comment), so it is *only* ever populated here, on a real Gemini
   * response; compose.ts's fallback is always neutral. */
  imageColorAdjust?: Record<string, ColorAdjust>;
}

// ---------------------------------------------------------------------------
// Job (generation pipeline) — build spec §6, §12, data model
// ---------------------------------------------------------------------------

export type JobStage =
  | "queued"
  | "fetching"
  | "extracting"
  | "downloading"
  | "processing"
  | "quality"
  | "matching"
  | "choosing"
  | "thinking"
  | "composing"
  | "done"
  | "error";

export interface Job {
  id: string;
  accountId: string | null;
  mode: "auto" | "manual";
  sourceUrl: string | null;
  stage: JobStage;
  percent: number;
  message: string | null;
  inventory: AssetInventory | null;
  match: MatchReport | null;
  spec: GameSpec | null;
  gameId: string | null;
  /** Set once extraction finishes (auto mode only) — carried across the
   * "choosing" pause so the composition phase can still feed brain.ts the
   * same business context extraction found, without re-scraping the site. */
  businessName: string | null;
  businessDescription: string | null;
  /** Images that failed to download/decode during extraction — carried
   * across the "choosing" pause so the eventual GameSpec still gets its
   * "N image(s) skipped" warning (lib/engine/index.ts's
   * ExtractionOutput.droppedCount). */
  droppedCount: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Game record (data model §4)
// ---------------------------------------------------------------------------

export type GameStatus = "draft" | "published" | "archived";

export interface GameRecord {
  id: string;
  accountId: string | null;
  slug: string | null;
  name: string;
  spec: GameSpec;
  placement: Placement;
  status: GameStatus;
  allowedHosts: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Plays / leads (data model §4, analytics §16)
// ---------------------------------------------------------------------------

export type AnalyticsEvent =
  | "impression"
  | "start"
  | "complete"
  | "replay"
  | "reward_revealed"
  | "lead_captured";

export interface PlayRecord {
  id: string;
  gameId: string;
  session: string;
  startedAt: string;
  finishedAt: string | null;
  score: number | null;
  tierIndex: number | null;
  replayOf: string | null;
  referrer: string | null;
  device: "mobile" | "desktop" | null;
  country: string | null;
}

export interface LeadRecord {
  id: string;
  gameId: string;
  playId: string | null;
  email: string | null;
  phone: string | null;
  consent: boolean;
  createdAt: string;
}
