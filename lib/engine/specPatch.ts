// lib/engine/specPatch.ts
//
// The PATCH contract for /api/games/[id] — the one place that decides what a
// merchant may change about a stored GameSpec, and in what shape.
//
// Why a schema at all: `updateGameSpec` shallow-merges the patch into the
// stored spec at the TOP level only. So `{ brand: { accent: "#FF0000" } }`
// does not tint the game — it erases the logo, the font, the palette and the
// background in one write; and a `rewards` value that isn't an array reaches
// the runtime and throws mid-play. The route used to accept any non-array
// object and cast it. Hence the two structural rules here: unknown top-level
// keys are refused, and every nested object must arrive COMPLETE, because
// "whole object in, whole object out" is the only shape a shallow merge
// cannot silently damage.
//
// The *rules* are not defined here. Value rules live in specRules.ts (shared
// with the editor panel, so the inline errors a merchant sees and the errors
// the server returns can never drift) and role completeness / tuning ranges
// live in lib/capabilities. This file composes those with the shapes.
//
// Every `message` returned from this module is rendered verbatim to a
// merchant. Zod's own messages ("Expected string, received number") are
// developer diagnostics and never escape this file.

import { z } from "zod";

import { findIncompleteRoles, getCapability } from "@/lib/capabilities";
import { resolveMaxRealisticScoreForSpec } from "@/lib/engine/scoreCeiling";
import {
  COPY_RULES,
  HEX_COLOR_RE,
  clampTuningValue,
  hasBaselineTier,
  normalizeRewardTier,
  validateCopyField,
  validateRewardList,
} from "@/lib/engine/specRules";
import type {
  BrandKit,
  GameCopy,
  GameSpec,
  ProcessedAsset,
  RewardTier,
} from "@/lib/engine/types";

export type SpecPatchOk = { ok: true; patch: Partial<GameSpec> };

export type SpecPatchError = {
  ok: false;
  /** Machine code for the client: "invalid_body". */
  error: "invalid_body";
  /** Dotted path of the first offending field, e.g. "rewards.1.percentOff". */
  field?: string;
  /** Merchant-facing sentence, safe to render verbatim. */
  message: string;
};

export type SpecPatchResult = SpecPatchOk | SpecPatchError;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const hex = z.string().regex(HEX_COLOR_RE);

/** Complete BrandKit. `name`, `logoUrl` and `secondaryAccent` are the only
 * optional keys, and their ABSENCE is meaningful rather than lazy: the editor
 * clears a logo and unsets the secondary accent by omitting the key (JSON
 * drops `undefined`), and an unset secondaryAccent is what makes catch.ts and
 * shooter.ts take their own template-default branch. */
const brandSchema = z
  .object({
    name: z.string().optional(),
    logoUrl: z.string().optional(),
    accent: hex,
    secondaryAccent: hex.optional(),
    background: hex,
    foreground: hex,
    // Not validated against a font whitelist: brand.fontFamily is a plain CSS
    // family string and mount.ts's ensureGoogleFontLoaded already degrades to
    // the system stack when the family doesn't resolve.
    fontFamily: z.string().trim().min(1).max(80),
    palette: z.array(z.string()),
  })
  .strict();

/** All six GameCopy keys required — a partial `copy` would blank the fields it
 * omits. Content rules (required/length/trim) run through validateCopyField
 * after parsing, so the merchant gets the same sentence the panel shows. */
const copySchema = z
  .object({
    headline: z.string(),
    subhead: z.string(),
    ctaStart: z.string(),
    ctaReplay: z.string(),
    rewardIntro: z.string(),
    emailPrompt: z.string(),
  })
  .strict();

/** Shape only. Thresholds, labels, discounts and codes are judged by
 * specRules' validateRewardList against this game's real score ceiling. */
