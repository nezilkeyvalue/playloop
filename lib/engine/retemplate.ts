// lib/engine/retemplate.ts
//
// Switches an already-generated, possibly merchant-edited GameSpec onto a
// different template. This is NOT a second pipeline: it re-runs the same
// matcher (lib/engine/matcher.ts) against the game's original AssetInventory
// (only available for auto-mode games — see the route that calls this) and
// reuses compose.ts's own role/asset builders, so a switched game's roles
// are derived exactly as a freshly generated one's would be.
//
// What deliberately DOES NOT change: brand, copy, rewards, durationSeconds,
// and every already-kept asset's presentation/backgroundTreatment/
// subjectBounds/colorAdjust. Those are the merchant's own edits (or the
// original brain.ts vision judgment) and a template switch is not a reason
// to discard either — only `template`, `placements`, `roles`, `tuning` and
// `assets` (additively, for any asset the new template needs that the old
// one never touched) are template-shaped enough to need re-deriving.

import type { AssetInventory, GameSpec, TemplateId } from "@/lib/engine/types";
import { getCapability } from "@/lib/capabilities";
import { matchAssets } from "@/lib/engine/matcher";
import { clampTuningValue } from "@/lib/engine/specRules";
import { MVP_PLACEMENTS, buildProcessedAssets, buildRoles } from "@/lib/engine/compose";

export type RetemplateResult =
  | { ok: true; patch: Pick<GameSpec, "template" | "placements" | "assets" | "roles" | "tuning" | "meta"> }
  | { ok: false; message: string };

export function retemplateSpec(
  current: GameSpec,
  inventory: AssetInventory,
  template: TemplateId,
): RetemplateResult {
  const cap = getCapability(template);
  if (!cap) return { ok: false, message: "That template isn't available." };

  const match = matchAssets(inventory, [cap]).results[0];
  if (!match || !match.eligible) {
    const reasons = (match?.gaps ?? [])
      .map((gap) => `needs ${gap.need} ${gap.role.replace(/([a-z])([A-Z])/g, "$1 $2")} image(s), found ${gap.have}`)
      .join("; ");
    return {
      ok: false,
      message: reasons
        ? `${cap.name} isn't a fit for this game's images — ${reasons}.`
        : `${cap.name} isn't a fit for this game's images.`,
    };
  }

  // Every id the new template actually assigned. Anything already in
  // current.assets is kept as-is (its processed presentation/backdrop is
  // preserved); only ids the OLD template never surfaced get built fresh
  // from the inventory, the same way compose() builds them for a new game.
  const assignedIds = new Set<string>();
  for (const value of Object.values(match.assignments ?? {})) {
    if (Array.isArray(value)) value.forEach((id) => assignedIds.add(id));
  }
  const currentIds = new Set(current.assets.map((a) => a.id));
  const missingIds = new Set([...assignedIds].filter((id) => !currentIds.has(id)));
  const newlyBuilt =
    missingIds.size > 0
      ? buildProcessedAssets(inventory.assets, missingIds, undefined, undefined, undefined, undefined)
      : [];
  const assets = [...current.assets, ...newlyBuilt];

  const usableIds = new Set(assets.map((a) => a.id));
  const warnings = [...(match.warnings ?? [])];
  for (const gap of match.gaps ?? []) {
    warnings.push(`${gap.role}: needed ${gap.need}, had ${gap.have} (${gap.reason})`);
  }
  const roles = buildRoles(match.assignments, usableIds, warnings);

  // Tuning keys the new template doesn't declare are simply absent from the
  // result (nothing would ever read them); a key the merchant already tuned
  // that the new template ALSO declares keeps its value, reclamped to the
  // new template's own range rather than reset to that template's default.
  const tuning: Record<string, number> = {};
  for (const [key, range] of Object.entries(cap.tuning)) {
    const existing = current.tuning[key];
    tuning[key] = typeof existing === "number" ? clampTuningValue(existing, range) : range.default;
  }

  const supportedPlacements = MVP_PLACEMENTS.filter((p) => Boolean(cap.placements[p]));
  const placements = supportedPlacements.length > 0 ? supportedPlacements : ["section" as const];

  return {
    ok: true,
    patch: {
      template,
      placements,
      assets,
      roles,
      tuning,
      meta: { ...current.meta, warnings },
    },
  };
}
