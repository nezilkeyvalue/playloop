// lib/capabilities/index.ts
//
// Loader + validation for GameCapability definitions. Templates are data:
// adding a fifth game means dropping a new JSON file here (and a runtime
// module in lib/runtime/games) — nothing in the matcher changes.
// Build spec §5.3 / capability schema §6.

import { z } from "zod";
import type { GameCapability, Placement, TemplateId } from "@/lib/engine/types";

import catchCapability from "./catch.json";
import guessPriceCapability from "./guess_price.json";
import chainPopCapability from "./chain_pop.json";

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
  id: z.enum(["catch", "guess_price", "chain_pop", "match", "stack"]),
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
};

/** All templates currently implemented (catch, guess_price, chain_pop).
 * Post-MVP ids (match, stack) are reserved in the type system but
 * intentionally absent here — an absent capability makes a template
 * automatically ineligible everywhere. */
export function listCapabilities(): GameCapability[] {
  return Object.values(registry);
}

export function getCapability(id: TemplateId): GameCapability | undefined {
  return registry[id];
}

export function requireCapability(id: TemplateId): GameCapability {
  const cap = registry[id];
  if (!cap) throw new Error(`Unknown or unimplemented template capability: ${id}`);
  return cap;
}

export function supportsPlacement(cap: GameCapability, placement: Placement): boolean {
  return Boolean(cap.placements[placement]);
}
