// lib/runtime/mount.ts
//
// The runtime entry point (build spec §13):
//
//   mount(spec, container, placement) → { teardown }
//
// Reads roles from spec.roles, resolves the right game module by
// spec.template, loads sprite images, sizes the canvas via stage.ts, runs
// the loop, wires input, reports telemetry at the right lifecycle points,
// and shows the reward reveal via reward.ts at game end.
//
// No browser storage anywhere (build spec §4/§14/§23) — every bit of state
// here lives in memory for the lifetime of this mount and disappears on
// teardown; the only durable state is server-side, reached via
// telemetry.ts's calls to /api/plays/* and /api/leads.

import type {
  FallbackKind,
  GameCapability,
  GameSpec,
  Placement,
  TemplateId,
} from "@/lib/engine/types";
import { getCapability } from "@/lib/capabilities";
import type { GameModule, LoadedAsset, ResolvedRole, RuntimeContext } from "@/lib/runtime/gameModule";
import { createInput } from "@/lib/runtime/input";
import { startLoop, type LoopHandle } from "@/lib/runtime/loop";
import { animateCountUp, resolveReward } from "@/lib/runtime/reward";
import { mountStage, type StageController } from "@/lib/runtime/stage";
import { beginSession, captureLead, endSession, trackEvent } from "@/lib/runtime/telemetry";
import { createCatchGame } from "@/lib/runtime/games/catch";
import { createGuessPriceGame } from "@/lib/runtime/games/guessPrice";
import { createChainPopGame } from "@/lib/runtime/games/chainPop";
import { createChompGame } from "@/lib/runtime/games/chomp";

type GameModuleFactory = () => GameModule;

/** "catch", "guess_price", "chain_pop", and "chomp" are implemented.
 * "match" / "stack" are reserved TemplateId values with no capability JSON
 * and no runtime module yet — mount() degrades to a friendly message. */
const REGISTRY: Partial<Record<TemplateId, GameModuleFactory>> = {
  catch: createCatchGame,
  guess_price: createGuessPriceGame,
  chain_pop: createChainPopGame,
  chomp: createChompGame,
};

export interface MountOptions {
  /**
   * Public slug for telemetry (`POST /api/plays/start { slug }`). GameSpec
   * has no slug field of its own — slugs live on the GameRecord a
   * different track owns — so this is an optional 4th argument rather than
   * a change to the 3-argument signature the build spec gives verbatim.
   * Falls back to `spec.id` when omitted, which is deliberately also the
   * slug the fixtures use ("demo-catch", "demo-guess-price"), so the
   * simplest possible caller — `mount(spec, container, placement)` — still
   * produces a correct telemetry call.
   */
  slug?: string;
  /**
   * Skip the idle screen and drop straight into gameplay once assets are
   * loaded. Built for the editor's per-screen preview (see
   * app/(app)/games/[id]/page.tsx's "Game screen" tab) — it wants to show
   * the actual play canvas immediately rather than the idle overlay every
   * other mount() caller wants first. Never used by the embed script or the
   * hosted /play/:slug page.
   */
  autoStart?: boolean;
}

export interface MountHandle {
  teardown(): void;
}

export function mount(
  spec: GameSpec,
  container: HTMLElement,
  placement: Placement,
  options: MountOptions = {},
): MountHandle {
  const slug = options.slug ?? spec.id;
  const capability = getCapability(spec.template);
  const factory = REGISTRY[spec.template];

  if (!factory) {
    return renderUnavailable(container, `"${spec.template}" isn't ready to play yet.`);
  }
  if (!capability) {
    return renderUnavailable(container, "This game's configuration is missing.");
  }

  return mountGame(spec, container, placement, slug, capability, factory, options.autoStart ?? false);
}

// ---------------------------------------------------------------------------

