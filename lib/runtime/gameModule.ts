// lib/runtime/gameModule.ts
//
// Runtime-only contract between mount.ts and each game template. This is
// deliberately NOT part of lib/engine/types.ts — that file is the
// cross-track contract (GameSpec etc.); this is internal to the runtime
// track and only lib/runtime/** needs to agree on it.
//
// Build spec §13 (Game runtime) defines the shape of GameModule verbatim;
// RuntimeContext is the object mount.ts hands to init() so a game module
// never has to touch the DOM, telemetry, or role-resolution itself.

import type {
  AssetBackgroundTreatment,
  AssetPresentation,
  BrandKit,
  ColorAdjust,
  FallbackKind,
  GameCopy,
  GameSpec,
  SubjectBounds,
  TemplateId,
} from "@/lib/engine/types";
import type { InputState } from "@/lib/runtime/input";
import type { GameAudio } from "@/lib/runtime/audio";
import type { RunnerThemeOverride } from "@/lib/runtime/games/runnerTheme";

/** One asset, resolved to a loaded (or failed-to-load) image element. */
export interface LoadedAsset {
  id: string;
  image: HTMLImageElement | null; // null if the sprite never loaded — degrade, don't crash
  width: number;
  height: number;
  data?: { name?: string; priceMinor?: number; currency?: string; productUrl?: string };
  /** See ProcessedAsset/AssetPresentation in lib/engine/types.ts — how this
   * sprite's background should be treated by a renderer that frames it. */
  presentation?: AssetPresentation;
  backgroundColor?: string;
  backgroundTreatment?: AssetBackgroundTreatment;
  subjectBounds?: SubjectBounds;
  colorAdjust?: ColorAdjust;
}

/**
 * A role after `spec.roles` has been resolved against `spec.assets`.
 * Exactly one of `assets.length > 0` or `fallback` is the "real" answer;
 * both can be inspected because a role can be an empty optional role with
 * no fallback declared either (e.g. hazards nobody assigned).
 */
export interface ResolvedRole {
  assets: LoadedAsset[];
  fallback?: FallbackKind;
}

export interface RuntimeContext {
  spec: GameSpec;
  /** spec.tuning, defensively re-clamped against the capability's declared ranges. */
  tuning: Record<string, number>;
  roles: Record<string, ResolvedRole>;
  brand: BrandKit;
  /** brand.logoUrl, pre-loaded once at mount time — null if there's no logo
   * or it failed to load. The logo isn't tied to any role (buildBrandKit
   * sets it straight from inventory.brand.logo, outside spec.assets/roles),
   * so mount.ts loads it separately rather than a game module ever calling
   * `new Image()` itself (forbidden — see docs/ADDING_A_TEMPLATE.md). */
  brandLogo: HTMLImageElement | null;
  copy: GameCopy;
  /** An optional brand skin from the host (MountOptions.brandTheme), merged
   * over whatever the template derives from `brand`. Only `runner` reads it
   * today; a template that ignores it renders exactly as before. */
  brandTheme?: RunnerThemeOverride;
  /** Logical (CSS-pixel, not device-pixel) stage size. Query fresh each frame if needed. */
  stage: { width: number; height: number };
  input: InputState;
  random: () => number;
  addScore(delta: number): void;
  getScore(): number;
  /** Game module calls this whenever the player genuinely engages with a
   * real product asset (a catch, a popped chain, a hit, a round shown) —
   * never for hazards/decoys/generated-shape fallbacks/synthesized filler.
   * mount.ts accumulates these (deduped) to show a recap gallery of the
   * products actually played with on the reward screen. */
  recordEngagement(assetId: string): void;
  /** Sound cues. Always present and always safe to call: it is a no-op
   * before the player's first gesture, while muted, and on any browser
   * where audio is unavailable — so a template never branches on it.
   * Use the semantic cue names, not one cue per event type; see
   * lib/runtime/audio.ts. */
  sound: GameAudio;
  /** Game module calls this the instant it knows the round/session is over. */
  complete(): void;
}

export interface GameModule {
  id: TemplateId;
  init(ctx: RuntimeContext): void;
  update(dt: number): void;
  render(c: CanvasRenderingContext2D): void;
  teardown(): void;
  /**
   * A ceiling on the achievable score for the given tuning — used server-side
   * (a different track) to reject forged scores. Must stay in the same order
   * of magnitude as the achievable score under normal play; see comments in
   * each game module for how the constant was chosen against the capability's
   * declared `scoring.maxRealistic`.
   */
  maxRealisticScore(tuning: Record<string, number>): number;
}
