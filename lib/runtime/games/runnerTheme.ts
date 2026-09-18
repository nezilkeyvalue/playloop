// lib/runtime/games/runnerTheme.ts
//
// The runner template's brand skin: every colour, every piece of trackside
// advertising copy, and the runner's kit, in one place. runner.ts reads
// `this.theme.*` and nothing else — it holds no brand-specific hex and no
// `if (brand === ...)` anywhere, which is the whole point of this file.
//
// Where a theme comes from, lowest precedence first:
//
//   1. deriveTheme(brand)       — the BrandKit every GameSpec already
//                                 carries (accent, secondaryAccent,
//                                 background, logo, name). This is the
//                                 normal path: a merchant generates a game
//                                 and it is already their colours, with no
//                                 theme authored anywhere.
//   2. RUNNER_THEME_PRESETS[k]  — a named skin, selected by `spec.meta.theme`
//                                 ("runner:midnight", "runner:sunrise").
//                                 Time-of-day/venue dressing, not a brand.
//   3. MountOptions.brandTheme  — an override object the host passes to
//                                 mount(). Anything in here wins.
//
// All three merge, so a host can supply just `{ character: { shoes: "#fff" } }`
// and keep every derived colour underneath it.
//
// Derivation, not configuration: the environment is a fixed athletics base
// palette MIXED a little way toward the brand's primary, never replaced by
// it. A red brand gets a warm sky, warm-tinted stands and a redder track —
// not a red screen. The brand reads loud where it belongs (kit, hurdle
// accent, hoarding, gantries, UI) and quiet everywhere else, which is what
// keeps the game readable across every brand that embeds it.

import type { BrandKit } from "@/lib/engine/types";
import { shadeHex } from "@/lib/runtime/games/spriteRender";

export interface AdPanel {
  /** "logo" — logo lockup + message; "slogan" — type-only board; "product"
   * — a real product sprite from the collectible pool + message. A product
   * panel with no product available falls back to a logo panel at draw
   * time, so a pool-less spec never renders an empty board. */
  type: "logo" | "slogan" | "product";
  message?: string;
}

export interface RunnerTheme {
  name: string;
  colors: {
    primary: string;
    primaryLight: string;
    primaryDark: string;
    primaryMuted: string;
    secondary: string;
    onPrimary: string;
    text: string;
  };
  environment: {
    skyTop: string;
    skyBottom: string;
    cloud: string;
    standBack: string;
    standFront: string;
    crowd: string;
    wall: string;
    grass: string;
    trackFar: string;
    trackNear: string;
    trackKerb: string;
    laneMarking: string;
    shadow: string;
  };
  character: {
    shirt: string;
    shorts: string;
    socks: string;
    shoes: string;
    shoeAccent: string;
    /** Optional — no headband is drawn when this is absent. */
    headband?: string;
  };
  hurdle: {
    frame: string;
    accent: string;
    stripe: string;
  };
  ui: {
    primary: string;
    secondary: string;
    text: string;
    progress: string;
  };
  advertising: {
    enabled: boolean;
    /** Ad copy. Empty by default — see DEFAULT_SLOGANS. */
    slogans: string[];
    /** One headline message used on logo boards ahead of `slogans`. */
    primaryMessage?: string;
    panels: AdPanel[];
    wallBackground: string;
    wallText: string;
    accentColor: string;
  };
  branding: {
    /** Event name on the start/finish gantries. */
    eventName: string;
    /** Where the brand logo is allowed to appear. "none" keeps the logo off
     * the world entirely (the game still looks finished — gantries and
     * boards fall back to the wordmark). */
    logoPosition: "banner" | "none";
    /** Trackside flags along the grass apron. */
    flags: boolean;
  };
}

/** Deep-partial of RunnerTheme — what a host or a preset supplies. */
export type RunnerThemeOverride = {
  [K in keyof RunnerTheme]?: RunnerTheme[K] extends object
    ? Partial<RunnerTheme[K]>
    : RunnerTheme[K];
};

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

function parseHex(hex: string): [number, number, number] | null {
  const clean = hex.replace("#", "").trim();
  if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
  const num = parseInt(clean, 16);
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff];
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