function mountGame(
  spec: GameSpec,
  container: HTMLElement,
  placement: Placement,
  slug: string,
  capability: GameCapability,
  factory: GameModuleFactory,
  autoStart: boolean,
): MountHandle {
  const brand = spec.brand;
  const copy = spec.copy;

  ensureGoogleFontLoaded(brand.fontFamily);

  // --- DOM scaffold -------------------------------------------------------
  const shell = document.createElement("div");
  shell.style.position = "relative";
  shell.style.width = "100%";
  shell.style.overflow = "hidden";
  shell.style.fontFamily = brand.fontFamily || "system-ui, sans-serif";
  shell.style.background = "transparent";
  shell.style.userSelect = "none";
  shell.style.touchAction = "none"; // dragging the basket/slider shouldn't scroll the host page

  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.display = "block";
  canvas.style.touchAction = "none";

  const overlay = document.createElement("div");
  overlay.style.position = "absolute";
  overlay.style.inset = "0";
  overlay.style.display = "flex";
  overlay.style.flexDirection = "column";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.gap = "12px";
  overlay.style.textAlign = "center";
  overlay.style.padding = "24px";
  overlay.style.boxSizing = "border-box";
  overlay.style.color = brand.foreground;
  overlay.style.background = `linear-gradient(180deg, ${brand.background}f2, ${brand.background}f2)`;

  shell.appendChild(canvas);
  shell.appendChild(overlay);
  container.innerHTML = "";
  container.appendChild(shell);

  setOverlay(overlay, renderLoadingState());

  // --- stage sizing --------------------------------------------------------
  const constraint = capability.placements[placement];
  const stageController: StageController = mountStage(canvas, container, placement, constraint, () => {
    shell.style.height = `${stageController.size.height}px`;
  });
  shell.style.height = `${stageController.size.height}px`;

  // --- input ----------------------------------------------------------------
  // Bound to the canvas, not the shell: the shell also contains the overlay
  // chrome (idle/reward screens' buttons and email input). createInput()
  // calls setPointerCapture() on every pointerdown, which per the Pointer
  // Events spec retargets the resulting click to the capturing element —
  // so a pointerdown starting on an overlay button would have its click
  // redelivered to the shell instead of the button, silently swallowing
  // "Start playing" / "Play again" / the email field. Canvas and overlay
  // are siblings, so scoping capture to canvas leaves overlay clicks alone.
  const input = createInput(canvas);

  // --- tuning, defensively re-clamped --------------------------------------
  const tuning = clampTuning({ ...spec.tuning, durationSec: spec.tuning.durationSec ?? spec.durationSeconds }, capability);

  // --- load every referenced sprite up front --------------------------------
  let loaded = new Map<string, LoadedAsset>();
  let loop: LoopHandle | null = null;
  let gameModule: GameModule | null = null;
  let score = 0;
  let activeSessionToken: Promise<string | null> | null = null;
  let destroyed = false;

  function addScore(delta: number) {
    score = Math.max(0, Math.round(score + delta));
  }
  function getScore() {
    return score;
  }
  function complete() {
    if (destroyed) return;
    void onGameComplete();
  }

  const runtimeCtx: RuntimeContext = {
    spec,
    tuning,
    roles: {},
    brand,
    copy,
    stage: { width: stageController.size.width, height: stageController.size.height },
    input: input.state,
    random: Math.random,
    addScore,
    getScore,
    complete,
    brandLogo: null,
  };

  Promise.all([
    Promise.all(spec.assets.map((asset) => loadAsset(asset))),
    loadImage(brand.logoUrl ?? ""),
  ])
    .then(([assets, brandLogo]) => {
      if (destroyed) return;
      loaded = new Map(assets.map((a) => [a.id, a]));
      runtimeCtx.roles = resolveRoles(spec, loaded);
      runtimeCtx.brandLogo = brandLogo;
      trackEvent("impression", { slug, template: spec.template });
      if (autoStart) startPlay(false);
      else showIdleScreen();
    })
    .catch(() => {
      if (destroyed) return;
      runtimeCtx.roles = resolveRoles(spec, loaded);
      if (autoStart) startPlay(false);
      else showIdleScreen();
    });

  function showIdleScreen() {
    setOverlay(overlay, renderIdleState(brand, copy, () => startPlay(false)));
  }

  function startPlay(isReplay: boolean) {
    score = 0;
    setOverlay(overlay, null); // hide chrome; the game renders on canvas
    activeSessionToken = beginSession(slug);
    trackEvent(isReplay ? "replay" : "start", { slug });

    const mod = factory();
    gameModule = mod;
    // Pass the live runtimeCtx (not a copy): its `.stage` is a shared,
    // mutable object the render loop below updates in place every tick, so
    // a mid-game container resize (e.g. a phone rotation) is visible to
    // the game module immediately rather than frozen at init-time size.
    runtimeCtx.stage.width = stageController.size.width;
    runtimeCtx.stage.height = stageController.size.height;
    mod.init(runtimeCtx);

    loop?.stop();
    loop = startLoop(
      (dt) => {
        runtimeCtx.stage.width = stageController.size.width;
        runtimeCtx.stage.height = stageController.size.height;
        input.poll();
        mod.update(dt);
      },
      () => {
        mod.render(stageController.ctx);
      },
    );
  }

  async function onGameComplete() {
    loop?.stop();
    gameModule?.teardown();

    const finalScore = score;
    const sessionToken = activeSessionToken ? await activeSessionToken : null;
    const server = await endSession(sessionToken, finalScore);
    const resolved = resolveReward(finalScore, spec.rewards);

    setOverlay(
      overlay,
      renderRewardState(brand, copy, resolved.tier, server.code, () => {
        void submitLead(sessionToken);
      }, () => {
        startPlay(true);
      }),
    );

    await animateCountUp(0, finalScore, 700, (value) => {
      const el = overlay.querySelector<HTMLElement>("[data-role='score-value']");
      if (el) el.textContent = String(value);
    });

    trackEvent("reward_revealed", { slug, score: finalScore, tier: resolved.tier.label });
  }

  async function submitLead(sessionToken: string | null): Promise<boolean> {
    const emailField = overlay.querySelector<HTMLInputElement>("[data-role='email-input']");
    const status = overlay.querySelector<HTMLElement>("[data-role='email-status']");
    const email = emailField?.value?.trim() ?? "";
    if (!email) return false;
    const ok = await captureLead(sessionToken, email);
    if (status) status.textContent = ok ? "Sent — check your inbox." : "Saved for later — we'll email it once this game goes live.";
    if (ok) trackEvent("lead_captured", { slug });
    return ok;
  }

  function teardown() {
    destroyed = true;
    loop?.stop();
    gameModule?.teardown();
    input.destroy();
    stageController.destroy();
    container.innerHTML = "";
  }

  return { teardown };
}

