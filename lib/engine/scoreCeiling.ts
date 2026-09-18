// lib/engine/scoreCeiling.ts
//
// One answer to "what is the highest score a real player can reach in THIS
// game?", shared by the server's anti-forgery check and the editor's reward
// UI.
//
// `capability.scoring.maxRealistic` is a per-template constant chosen against
// the template's *default* tuning. That was fine while tuning was fixed at
// generation time; once a merchant can raise `durationSec` / `spawnRateHz`,
// honest scores sail past the static number and get zeroed as forged. Each
// game module already exports a tuning-aware `maxRealisticScore(tuning)`
// (declared on the GameModule contract in lib/runtime/gameModule.ts), so the
// ceiling is resolved from there and the static value survives only as the
// fallback.
//
// Isomorphic on purpose: the editor calls this to caption reward thresholds
// and the API route calls it to validate them, and the two must never
// disagree. The game modules import nothing but types at module scope, so
// loading one outside the browser is safe — but every import and call is
// still wrapped, because a bundler that refuses to pull a runtime module into
// a server chunk should degrade to today's behaviour, not throw.

import { getCapability } from "@/lib/capabilities";
import type { GameSpec, TemplateId } from "@/lib/engine/types";

/** capability.scoring.maxRealistic, or undefined for a reserved template. */
export function staticMaxRealisticScore(template: TemplateId): number | undefined {
  return getCapability(template)?.scoring.maxRealistic;
}

/**
 * Compile-time exhaustiveness guard for the switch below.
 *
 * This exists because the `default:` branch that used to sit there returned
 * the static capability value for ANY unhandled template, which is a
 * plausible-looking wrong answer rather than a failure. Seven templates
 * (chomp, whack, simon, slice, sweet_spot, runner, pour) each shipped
 * through it unnoticed, every one of them silently capping honest scores at
 * their default-tuning number and paying no reward above it. Typing the
 * parameter `never` means the next template that forgets a case fails
 * `npm run typecheck` instead.
 *
 * The runtime arm still degrades to the static ceiling, so a build that
 * somehow gets here misprices scores rather than throwing.
 */
function assertNever(_value: never, fallback: number | undefined): number | undefined {
  return fallback;
}

/**
 * The ceiling for THIS game's tuning. Dynamically imports the template's
 * runtime module and calls its maxRealisticScore(); falls back to
 * staticMaxRealisticScore on any import/throw/non-finite result, so a server
 * bundle that can't load a runtime module degrades instead of failing.
 * Isomorphic — safe on the server and in the editor.
 */
export async function resolveMaxRealisticScore(
  template: TemplateId,
  tuning: Record<string, number>,
): Promise<number | undefined> {
  const fallback = staticMaxRealisticScore(template);

  try {
    // An explicit switch with literal specifiers, never `import(path)` built
    // from `template` — a template-string specifier is unanalysable, so the
    // bundler would either fail to resolve it or pull in every sibling file.
    let resolved: number;
    switch (template) {
      case "catch":
        resolved = (await import("@/lib/runtime/games/catch")).maxRealisticScore(tuning);
        break;
      case "guess_price":
        resolved = (await import("@/lib/runtime/games/guessPrice")).maxRealisticScore(tuning);
        break;
      case "chain_pop":
        resolved = (await import("@/lib/runtime/games/chainPop")).maxRealisticScore(tuning);
        break;
      case "shooter":
        resolved = (await import("@/lib/runtime/games/shooter")).maxRealisticScore(tuning);
        break;
      case "chomp":
        resolved = (await import("@/lib/runtime/games/chomp")).maxRealisticScore(tuning);
        break;
      case "whack":
        resolved = (await import("@/lib/runtime/games/whack")).maxRealisticScore(tuning);
        break;
      case "simon":
        resolved = (await import("@/lib/runtime/games/simon")).maxRealisticScore(tuning);
        break;
      case "slice":
        resolved = (await import("@/lib/runtime/games/slice")).maxRealisticScore(tuning);
        break;
      case "sweet_spot":
        resolved = (await import("@/lib/runtime/games/sweetSpot")).maxRealisticScore(tuning);
        break;
      case "runner":
        resolved = (await import("@/lib/runtime/games/runner")).maxRealisticScore(tuning);
        break;
      case "pour":
        resolved = (await import("@/lib/runtime/games/pour")).maxRealisticScore(tuning);
        break;
      case "match":
      case "stack":
        // Genuinely reserved: no runtime module exists for these yet, so the
        // static capability value is the only answer available.
        return fallback;
      default:
        // Exhaustiveness guard — see assertNever's comment. Listing the
        // reserved ids explicitly above is what makes this reachable only
        // for a TemplateId nobody has handled, and therefore a COMPILE
        // error rather than a silent wrong answer.
        return assertNever(template, fallback);
    }

    // A zero or negative ceiling would reject every score as forged, and NaN
    // would compare false against everything — neither is a usable answer, so
    // treat them like an import failure.
    if (!Number.isFinite(resolved) || resolved <= 0) return fallback;
    return resolved;
  } catch {
    return fallback;
  }
}

/** Convenience: resolveMaxRealisticScore(spec.template, effectiveTuning(spec)). */
export async function resolveMaxRealisticScoreForSpec(
  spec: GameSpec,
): Promise<number | undefined> {
  return resolveMaxRealisticScore(spec.template, effectiveTuning(spec));
}

/**
 * The tuning a game actually runs with: `durationSeconds` is the spec-level
 * field, but every game module reads the round length from `tuning.durationSec`
 * — so mount.ts reconciles the two before handing tuning to the module, and
 * any ceiling computed off un-reconciled tuning would silently use the
 * module's own default duration instead of this game's.
 */
export function effectiveTuning(spec: GameSpec): Record<string, number> {
  // noUncheckedIndexedAccess: spec.tuning.durationSec is `number | undefined`,
  // so the ?? chain is load-bearing, not defensive.
  return { ...spec.tuning, durationSec: spec.tuning.durationSec ?? spec.durationSeconds };
}