/** Linear blend: t = 0 is `a`, t = 1 is `b`. Returns `a` unchanged if either
 * side isn't a 6-digit hex, so one malformed brand colour degrades to "no
 * tint" rather than painting black over the scene. */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const k = Math.min(1, Math.max(0, t));
  return toHex(ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k);
}

export function relativeLuminance(hex: string): number {
  const c = parseHex(hex);
  if (!c) return 0.5;
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
}

/** Whichever of two colours is more readable on `background`. */
export function readableOn(background: string, a: string, b: string): string {
  const bg = relativeLuminance(background);
  return Math.abs(relativeLuminance(a) - bg) >= Math.abs(relativeLuminance(b) - bg) ? a : b;
}

/** #rrggbb -> rgba() at the given alpha; input returned unchanged if it
 * isn't a 6-digit hex, so a malformed colour degrades visibly rather than
 * painting transparent. */
export function withAlpha(hex: string, alpha: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

// ---------------------------------------------------------------------------
// The athletics base palette — the "sport", before any brand touches it
// ---------------------------------------------------------------------------

const BASE = {
  sky: "#6fb2e8",
  skyLow: "#d8eefb",
  cloud: "#ffffff",
  stand: "#9db4c9",
  crowd: "#7e94ad",
  wall: "#41506d",
  grass: "#7fa86f",
  trackFar: "#b1563a",
  trackNear: "#d2703f",
  white: "#fbf8f1",
  ink: "#20283c",
  shadow: "rgba(90, 40, 20, 0.22)",
} as const;

/** How far each surface is allowed to move toward the brand's primary. The
 * numbers ARE the "cohesive palette, not a monochrome screen" rule: the kit
 * and the signage take the colour outright, the sky barely notices it. */
const TINT = {
  sky: 0.06,
  stand: 0.2,
  crowd: 0.14,
  wall: 0.28,
  grass: 0.1,
  track: 0.12,
} as const;

/**
 * No default slogans. Ad copy this file invented ("RUN YOUR LIMITS") is
 * copy the merchant never wrote, on a board carrying their name — so the
 * default is empty and the boards fall back to the brand's OWN content:
 * the wordmark, the logo, and real product names from the collectible
 * pool. A host that wants slogans supplies them.
 */
const DEFAULT_SLOGANS: string[] = [];

/** Boards repeat in this order along the hoarding. Deliberately not all
 * the same — a real trackside wall alternates sponsor lockups with
 * product boards and plain wordmark boards. */
const DEFAULT_PANELS: AdPanel[] = [
  { type: "logo" },
  { type: "product" },
  { type: "slogan" },
  { type: "product" },
];

/**
 * The normal path: a full theme derived from the BrandKit the spec already
 * carries. Nothing here needs authoring — a merchant who has never heard of
 * a "theme" still gets their own colours on the kit, the hoarding, the
 * hurdles and the gantries.
 */
export function deriveTheme(brand: BrandKit): RunnerTheme {
  const primary = parseHex(brand.accent) ? brand.accent : "#e2542f";
  const primaryLight = mixHex(primary, "#ffffff", 0.35);
  const primaryDark = shadeHex(primary, -0.22);
  const primaryMuted = mixHex(primary, BASE.ink, 0.55);
  const secondary = brand.secondaryAccent && parseHex(brand.secondaryAccent)
    ? brand.secondaryAccent
    : primaryDark;
  const onPrimary = readableOn(primary, "#ffffff", BASE.ink);
  const wall = mixHex(BASE.wall, primaryDark, TINT.wall);

  return {
    name: brand.name ? `${brand.name} (derived)` : "derived",
    colors: { primary, primaryLight, primaryDark, primaryMuted, secondary, onPrimary, text: BASE.ink },
    environment: {
      skyTop: mixHex(BASE.sky, primary, TINT.sky),
      skyBottom: mixHex(BASE.skyLow, primaryLight, TINT.sky * 2),
      cloud: mixHex(BASE.cloud, primaryLight, 0.06),
      standBack: mixHex(BASE.stand, primaryMuted, TINT.stand),
      standFront: mixHex(shadeHex(BASE.stand, -0.06), primaryMuted, TINT.stand),
      crowd: mixHex(BASE.crowd, primaryDark, TINT.crowd),
      wall,
      grass: mixHex(BASE.grass, primaryMuted, TINT.grass),
      trackFar: mixHex(BASE.trackFar, primary, TINT.track),
      trackNear: mixHex(BASE.trackNear, primary, TINT.track),
      trackKerb: mixHex(BASE.white, primaryLight, 0.12),
      laneMarking: BASE.white,
      shadow: BASE.shadow,
    },
    character: {
      // Same character, different kit. Body, face, hair, proportions and
      // the running animation are fixed in runner.ts and are NOT themeable.
      shirt: primary,
      shorts: mixHex(BASE.ink, primary, 0.22),
      socks: BASE.white,
      shoes: BASE.white,
      shoeAccent: secondary,
      headband: primary,
    },
    hurdle: {
      frame: BASE.white,
      accent: secondary,
      stripe: primary,
    },
    ui: {
      primary,
      secondary,
      text: BASE.white,
      progress: primaryLight,
    },
    advertising: {
      enabled: true,
      slogans: DEFAULT_SLOGANS,
      panels: DEFAULT_PANELS,
      wallBackground: shadeHex(wall, 0.08),
      wallText: readableOn(shadeHex(wall, 0.08), BASE.white, BASE.ink),
      accentColor: primary,
    },
    branding: {
      eventName: brand.name ? `${brand.name.toUpperCase()} RUN` : "TRACK MEET",
      logoPosition: brand.logoUrl ? "banner" : "none",
      flags: true,
    },
  };
}

/**
 * Named skins, selected by `spec.meta.theme`. These are venue/time-of-day
 * dressing layered ON TOP of the brand derivation — they are not brands,
 * which is why none of them names one. A key that doesn't exist here is
 * ignored (the derived theme is used), so a spec carrying a theme string
 * meant for another template renders normally.
 */
export const RUNNER_THEME_PRESETS: Record<string, RunnerThemeOverride> = {
  "runner:midnight": {
    name: "midnight",
    environment: {
      skyTop: "#131a33",
      skyBottom: "#2f3d63",
      cloud: "#39456b",
      standBack: "#2a3453",
      standFront: "#222b45",
      crowd: "#151c30",
      grass: "#2f5340",
      trackFar: "#7e3a2a",
      trackNear: "#a85233",
      shadow: "rgba(6, 10, 24, 0.4)",
    },
  },
  "runner:sunrise": {
    name: "sunrise",
    environment: {
      skyTop: "#f0a06a",
      skyBottom: "#ffe6c9",
      cloud: "#fff4e6",
      standBack: "#c39b8c",
      standFront: "#b28a7c",
      grass: "#8fae6c",
    },
  },
};

/** Shallow-merge each section; a section the override omits is kept whole. */
function applyOverride(base: RunnerTheme, override: RunnerThemeOverride | undefined): RunnerTheme {
  if (!override) return base;
  return {
    name: typeof override.name === "string" ? override.name : base.name,
    colors: { ...base.colors, ...override.colors },
    environment: { ...base.environment, ...override.environment },
    character: { ...base.character, ...override.character },
    hurdle: { ...base.hurdle, ...override.hurdle },
    ui: { ...base.ui, ...override.ui },
    advertising: { ...base.advertising, ...override.advertising },
    branding: { ...base.branding, ...override.branding },
  };
}

/**
 * The one function runner.ts calls. Derived brand theme, then the named
 * preset if `themeKey` matches one, then the host's override object.
 * Every field is populated at every step, so nothing downstream ever sees
 * an undefined colour — the no-theme case is just step one.
 */
export function resolveRunnerTheme(
  brand: BrandKit,
  themeKey?: string,
  override?: RunnerThemeOverride,
): RunnerTheme {
  const derived = deriveTheme(brand);
  const preset = themeKey ? RUNNER_THEME_PRESETS[themeKey] : undefined;
  return applyOverride(applyOverride(derived, preset), override);
}