const rewardSchema = z
  .object({
    minScore: z.number(),
    label: z.string(),
    percentOff: z.number().nullable(),
    code: z.string().optional(),
    // Nullable as well as optional: the editor clears the terms by sending
    // `coupon: null`, and `.optional()` alone would reject that outright
    // instead of reading it as "remove the terms".
    coupon: z
      .object({
        terms: z.string().optional(),
        expiresAt: z.string().optional(),
        offerUrl: z.string().optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

/** Mirrors ProcessedAsset field for field. The five treatment fields describe
 * how to draw a specific set of pixels, so they are optional here exactly as
 * they are in the contract — absent means the documented safe default
 * ("isolated", "whole frame is subject", neutral colour), never "unknown". */
const assetSchema = z
  .object({
    id: z.string().min(1),
    spriteUrl: z.string().min(1),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    coverage: z.number().min(0).max(1),
    phash: z.string(),
    score: z.number().min(0).max(1),
    flags: z.array(z.string()),
    data: z
      .object({
        name: z.string().optional(),
        // Money is integer minor units everywhere in this codebase, never
        // floats — see extract/shopify.ts.
        priceMinor: z.number().int().min(0).optional(),
        currency: z.string().optional(),
      })
      .strict()
      .optional(),
    presentation: z.enum(["isolated", "photographic"]).optional(),
    backgroundColor: hex.optional(),
    backgroundTreatment: z.enum(["solid", "blurFill"]).optional(),
    subjectBounds: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .strict()
      .optional(),
    colorAdjust: z
      .object({
        brightness: z.number(),
        contrast: z.number(),
        saturation: z.number(),
      })
      .strict()
      .optional(),
  })
  .strict();

const rolesSchema = z.record(
  z.string(),
  z.union([z.array(z.string()), z.object({ fallback: z.string() }).strict()]),
);

/** Top-level `.strict()` is what refuses `id`, `version`, `template`,
 * `placements` and `meta`: identity, the contract version, the template the
 * whole spec is shaped around, the embed placement (which has its own
 * capability-checked route) and generation provenance are not editor fields. */
const patchSchema = z
  .object({
    brand: brandSchema.optional(),
    copy: copySchema.optional(),
    rewards: z.array(rewardSchema).optional(),
    roles: rolesSchema.optional(),
    assets: z.array(assetSchema).optional(),
    tuning: z.record(z.string(), z.number().finite()).optional(),
    durationSeconds: z.number().int().min(5).max(600).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Merchant-facing messages for structural (zod) failures
// ---------------------------------------------------------------------------

const GENERIC_MESSAGE = "That change wasn't in a format we can save.";
const REJECTED_KEY_MESSAGE = "That field can't be changed here.";
const HEX_MESSAGE = "Colours must be a six-digit hex value like #1A2B3C.";
const DURATION_MESSAGE =
  "Round length has to be a whole number of seconds between 5 and 600.";

const SECTION_MESSAGES: Record<string, string> = {
  brand: "Those brand settings weren't in a format we can save.",
  copy: "That text wasn't in a format we can save.",
  rewards: "That reward tier wasn't in a format we can save.",
  roles: "That image assignment wasn't in a format we can save.",
  assets: "That image is missing details we need in order to draw it.",
  tuning: "Difficulty settings have to be numbers.",
  durationSeconds: DURATION_MESSAGE,
};

const FIELD_MESSAGES: Record<string, string> = {
  accent: HEX_MESSAGE,
  secondaryAccent: HEX_MESSAGE,
  background: HEX_MESSAGE,
  foreground: HEX_MESSAGE,
  backgroundColor: HEX_MESSAGE,
  fontFamily: "Pick a font name between 1 and 80 characters.",
  priceMinor: "Prices are whole numbers of minor units — 1999 for 19.99.",
  durationSeconds: DURATION_MESSAGE,
};

/** The deepest named segment wins ("brand.accent" -> the hex sentence), then
 * the section, then a generic line — so a new field added to a schema above
 * still produces a sentence a merchant can read, never a zod default. */
function messageForIssue(issue: z.ZodIssue): string {
  if (issue.code === "unrecognized_keys") return REJECTED_KEY_MESSAGE;

  for (let i = issue.path.length - 1; i >= 0; i -= 1) {
    const segment = issue.path[i];
    if (typeof segment !== "string") continue; // array index — no name to match
    const message = FIELD_MESSAGES[segment];
    if (message) return message;
  }

  const head = issue.path[0];
  if (typeof head === "string") {
    const message = SECTION_MESSAGES[head];
    if (message) return message;
  }
  return GENERIC_MESSAGE;
}

function fieldForIssue(issue: z.ZodIssue): string | undefined {
  // An unrecognized-keys issue is reported against the containing object, so
  // the offending key lives in `keys`, not in `path`.
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys[0];
    if (key !== undefined) return [...issue.path, key].join(".");
  }
  return issue.path.length > 0 ? issue.path.join(".") : undefined;
}

function invalid(message: string, field?: string): SpecPatchError {
  return field === undefined
    ? { ok: false, error: "invalid_body", message }
    : { ok: false, error: "invalid_body", field, message };
}

/** Declaration order of COPY_RULES, so "the first offending field" is stable
 * across requests rather than dependent on JSON key order. */
const COPY_FIELDS = Object.keys(COPY_RULES) as (keyof GameCopy)[];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * `current` is the STORED spec (fetched via getGameById) — never trust a
 * template/tuning value from the patch body. The score ceiling reward tiers
 * are judged against, the tuning ranges values are clamped to, and the role
 * completeness check all resolve from `current`, so a client cannot widen its
 * own limits by sending a different template alongside the change.
 *
 * Returns the NORMALIZED patch: trimmed copy, normalized reward tiers, clamped
 * tuning. The route persists what comes back here, never the raw body.
 */
export async function validateSpecPatch(
  raw: unknown,
  current: GameSpec,
): Promise<SpecPatchResult> {
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) return invalid(GENERIC_MESSAGE);
    return invalid(messageForIssue(issue), fieldForIssue(issue));
  }

  const body = parsed.data;
  const patch: Partial<GameSpec> = {};

  if (body.brand !== undefined) {
    const brand: BrandKit = {
      accent: body.brand.accent,
      background: body.brand.background,
      foreground: body.brand.foreground,
      fontFamily: body.brand.fontFamily,
      palette: body.brand.palette,
    };
    // Rebuilt key by key rather than spread: an optional key must stay ABSENT
    // when it was absent, not become `undefined`, because the whole brand
    // object replaces the stored one.
    if (body.brand.name !== undefined) brand.name = body.brand.name;
    if (body.brand.logoUrl !== undefined) brand.logoUrl = body.brand.logoUrl;
    if (body.brand.secondaryAccent !== undefined) {
      brand.secondaryAccent = body.brand.secondaryAccent;
    }
    patch.brand = brand;
  }

  if (body.copy !== undefined) {
    const copy = {} as GameCopy;
    for (const field of COPY_FIELDS) {
      const result = validateCopyField(field, body.copy[field]);
      if (!result.ok) return invalid(result.message, `copy.${field}`);
      copy[field] = result.value;
    }
    patch.copy = copy;
  }

  if (body.rewards !== undefined) {
    const drafts = body.rewards.map((tier) => ({
      minScore: tier.minScore,
      label: tier.label,
      percentOff: tier.percentOff,
      code: tier.code,
      // null (an explicit "clear it") and undefined (absent) both mean "no
      // terms" to normalizeRewardTier, which drops the key entirely.
      coupon: tier.coupon ?? undefined,
    }));

    // The ceiling follows THIS game's tuning, not the template default — a
    // merchant who lengthened a round can legitimately set a higher threshold,
    // and one who shortened it must not be able to set an unreachable one.
    const maxScore = await resolveMaxRealisticScoreForSpec(current);

    const listIssues = validateRewardList(drafts, { maxScore });
    const firstEntry = listIssues[0];
    if (firstEntry) {
      const issue = firstEntry.issues[0];
      if (issue) {
        return invalid(issue.message, `rewards.${firstEntry.index}.${issue.field}`);
      }
    }

    const tiers: RewardTier[] = drafts.map(normalizeRewardTier);
    // brain.ts guarantees this for every generated game; enforcing it here
    // (rather than silently inserting a tier) keeps the editor honest about
    // what the merchant actually configured.
    if (tiers.length > 0 && !hasBaselineTier(tiers)) {
      return invalid(
        "Your lowest reward tier must start at a min score of 0, so every player earns something.",
        "rewards",
      );
    }
    patch.rewards = tiers;
  }

  if (body.assets !== undefined) {
    const assets: ProcessedAsset[] = body.assets;
    const seen = new Set<string>();
    for (let i = 0; i < assets.length; i += 1) {
      const asset = assets[i];
      if (!asset) continue;
      // Role entries address assets by id, so a duplicate id makes "which
      // image is in this role" unanswerable rather than merely redundant.
      if (seen.has(asset.id)) {
        return invalid("Each image can only appear in this game once.", `assets.${i}.id`);
      }
      seen.add(asset.id);
    }
    patch.assets = assets;
  }

  if (body.roles !== undefined) {
    // Resolve against the assets this patch RESULTS in: a patch that adds an
    // image and assigns it in one write is legitimate, and one that assigns an
    // id that exists nowhere would render as a silently missing sprite.
    const assetIds = new Set((patch.assets ?? current.assets).map((asset) => asset.id));

    for (const [roleId, entry] of Object.entries(body.roles)) {
      if (!Array.isArray(entry)) continue; // a { fallback } stand-in names no asset
      for (let i = 0; i < entry.length; i += 1) {
        const id = entry[i];
        if (id === undefined || !assetIds.has(id)) {
          return invalid("That image isn't part of this game.", `roles.${roleId}.${i}`);
        }
      }
    }
    patch.roles = body.roles;

    // The editor's unassign/delete paths are the only producers of an
    // unplayable spec (the pipeline refuses to emit one), so the merged result
    // — not the patch in isolation — is what has to hold up.
    const gap = findIncompleteRoles({ ...current, ...patch })[0];
    if (gap) {
      return invalid(
        `${gap.label} needs at least ${gap.need} image(s) — the game is unplayable without them.`,
        `roles.${gap.role}`,
      );
    }
  }

  if (body.tuning !== undefined) {
    const ranges = getCapability(current.template)?.tuning;
    const tuning: Record<string, number> = {};
    for (const [key, value] of Object.entries(body.tuning)) {
      const range = ranges?.[key];
      // A key the template has no knob for would sit in the spec forever
      // without ever being read, so it is dropped rather than persisted.
      if (!range) continue;
      // Clamp, don't reject: mount.ts re-clamps on every mount, so refusing an
      // out-of-range value would make this stricter than the runtime itself.
      tuning[key] = clampTuningValue(value, range);
    }
    patch.tuning = tuning;
  }

  if (body.durationSeconds !== undefined) {
    patch.durationSeconds = body.durationSeconds;
  }

  return { ok: true, patch };
}
