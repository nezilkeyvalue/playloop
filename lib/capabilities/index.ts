// lib/capabilities/index.ts
//
// Loader + validation for GameCapability definitions. Templates are data:
// adding a fifth game means dropping a new JSON file here (and a runtime
// module in lib/runtime/games) — nothing in the matcher changes.
// Build spec §5.3 / capability schema §6.

import { z } from "zod";
import type {
  CapabilityRole,
  GameCapability,
  GameSpec,
  Placement,
  ProcessedAsset,
  TemplateId,
} from "@/lib/engine/types";

import catchCapability from "./catch.json";
import guessPriceCapability from "./guess_price.json";
import chainPopCapability from "./chain_pop.json";
import chompCapability from "./chomp.json";
import whackCapability from "./whack.json";
import simonCapability from "./simon.json";
import sliceCapability from "./slice.json";
import shooterCapability from "./shooter.json";
import sweetSpotCapability from "./sweet_spot.json";
import runnerCapability from "./runner.json";

const roleRequirementsSchema = z.object({
  subjectTypeIn: z.array(z.string()).optional(),
  isolatable: z.boolean().optional(),
  minShortEdge: z.number().optional(),
  aspectRange: z.tuple([z.number(), z.number()]).optional(),
  maxTextDensity: z.number().optional(),
  maxSubjectCount: z.number().optional(),
});

const rolePreferencesSchema = z.object({
  distinctPhash: z.boolean().optional(),
  coverageRange: z.tuple([z.number(), z.number()]).optional(),
  uniformScale: z.boolean().optional(),
  contrastAgainst: z.string().optional(),
  aspectRange: z.tuple([z.number(), z.number()]).optional(),
});

const capabilityRoleSchema = z.object({
  id: z.string(),
  purpose: z.string(),
  count: z.object({ min: z.number(), ideal: z.number(), max: z.number() }),
  requires: roleRequirementsSchema,
  prefers: rolePreferencesSchema.optional(),
  transforms: z.array(z.string()),
  fallback: z.enum(["none", "generatedShape", "brandGradient", "logo", "solid"]),
  optional: z.boolean().optional(),
});

const placementConstraintSchema = z.object({
  minWidth: z.number().optional(),
  minHeight: z.number().optional(),
  preferredAspect: z.number().optional(),
  sizes: z.array(z.string()).optional(),
  excluded: z.array(z.string()).optional(),
});

const gameCapabilitySchema = z.object({
  version: z.literal(1),
  id: z.enum(["catch", "guess_price", "chain_pop", "shooter", "sweet_spot", "match", "stack", "chomp", "whack", "simon", "slice", "runner"]),
  name: z.string(),
  summary: z.string(),
  roles: z.array(capabilityRoleSchema).min(1),
  data: z.object({ required: z.array(z.string()), optional: z.array(z.string()) }),
  placements: z.record(z.string(), placementConstraintSchema),
  tuning: z.record(
    z.string(),
    z.object({ min: z.number(), default: z.number(), max: z.number() }),
  ),
  scoring: z.object({
    maxRealistic: z.number(),
    rewardTierHint: z.tuple([z.number(), z.number()]),
  }),
  cost: z.object({ buildMs: z.number(), runtimeKb: z.number() }),
});