// ---------------------------------------------------------------------------
// Web font loading
// ---------------------------------------------------------------------------

// BrandKit.fontFamily has always been "a mapped Google Font" by convention
// (see the type's own comment) and was already being set as a CSS
// font-family and even used in canvas `ctx.font` strings — but nothing
// anywhere ever actually loaded the font. Every game was silently
// rendering in the browser's default sans-serif regardless of what
// fontFamily said, auto-generated or editor-picked alike. One `<link>` per
// distinct family, deduped across mounts on the same page (e.g. the editor
// remounting on every save).
const loadedFontFamilies = new Set<string>();
const GENERIC_FONT_KEYWORDS = new Set([
  "system-ui",
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
]);

function ensureGoogleFontLoaded(fontFamilyList: string | undefined): void {
  if (typeof document === "undefined" || !fontFamilyList) return;
  // fontFamily may be a single mapped name ("Poppins", from auto-generation)
  // or a full CSS stack with fallbacks ("Inter, system-ui, sans-serif",
  // from manual mode) — Google Fonts' API wants just the one real name.
  const primary = fontFamilyList
    .split(",")[0]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  if (!primary || GENERIC_FONT_KEYWORDS.has(primary.toLowerCase())) return;
  if (loadedFontFamilies.has(primary)) return;
  loadedFontFamilies.add(primary);

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(primary).replace(/%20/g, "+")}:wght@400;500;600;700&display=swap`;
  document.head.appendChild(link);
}

// ---------------------------------------------------------------------------
// Role resolution
// ---------------------------------------------------------------------------

function resolveRoles(spec: GameSpec, loaded: Map<string, LoadedAsset>): Record<string, ResolvedRole> {
  const result: Record<string, ResolvedRole> = {};
  for (const [roleId, entry] of Object.entries(spec.roles)) {
    if (Array.isArray(entry)) {
      const assets = entry
        .map((id) => loaded.get(id))
        .filter((a): a is LoadedAsset => Boolean(a));
      result[roleId] = { assets };
    } else if (entry && typeof entry === "object" && "fallback" in entry) {
      result[roleId] = { assets: [], fallback: entry.fallback as FallbackKind };
    } else {
      result[roleId] = { assets: [] };
    }
  }
  return result;
}

function clampTuning(tuning: Record<string, number>, capability: GameCapability): Record<string, number> {
  const clamped: Record<string, number> = { ...tuning };
  for (const [key, range] of Object.entries(capability.tuning)) {
    const value = clamped[key] ?? range.default;
    clamped[key] = Math.min(range.max, Math.max(range.min, value));
  }
  return clamped;
}

// ---------------------------------------------------------------------------
// Asset loading — never throws, never blocks forever on one bad URL.
// ---------------------------------------------------------------------------

function loadAsset(asset: GameSpec["assets"][number]): Promise<LoadedAsset> {
  return loadImage(asset.spriteUrl).then((image) => ({
    id: asset.id,
    image,
    width: asset.width,
    height: asset.height,
    data: asset.data,
    presentation: asset.presentation,
    backgroundColor: asset.backgroundColor,
    backgroundTreatment: asset.backgroundTreatment,
  }));
}

function loadImage(url: string, timeoutMs = 6000): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!url) {
      resolve(null);
      return;
    }
    const img = new Image();
    let settled = false;
    const finish = (value: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    img.onload = () => finish(img);
    img.onerror = () => finish(null);
    img.decoding = "async";
    img.crossOrigin = "anonymous";
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Overlay rendering — plain DOM, no framework. Each render* function returns
// a detached element or null (null hides the overlay's background so the
// canvas is fully visible during play).
// ---------------------------------------------------------------------------

/**
 * Builds the idle or reward overlay exactly as mountGame() shows it
 * mid-play — for the editor's "Start screen" / "End summary" tabs
 * (app/(app)/games/[id]/page.tsx), which need a screen preview but have no
 * canvas, game loop, or real score to drive an actual mount(). Reuses
 * renderIdleState/renderRewardState directly rather than a separate
 * hand-rolled reimplementation, specifically so this preview can never
 * visually drift from the "Whole game" tab's live canvas mount the way a
 * parallel copy inevitably would (font weights, wrapping width, spacing —
 * all real bugs found the first time this existed as a JSX mock). Buttons
 * are real but inert (wired to no-ops); the reward screen shows a
 * representative example score since there's no live session to reveal.
 */
const STATIC_PREVIEW_EXAMPLE_SCORE = 128;

export function renderStaticScreen(kind: "idle" | "reward", spec: GameSpec): HTMLElement {
  const { brand, copy } = spec;
  ensureGoogleFontLoaded(brand.fontFamily);

  const shell = document.createElement("div");
  shell.style.position = "relative";
  shell.style.width = "100%";
  shell.style.minHeight = "480px";
  shell.style.display = "flex";
  shell.style.flexDirection = "column";
  shell.style.alignItems = "center";
  shell.style.justifyContent = "center";
  shell.style.gap = "12px";
  shell.style.textAlign = "center";
  shell.style.padding = "24px";
  shell.style.boxSizing = "border-box";
  shell.style.fontFamily = brand.fontFamily || "system-ui, sans-serif";
  shell.style.color = brand.foreground;
  shell.style.background = `linear-gradient(180deg, ${brand.background}f2, ${brand.background}f2)`;

  if (kind === "idle") {
    shell.appendChild(renderIdleState(brand, copy, () => {}));
    return shell;
  }

  const { tier } = resolveReward(STATIC_PREVIEW_EXAMPLE_SCORE, spec.rewards);
  const content = renderRewardState(brand, copy, tier, null, () => {}, () => {});
  const scoreEl = content.querySelector<HTMLElement>("[data-role='score-value']");
  if (scoreEl) scoreEl.textContent = String(STATIC_PREVIEW_EXAMPLE_SCORE);
  const emailField = content.querySelector<HTMLInputElement>("[data-role='email-input']");
  if (emailField) emailField.disabled = true;
  shell.appendChild(content);
  return shell;
}

function setOverlay(overlay: HTMLElement, content: HTMLElement | null) {
  overlay.innerHTML = "";
  if (!content) {
    overlay.style.background = "transparent";
    overlay.style.pointerEvents = "none";
    return;
  }
  overlay.style.pointerEvents = "auto";
  overlay.appendChild(content);
}

function renderLoadingState(): HTMLElement {
  const wrap = document.createElement("div");
  const p = document.createElement("p");
  p.textContent = "Loading…";
  p.style.opacity = "0.7";
  p.style.fontSize = "14px";
  wrap.appendChild(p);
  return wrap;
}

function renderIdleState(brand: GameSpec["brand"], copy: GameSpec["copy"], onStart: () => void): HTMLElement {
  const wrap = document.createElement("div");

  if (brand.logoUrl) {
    const logo = document.createElement("img");
    logo.src = brand.logoUrl;
    logo.alt = "";
    // Explicit, not inherited: `overlay`'s textAlign:center only centers
    // inline-level boxes. That silently centered the logo by luck as long
    // as <img> defaulted to display:inline — until a host page's own CSS
    // reset (Tailwind's preflight among them, which is what this app's own
    // editor preview loads — see renderStaticScreen()) sets `img { display:
    // block }`, at which point text-align stops applying and the logo
    // sticks flush-left. A block-level box needs its own centering, so set
    // it directly rather than depending on an ancestor's text-align — this
    // must hold on arbitrary third-party host pages the embed script runs
    // on, not just this app's own CSS.
    logo.style.display = "block";
    logo.style.height = "32px";
    logo.style.width = "auto";
    logo.style.marginTop = "0";
    logo.style.marginBottom = "8px";
    logo.style.marginLeft = "auto";
    logo.style.marginRight = "auto";
    logo.style.objectFit = "contain";
    wrap.appendChild(logo);
  }

  const headline = document.createElement("h2");
  headline.textContent = copy.headline;
  headline.style.margin = "0";
  headline.style.fontSize = "clamp(18px, 4vw, 26px)";
  headline.style.fontWeight = "700";
  wrap.appendChild(headline);

  const subhead = document.createElement("p");
  subhead.textContent = copy.subhead;
  subhead.style.margin = "0 0 8px";
  subhead.style.fontSize = "14px";
  subhead.style.opacity = "0.8";
  wrap.appendChild(subhead);

  const button = makeButton(copy.ctaStart, brand.accent, brand.background);
  button.addEventListener("click", onStart);
  wrap.appendChild(button);

  return wrap;
}