function validate(raw: unknown, sourceFile: string): GameCapability {
  const result = gameCapabilitySchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid capability definition in ${sourceFile}: ${result.error.message}`,
    );
  }
  return result.data as GameCapability;
}

const registry: Record<string, GameCapability> = {
  catch: validate(catchCapability, "catch.json"),
  guess_price: validate(guessPriceCapability, "guess_price.json"),
  chain_pop: validate(chainPopCapability, "chain_pop.json"),
  chomp: validate(chompCapability, "chomp.json"),
  whack: validate(whackCapability, "whack.json"),
  simon: validate(simonCapability, "simon.json"),
  slice: validate(sliceCapability, "slice.json"),
  shooter: validate(shooterCapability, "shooter.json"),
  sweet_spot: validate(sweetSpotCapability, "sweet_spot.json"),
  runner: validate(runnerCapability, "runner.json"),
};

/** All templates currently implemented (catch, guess_price, chain_pop,
 * chomp, whack, simon, slice, shooter, sweet_spot). Post-MVP ids (match,
 * stack) are reserved in the type system but intentionally absent here —
 * an absent capability makes a template automatically ineligible everywhere. */
export function listCapabilities(): GameCapability[] {
  return Object.values(registry);
}

export function getCapability(id: TemplateId): GameCapability | undefined {
  return registry[id];
}

/** Name + summary for the auto-build template picker. Falls back to the
 * capability JSON imports so a card never renders a bare template id when
 * the registry lookup misses (stale client bundle, etc.). */
export function getTemplatePickerMeta(id: TemplateId): { name: string; summary: string } {
  const cap = registry[id];
  if (cap) return { name: cap.name, summary: cap.summary };
  const fallback = PICKER_META_FALLBACK[id];
  if (fallback) return fallback;
  return { name: id, summary: "" };
}

const PICKER_META_FALLBACK: Partial<Record<TemplateId, { name: string; summary: string }>> = {
  catch: { name: catchCapability.name, summary: catchCapability.summary },
  guess_price: { name: guessPriceCapability.name, summary: guessPriceCapability.summary },
  chain_pop: { name: chainPopCapability.name, summary: chainPopCapability.summary },
  chomp: { name: chompCapability.name, summary: chompCapability.summary },
  whack: { name: whackCapability.name, summary: whackCapability.summary },
  simon: { name: simonCapability.name, summary: simonCapability.summary },
  slice: { name: sliceCapability.name, summary: sliceCapability.summary },
  shooter: { name: shooterCapability.name, summary: shooterCapability.summary },
  sweet_spot: { name: sweetSpotCapability.name, summary: sweetSpotCapability.summary },
  runner: { name: runnerCapability.name, summary: runnerCapability.summary },
};

export function requireCapability(id: TemplateId): GameCapability {
  const cap = registry[id];
  if (!cap) throw new Error(`Unknown or unimplemented template capability: ${id}`);
  return cap;
}

export function supportsPlacement(cap: GameCapability, placement: Placement): boolean {
  return Boolean(cap.placements[placement]);
}

// ---------------------------------------------------------------------------
// Role completeness
//
// The single definition of "is this role actually satisfied", shared by the
// editor's badge, its per-role counters and the publish gate. It exists
// because those consumers used to answer the question themselves — counting
// only `Array.isArray(entry) && entry.length >= min` — which disagreed with
// what the runtime plays: a legitimate `{ fallback }` stand-in read as a
// permanent shortfall, and a guess_price hero with no price read as filled
// even though guessPrice.ts drops it from the round order.
// ---------------------------------------------------------------------------

export interface RoleGap {
  role: string;
  /** Human-readable role name, e.g. "collectible" -> "collectible". */
  label: string;
  need: number;
  have: number;
  /** true when role.fallback === "none" — the runtime has no stand-in. */
  hardRequired: boolean;
}

/** ProcessedAsset-side mirror of matcher.ts's assetMeetsDataRequirements.
 * It must agree with that RawAsset check: the matcher decides what may be
 * assigned to a role, and this decides what still counts afterwards.
 *
 * "category" and "sku" are deliberately not re-checked — they exist on
 * RawAsset but ProcessedAsset.data carries only name/priceMinor/currency,
 * so there is nothing here to inspect. Failing on them would mark every
 * asset of such a capability unplayable; the matcher already enforced them
 * upstream, where the data still existed. */
export function assetSatisfiesRequiredData(
  asset: ProcessedAsset,
  cap: GameCapability,
): boolean {
  for (const field of cap.data.required) {
    if (field === "priceMinor" && asset.data?.priceMinor === undefined) return false;
    if (field === "name" && !asset.data?.name) return false;
  }
  return true;
}

/** Asset ids assigned to a role, [] when the entry is absent or is a
 * { fallback } stand-in. */
export function roleAssetIds(spec: GameSpec, roleId: string): string[] {
  const entry = spec.roles[roleId];
  return Array.isArray(entry) ? entry : [];
}

/** Assigned ids resolved against spec.assets AND satisfying
 * cap.data.required. This is what the runtime will actually play with. */
export function playableAssetsForRole(
  spec: GameSpec,
  cap: GameCapability,
  roleId: string,
): ProcessedAsset[] {
  return roleAssetIds(spec, roleId)
    .map((id) => spec.assets.find((a) => a.id === id))
    .filter((a): a is ProcessedAsset => Boolean(a))
    .filter((a) => assetSatisfiesRequiredData(a, cap));
}

/** True when the role is filled: either playableAssetsForRole().length >=
 * role.count.min, or spec.roles[role.id] is a { fallback } entry (which
 * matcher.ts legitimately writes and the runtime honours) for a role whose
 * fallback is not "none". */
export function roleIsSatisfied(
  spec: GameSpec,
  cap: GameCapability,
  role: CapabilityRole,
): boolean {
  const entry = spec.roles[role.id];
  if (entry !== undefined && !Array.isArray(entry)) {
    // A stand-in the runtime knows how to draw. Only "none" means there is
    // nothing to draw — and the matcher never writes that entry anyway.
    return role.fallback !== "none";
  }
  return playableAssetsForRole(spec, cap, role.id).length >= role.count.min;
}

/** Roles that must be shown in a completeness badge: everything that is not
 * optional, PLUS every role with fallback === "none" — a role the runtime
 * cannot stand in for is worth surfacing even if its capability also marks
 * it optional. */
export function trackedRoles(cap: GameCapability): CapabilityRole[] {
  return cap.roles.filter((role) => !role.optional || role.fallback === "none");
}

/** Publish blockers. Only hard-required shortfalls — a role with a working
 * fallback is never a blocker. Empty array for a reserved template with no
 * registered capability. */
export function findIncompleteRoles(spec: GameSpec): RoleGap[] {
  const cap = getCapability(spec.template);
  if (!cap) return [];

  const gaps: RoleGap[] = [];
  for (const role of cap.roles) {
    if (role.fallback !== "none") continue; // the runtime has a stand-in
    const have = playableAssetsForRole(spec, cap, role.id).length;
    if (have < role.count.min) {
      gaps.push({
        role: role.id,
        label: role.id,
        need: role.count.min,
        have,
        hardRequired: true,
      });
    }
  }
  return gaps;
}