function renderRewardState(
  brand: GameSpec["brand"],
  copy: GameSpec["copy"],
  tier: GameSpec["rewards"][number],
  serverCode: string | null,
  onSubmitEmail: () => void,
  onReplay: () => void,
): HTMLElement {
  const wrap = document.createElement("div");

  const intro = document.createElement("p");
  intro.textContent = copy.rewardIntro;
  intro.style.margin = "0";
  intro.style.fontSize = "13px";
  intro.style.opacity = "0.8";
  wrap.appendChild(intro);

  const scoreLine = document.createElement("p");
  scoreLine.style.margin = "0";
  scoreLine.style.fontSize = "32px";
  scoreLine.style.fontWeight = "800";
  const scoreValue = document.createElement("span");
  scoreValue.dataset.role = "score-value";
  scoreValue.textContent = "0";
  scoreLine.appendChild(scoreValue);
  wrap.appendChild(scoreLine);

  const tierLine = document.createElement("p");
  tierLine.textContent =
    tier.percentOff != null ? `${tier.label} — code ${serverCode ?? tier.code ?? "pending"}` : tier.label;
  tierLine.style.margin = "0 0 4px";
  tierLine.style.fontSize = "16px";
  tierLine.style.fontWeight = "600";
  tierLine.style.color = brand.accent;
  wrap.appendChild(tierLine);

  const emailRow = document.createElement("div");
  emailRow.style.display = "flex";
  emailRow.style.gap = "8px";
  emailRow.style.marginTop = "8px";
  emailRow.style.flexWrap = "wrap";
  emailRow.style.justifyContent = "center";

  const emailInput = document.createElement("input");
  emailInput.type = "email";
  emailInput.placeholder = copy.emailPrompt;
  emailInput.dataset.role = "email-input";
  emailInput.style.padding = "8px 10px";
  emailInput.style.borderRadius = "8px";
  emailInput.style.border = `1px solid ${brand.foreground}33`;
  emailInput.style.fontSize = "14px";
  emailInput.style.minWidth = "0";
  emailInput.style.flex = "1 1 160px";
  emailRow.appendChild(emailInput);

  const emailButton = makeButton(copy.emailPrompt, brand.accent, brand.background);
  emailButton.style.padding = "8px 14px";
  emailButton.addEventListener("click", onSubmitEmail);
  emailRow.appendChild(emailButton);
  wrap.appendChild(emailRow);

  const emailStatus = document.createElement("p");
  emailStatus.dataset.role = "email-status";
  emailStatus.style.margin = "4px 0 0";
  emailStatus.style.fontSize = "12px";
  emailStatus.style.opacity = "0.7";
  emailStatus.style.minHeight = "1.2em";
  wrap.appendChild(emailStatus);

  const replayButton = makeButton(copy.ctaReplay, "transparent", brand.foreground);
  replayButton.style.marginTop = "10px";
  replayButton.style.border = `1px solid ${brand.foreground}55`;
  replayButton.style.color = brand.foreground;
  replayButton.addEventListener("click", onReplay);
  wrap.appendChild(replayButton);

  return wrap;
}

function renderUnavailable(container: HTMLElement, message: string): MountHandle {
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.alignItems = "center";
  wrap.style.justifyContent = "center";
  wrap.style.minHeight = "160px";
  wrap.style.color = "#666";
  wrap.style.fontFamily = "system-ui, sans-serif";
  wrap.style.fontSize = "14px";
  wrap.textContent = message;
  container.innerHTML = "";
  container.appendChild(wrap);
  return {
    teardown() {
      container.innerHTML = "";
    },
  };
}

function makeButton(label: string, background: string, foregroundOnAccent: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.style.appearance = "none";
  button.style.border = "none";
  button.style.borderRadius = "999px";
  button.style.padding = "10px 20px";
  button.style.fontSize = "14px";
  button.style.fontWeight = "700";
  button.style.cursor = "pointer";
  button.style.background = background;
  button.style.color = background === "transparent" ? foregroundOnAccent : bestTextColor(background);
  return button;
}

function bestTextColor(hex: string): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return "#ffffff";
  const num = parseInt(clean, 16);
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#111111" : "#ffffff";
}
