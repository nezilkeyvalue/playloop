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
  RewardTier,
  TemplateId,
} from "@/lib/engine/types";
import { getCapability } from "@/lib/capabilities";
import type { GameModule, LoadedAsset, ResolvedRole, RuntimeContext } from "@/lib/runtime/gameModule";
import { isBrandLogoUrl, shadeHex } from "@/lib/runtime/games/spriteRender";
import type { RunnerThemeOverride } from "@/lib/runtime/games/runnerTheme";
import { createInput } from "@/lib/runtime/input";
import { createAudio, loadMutePreference, saveMutePreference } from "@/lib/runtime/audio";
import { startLoop, type LoopHandle } from "@/lib/runtime/loop";
import { entryTier } from "@/lib/engine/specRules";
import { animateCountUp, nextTierAbove, resolveReward } from "@/lib/runtime/reward";
import { mountStage, type StageController, type StageSizeOverride } from "@/lib/runtime/stage";
import {
  beginSession,
  captureLead,
  claimCoupon,
  endSession,
  trackEvent,
} from "@/lib/runtime/telemetry";
import { createCatchGame } from "@/lib/runtime/games/catch";
import { createGuessPriceGame } from "@/lib/runtime/games/guessPrice";
import { createChainPopGame } from "@/lib/runtime/games/chainPop";
import { createChompGame } from "@/lib/runtime/games/chomp";
import { createWhackGame } from "@/lib/runtime/games/whack";
import { createSimonGame } from "@/lib/runtime/games/simon";
import { createSliceGame } from "@/lib/runtime/games/slice";


/** "catch", "guess_price", "chain_pop", "chomp", "whack", "simon", and
 * "slice" are implemented. "match" / "stack" are reserved TemplateId
 * values with no capability JSON and no runtime module yet — mount()
 * degrades to a friendly message. */
import { createShooterGame } from "@/lib/runtime/games/shooter";
import { createSweetSpotGame } from "@/lib/runtime/games/sweetSpot";
import { createRunnerGame } from "@/lib/runtime/games/runner";
import { createPourGame } from "@/lib/runtime/games/pour";

type GameModuleFactory = () => GameModule;

/** "catch", "guess_price", "chain_pop", "shooter" and "sweet_spot" are
 * implemented. "match" / "stack" are reserved TemplateId values with no
 * capability JSON and no runtime module yet — mount() degrades to a
 * friendly message. */
const REGISTRY: Partial<Record<TemplateId, GameModuleFactory>> = {
  catch: createCatchGame,
  guess_price: createGuessPriceGame,
  chain_pop: createChainPopGame,
  chomp: createChompGame,
  whack: createWhackGame,
  simon: createSimonGame,
  slice: createSliceGame,
  shooter: createShooterGame,
  sweet_spot: createSweetSpotGame,
  runner: createRunnerGame,
  pour: createPourGame,
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
  /**
   * A merchant-chosen size for this specific embed, layered on top of the
   * template's own capability constraints (see stage.ts's StageSizeOverride
   * doc comment — it can cap width and set a literal height, but never
   * shrink below what the template declares as its own usable minimum).
   * Threaded in from app/play/[slug]/page.tsx's ?width=/?height=, which in
   * turn come from the embed snippet's data-width/data-height (see
   * lib/engine/embedSnippet.ts). Omitted everywhere else — the editor's own
   * preview, fixtures, and any caller with no merchant sizing choice to
   * honor.
   */
  sizeOverride?: StageSizeOverride;
  /**
   * A brand skin for the game world, merged over the theme the template
   * derives from `spec.brand` (see lib/runtime/games/runnerTheme.ts). It is
   * a deep-partial: a host embedding the game can pass
   * `{ character: { shoes: "#fff" }, advertising: { slogans: [...] } }` and
   * everything it doesn't mention stays derived. Omitted everywhere in this
   * app — the merchant's own BrandKit is already the theme — and it exists
   * so a host embedding the runtime can skin it without a code change.
   * Only the `runner` template reads it today; other templates ignore it.
   */
  brandTheme?: RunnerThemeOverride;
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

  return mountGame(
    spec,
    container,
    placement,
    slug,
    capability,
    factory,
    options.autoStart ?? false,
    options.sizeOverride,
    options.brandTheme,
  );
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
  sizeOverride: StageSizeOverride | undefined,
  brandTheme: RunnerThemeOverride | undefined,
): MountHandle {
  const brand = spec.brand;
  const copy = spec.copy;

  ensureGoogleFontLoaded(brand.fontFamily);

  // --- DOM scaffold -------------------------------------------------------
  const shell = document.createElement("div");
  shell.style.position = "relative";
  shell.style.width = "100%";
  shell.style.overflow = "hidden";
  shell.style.isolation = "isolate";
  shell.style.fontFamily = brand.fontFamily || "system-ui, sans-serif";
  shell.style.background = "transparent";
  shell.style.userSelect = "none";
  shell.style.touchAction = "none"; // dragging the basket/slider shouldn't scroll the host page

  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.zIndex = "0";
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
  overlay.style.zIndex = "1";
  const overlayBackdrop = opaqueOverlayBackdrop(brand.background);
  overlay.style.background = overlayBackdrop;

  // Created before the mute button that reads it, but deliberately silent
  // until startPlay()'s gesture unlocks it — see the autoplay note at the
  // top of lib/runtime/audio.ts.
  const audio = createAudio(loadMutePreference());

  // Sibling of the canvas, never a child of it: createInput(canvas) calls
  // setPointerCapture on every pointerdown, which per the Pointer Events
  // spec retargets the resulting click to the capturing element — the same
  // reason the idle/reward chrome lives in `overlay` rather than on the
  // canvas (see CLAUDE.md). z-index 2 keeps it above the overlay so it stays
  // reachable on the idle and reward screens too, and its own pointerEvents
  // stay "auto" even while the overlay is click-through mid-game.
  const muteButton = renderMuteButton(brand, audio.isMuted(), (next) => {
    audio.setMuted(next);
    saveMutePreference(next);
  });

  shell.appendChild(canvas);
  shell.appendChild(overlay);
  shell.appendChild(muteButton);
  container.innerHTML = "";
  container.appendChild(shell);

  // --- stage sizing --------------------------------------------------------
  const constraint = capability.placements[placement];
  const stageController: StageController = mountStage(
    canvas,
    container,
    placement,
    constraint,
    () => {
      // Re-fit on every resize too, not just re-apply the stage height: a
      // narrower box can wrap the SAME reward/idle copy onto more lines,
      // needing more height than it did a moment ago (see
      // fitShellToOverlay's doc comment for why this can't just be
      // stageController.size.height).
      fitShellToOverlay(shell, overlay, stageController.size.height);
    },
    sizeOverride,
  );
  shell.style.height = `${stageController.size.height}px`;

  // Re-fits the shell whenever the CURRENTLY shown overlay content's own
  // rendered size changes after setOverlay() already ran — a coupon code
  // line toggling visible, a "no codes left" status line appearing, the
  // score count-up text changing width. Every such mutation site would
  // otherwise have to remember to re-measure itself (fragile, easy to miss
  // one now or later); observing the content element directly catches all
  // of them. Re-created per setOverlay() call since the observed element
  // changes each time; disconnected in teardown().
  let contentResizeObserver: ResizeObserver | null = null;

  function setOverlay(content: HTMLElement | null) {
    contentResizeObserver?.disconnect();
    contentResizeObserver = null;
    overlay.innerHTML = "";
    if (!content) {
      canvas.style.visibility = "visible";
      overlay.style.background = "transparent";
      overlay.style.pointerEvents = "none";
      shell.style.height = `${stageController.size.height}px`;
      return;
    }
    // Hide and clear the play canvas whenever chrome is shown. A semi-
    // transparent overlay backdrop alone is not enough — the last game
    // frame (product sprites, sweet-spot bar, etc.) composites through and
    // reads as broken overlap with the reward controls.
    canvas.style.visibility = "hidden";
    stageController.ctx.clearRect(0, 0, stageController.size.width, stageController.size.height);
    overlay.style.background = overlayBackdrop;
    overlay.style.pointerEvents = "auto";

    // A brief fade + scale-in on every screen swap (idle -> play -> reward)
    // instead of an instant innerHTML replace, so the transition itself
    // reads as a deliberate beat rather than a jump-cut. Two rAFs, not one:
    // the style change has to land in a frame the browser has already
    // painted the pre-transition (opacity 0) state for, or the transition
    // never has a starting frame to animate from.
    content.style.opacity = "0";
    content.style.transform = "scale(0.98)";
    content.style.transition = "opacity 0.22s ease, transform 0.22s ease";
    overlay.appendChild(content);
    fitShellToOverlay(shell, overlay, stageController.size.height);

    if (typeof ResizeObserver !== "undefined") {
      contentResizeObserver = new ResizeObserver(() => {
        fitShellToOverlay(shell, overlay, stageController.size.height);
      });
      contentResizeObserver.observe(content);
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        content.style.opacity = "1";
        content.style.transform = "scale(1)";
      });
    });
  }

  setOverlay(renderLoadingState());

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
  let engagedAssetIds = new Set<string>();
  let activeSessionToken: Promise<string | null> | null = null;
  /** Previous play's token — passed on replay so analytics can link sessions. */
  let lastSessionToken: string | null = null;
  let destroyed = false;

  function addScore(delta: number) {
    score = Math.max(0, Math.round(score + delta));
  }
  function getScore() {
    return score;
  }
  function recordEngagement(assetId: string) {
    // A role's declared fallback can be the brand's own logo (e.g.
    // sweet_spot.json's `prize` role) — the logo is brand identity, not a
    // product, so it must never show up as something the player "engaged
    // with." This is the single point every template funnels through, so
    // checking here covers all of them regardless of which role let the
    // logo in.
    if (isBrandLogoUrl(loaded.get(assetId)?.image?.src, brand.logoUrl)) return;
    engagedAssetIds.add(assetId);
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
    recordEngagement,
    sound: audio,
    complete,
    brandLogo: null,
    brandTheme,
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
    setOverlay(renderIdleState(brand, copy, () => startPlay(false)));
  }

  function startPlay(isReplay: boolean) {
    score = 0;
    engagedAssetIds = new Set();
    // Synchronously inside the click handler that led here: an AudioContext
    // resumed outside a gesture stays suspended on Safari, and unlocking
    // anywhere earlier would mean audio was possible before the player ever
    // asked to play.
    audio.unlock();
    audio.play("start");
    // Per-template bed (lib/runtime/music.ts). Idempotent, so a replay
    // resumes the same bed rather than layering a second sequencer.
    audio.startMusic(spec.template);
    setOverlay(null); // hide chrome; the game renders on canvas
    activeSessionToken = beginSession(slug, {
      replayOfSessionToken: isReplay ? lastSessionToken : null,
    });
    void activeSessionToken.then((token) => {
      if (token) lastSessionToken = token;
      trackEvent(isReplay ? "replay" : "start", { slug, sessionToken: token });
    });

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
    const engagedAssets = Array.from(engagedAssetIds)
      .map((id) => loaded.get(id))
      .filter((a): a is LoadedAsset => Boolean(a?.image))
      .map((a) => ({ spriteUrl: a.image!.src, name: a.data?.name, productUrl: a.data?.productUrl }));
    const resolved = resolveReward(finalScore, spec.rewards);
    // Cut the bed before the end-of-run cue rather than fading under it:
    // the reward reveal is the peak moment of the session and gameplay
    // music continuing through it makes the game feel still-running.
    audio.stopMusic();
    // Exactly one end-of-run cue. Both are ~0.5s flourishes, so playing
    // "gameOver" and then "reward" back-to-back muddies both; which one
    // fires is itself the answer to "did I earn anything?".
    audio.play(resolved.tierIndex !== -1 ? "reward" : "gameOver");
    let sessionToken: string | null = null;

    // Resolves once endSession() has returned, i.e. once the server has
    // finished the play and vetted the score. The coupon claim awaits this
    // because claiming a coupon for an unfinished play is refused (409).
    let resolveFinished = () => {};
    const finishedSignal = new Promise<void>((r) => {
      resolveFinished = r;
    });

    // Paint the reward overlay immediately — don't wait on network. The last
    // game frame (sweet-spot bar, falling products, etc.) otherwise sits on
    // the canvas under semi-transparent chrome and reads as broken overlap.
    setOverlay(
      renderRewardState(brand, copy, resolved.tier, resolved.tierIndex !== -1, finalScore, nextTierAbove(finalScore, spec.rewards), null, engagedAssets, () => {
        void submitLead(sessionToken);
      }, () => {
        startPlay(true);
      }, async () => {
        // Runs when the player presses "Copy my code", which can be before
        // endSession() below has resolved — so wait for the session rather
        // than claiming against a null token. Claiming requires the play to
        // be FINISHED server-side (see the claim route), and endSession is
        // what finishes it.
        await finishedSignal;
        const claim = await claimCoupon(sessionToken);
        if (claim.status === "ok") {
          trackEvent("reward_revealed", { slug, sessionToken, coupon: "claimed" });
        }
        return claim.code;
      }),
    );

    sessionToken = activeSessionToken ? await activeSessionToken : null;
    const server = await endSession(sessionToken, finalScore);
    resolveFinished();

    // A legacy static RewardTier.code still arrives here from finishPlay for
    // specs with no coupon pool. Seed the block with it so those games keep
    // showing a code with no extra round trip; a pooled game gets null and
    // the block claims on demand.
    if (server.code) {
      const codeLine = overlay.querySelector<HTMLElement>("[data-role='coupon-code']");
      if (codeLine) {
        codeLine.textContent = server.code;
        codeLine.style.display = "block";
      }
    }

    await animateCountUp(0, finalScore, 700, (value) => {
      const el = overlay.querySelector<HTMLElement>("[data-role='score-value']");
      if (el) el.textContent = String(value);
    });

    trackEvent("reward_revealed", {
      slug,
      sessionToken,
      score: finalScore,
      tier: resolved.tier.label,
    });
    trackEvent("complete", { slug, sessionToken, score: finalScore });
  }

  async function submitLead(sessionToken: string | null): Promise<boolean> {
    const emailField = overlay.querySelector<HTMLInputElement>("[data-role='email-input']");
    const status = overlay.querySelector<HTMLElement>("[data-role='email-status']");
    const email = emailField?.value?.trim() ?? "";
    if (!email) return false;
    const lead = await captureLead(sessionToken, email);
    const ok = lead.ok;
    // NOT "Sent — check your inbox."
    //
    // Nothing is sent. POST /api/leads only writes a row to the `leads`
    // table; there is no mail transport in this codebase at all (no
    // dependency, no SMTP config) — confirmed by grepping package.json.
    // Telling a player to check an inbox that will never receive anything is
    // worse than saying nothing, and with real coupon pools it costs them
    // their reward: they wait for an email instead of copying the code that
    // is on screen right now.
    //
    // TODO(email): once the Resend marketplace integration is installed
    // (`vercel integration add resend/resend-email` — blocked on accepting
    // its terms in the dashboard) and a sending domain is verified, send the
    // claimed coupon code here and restore a delivery-confirming message.
    if (status) {
      // Three distinct outcomes, three distinct messages. "Sent — check your
      // inbox" used to be shown for all of them, including the case where no
      // mail transport existed at all.
      status.textContent = !ok
        ? "Couldn't save that email — copy your code above instead."
        : lead.emailed
          ? "Sent — check your inbox."
          : "Got it — we've saved your email. Copy your code above to use it now.";
    }
    if (ok) trackEvent("lead_captured", { slug, sessionToken });
    return ok;
  }

  function teardown() {
    destroyed = true;
    loop?.stop();
    gameModule?.teardown();
    input.destroy();
    audio.destroy();
    stageController.destroy();
    contentResizeObserver?.disconnect();
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
    subjectBounds: asset.subjectBounds,
    colorAdjust: asset.colorAdjust,
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

/** Score to preview the reward screen at when the caller names none: exactly
 * the entry tier's threshold, so the merchant sees the reward state by
 * default. A fixed 128 used to do this only because every spec had a tier at
 * minScore 0; now that the entry bar is wherever the merchant put it, a
 * constant lands below it as often as not and previews the near-miss screen
 * to someone who opened the panel to check their coupon terms. */
function defaultPreviewScore(spec: GameSpec): number {
  return entryTier(spec.rewards)?.minScore ?? STATIC_PREVIEW_EXAMPLE_SCORE;
}

export function renderStaticScreen(
  kind: "idle" | "reward",
  spec: GameSpec,
  exampleScore: number = defaultPreviewScore(spec),
): HTMLElement {
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

  // Resolved from `exampleScore`, not from the constant. They were different
  // numbers: the editor's per-tier "preview" button sets exampleScore to that
  // tier's minScore, but the tier shown was always whatever 128 resolved to,
  // so previewing the 20%-off tier rendered the 10%-off one.
  const resolvedPreview = resolveReward(exampleScore, spec.rewards);
  const tier = resolvedPreview.tier;
  // No live session to draw a real engagement list from here — a
  // representative sample of the spec's own assets stands in, same spirit
  // as STATIC_PREVIEW_EXAMPLE_SCORE faking a score for this same preview.
  // `spec.assets` is every processed asset the pipeline kept, which
  // includes the brand's own logo whenever one was found (compose.ts sets
  // `brand.logoUrl` from an asset that's still just a regular entry in this
  // array) — excluded here the same way mount.ts's real recordEngagement()
  // excludes it live, so this preview never shows the logo as a "product."
  const engagedSample = spec.assets
    .filter((a) => !isBrandLogoUrl(a.spriteUrl, brand.logoUrl))
    .slice(0, 4)
    .map((a) => ({ spriteUrl: a.spriteUrl, name: a.data?.name, productUrl: a.data?.productUrl }));
  // Same earned/near-miss logic as the live screen rather than a forced "won"
  // state, so a merchant who previews a score below their entry bar sees
  // exactly what that player will see.
  const content = renderRewardState(
    brand,
    copy,
    tier,
    resolvedPreview.tierIndex !== -1,
    exampleScore,
    nextTierAbove(exampleScore, spec.rewards),
    null,
    engagedSample,
    () => {},
    () => {},
  );
  const scoreEl = content.querySelector<HTMLElement>("[data-role='score-value']");
  if (scoreEl) scoreEl.textContent = String(exampleScore);
  const emailField = content.querySelector<HTMLInputElement>("[data-role='email-input']");
  if (emailField) emailField.disabled = true;
  // The "Get my code"/"Play again" buttons are wired to no-ops here (there's
  // no live session for either to act on) — `disabled` takes them out of the
  // tab order and marks them correctly for assistive tech, same job the
  // container's `inert` used to do wholesale. Doing it per-element instead
  // means the gallery's product links (real, meaningful, not no-ops) can be
  // left alone: app/(app)/games/[id]/page.tsx no longer applies `inert` to
  // this specific preview, precisely so those links stay clickable.
  for (const button of content.querySelectorAll<HTMLButtonElement>("button")) {
    button.disabled = true;
  }
  shell.appendChild(content);
  return shell;
}

function opaqueOverlayBackdrop(background: string): string {
  if (/^#[0-9a-f]{6}$/i.test(background)) return background;
  if (/^#[0-9a-f]{8}$/i.test(background)) return background.slice(0, 7);
  return "#ffffff";
}

/**
 * Overlay chrome (idle/reward) is sized for whatever it actually contains,
 * never for the stage's gameplay aspect ratio — a reward tier plus coupon
 * terms plus an engaged-products gallery plus an email form routinely needs
 * more height than a template's `preferredAspect`-derived box, and the
 * shell's own `overflow: hidden` (there so gameplay never visibly spills
 * past its box) was silently clipping that content instead of ever growing
 * to fit it.
 *
 * Measured off the CONTENT element itself (`overlay`'s one child), not off
 * `overlay` — confirmed live that `overlay.scrollHeight` under-reports an
 * overflowing child here: `overlay` is `justify-content: center` (mountGame's
 * DOM scaffold), and centered ("safe"-aligned) flex overflow doesn't
 * reliably become part of a container's own scrollable overflow the way
 * start-aligned overflow does — the trailing end of a tall reward screen
 * (the replay button, past a full coupon block + gallery) was still
 * clipped even once this function existed, because it was sizing to a
 * number smaller than the content actually needed. `content` is an
 * ordinary block box with no centering of its own, so its scrollHeight is
 * an unambiguous measurement of what it actually needs. `overlay`'s own
 * padding (set once in mountGame) isn't part of that box, so it's added
 * back in from the live computed style rather than duplicated as a
 * hardcoded number that could silently drift out of sync with it.
 *
 * Only ever GROWS the shell past the stage's own height, never shrinks
 * below it — gameplay's canvas box is untouched.
 */
function fitShellToOverlay(shell: HTMLElement, overlay: HTMLElement, stageHeight: number): void {
  const content = overlay.firstElementChild as HTMLElement | null;
  if (!content) {
    shell.style.height = `${stageHeight}px`;
    return;
  }
  const overlayStyle = getComputedStyle(overlay);
  const verticalPadding =
    parseFloat(overlayStyle.paddingTop || "0") + parseFloat(overlayStyle.paddingBottom || "0");
  shell.style.height = `${Math.max(stageHeight, content.scrollHeight + verticalPadding)}px`;
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

/** The brand's own logomark, centred — shared between the idle screen
 * (which already showed it) and the reward screen (which didn't show any
 * branding at all before). Returns null when there's no logo to show,
 * matching the "skip silently" convention used elsewhere for missing
 * per-asset data. */
function renderBrandLogo(logoUrl: string | undefined, height: string = "32px"): HTMLImageElement | null {
  if (!logoUrl) return null;

  const logo = document.createElement("img");
  logo.src = logoUrl;
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
  logo.style.height = height;
  logo.style.width = "auto";
  logo.style.marginTop = "0";
  logo.style.marginBottom = "8px";
  logo.style.marginLeft = "auto";
  logo.style.marginRight = "auto";
  logo.style.objectFit = "contain";
  return logo;
}

/** Small persistent speaker toggle. Deliberately NOT part of the overlay
 * chrome: the overlay is emptied and set to pointer-events:none during play
 * (setOverlay(null)), and muting is exactly the thing a player wants to do
 * mid-game. Returns the button; the caller owns placement. */
function renderMuteButton(
  brand: GameSpec["brand"],
  initialMuted: boolean,
  onChange: (muted: boolean) => void,
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.style.position = "absolute";
  button.style.top = "8px";
  button.style.right = "8px";
  button.style.zIndex = "2";
  button.style.width = "28px";
  button.style.height = "28px";
  button.style.display = "flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.padding = "0";
  button.style.border = "none";
  button.style.borderRadius = "999px";
  button.style.cursor = "pointer";
  button.style.lineHeight = "1";
  button.style.fontSize = "14px";
  // Brand-tinted rather than a fixed grey: this sits over whatever the game
  // is drawing, which is per-brand. Low alpha so it reads as chrome.
  // 8-digit hex alpha, the same trick opaqueOverlayBackdrop uses. `14` is
  // 0x14/255 ~= 8%. Falls back to a bare colour if the brand hex is an
  // unexpected shape, which keeps a malformed BrandKit from producing an
  // invisible control.
  button.style.background = /^#[0-9a-f]{6}$/i.test(brand.foreground)
    ? `${brand.foreground}14`
    : "rgba(0,0,0,0.08)";
  button.style.color = brand.foreground;
  button.style.opacity = "0.75";

  let muted = initialMuted;
  const paint = () => {
    // Text glyphs, not an SVG or an icon font: this runs inside a
    // third-party page and must not depend on anything being loadable.
    button.textContent = muted ? "\u{1F507}" : "\u{1F509}";
    button.setAttribute("aria-pressed", muted ? "true" : "false");
    button.setAttribute("aria-label", muted ? "Unmute game sound" : "Mute game sound");
    button.title = muted ? "Unmute" : "Mute";
  };
  paint();

  button.addEventListener("click", (e) => {
    // The canvas is a sibling underneath; without this the click also reads
    // as a tap on the playfield and would, say, fire a shot in shooter.
    e.stopPropagation();
    muted = !muted;
    paint();
    onChange(muted);
  });
  // Same reason — pointerdown is what the game's input layer listens to.
  button.addEventListener("pointerdown", (e) => e.stopPropagation());

  return button;
}

function renderIdleState(brand: GameSpec["brand"], copy: GameSpec["copy"], onStart: () => void): HTMLElement {
  const wrap = document.createElement("div");

  // Scales with both the embed's width and height (same clamp+vw technique
  // as the headline below), not a fixed px, so it reads clearly on a large
  // placement without overflowing a short/narrow one.
  const logo = renderBrandLogo(brand.logoUrl, "clamp(40px, min(10vw, 18vh), 96px)");
  if (logo) wrap.appendChild(logo);

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

/** One product the player engaged with this round — plain data (a URL
 * string, not a live LoadedAsset/HTMLImageElement) so the exact same
 * gallery renderer works both from a real session (mount.ts's own
 * engagedAssetIds, mapped through `loaded`) and from renderStaticScreen's
 * editor preview, which only ever has ProcessedAsset.spriteUrl strings and
 * no live session to draw a real list from. */
interface EngagedAsset {
  spriteUrl: string;
  name?: string;
  /** The product's own storefront page — see RawAsset.data's doc comment
   * in lib/engine/types.ts. Absent whenever extraction found none (manual
   * mode included); the card renders identically either way, just without
   * a link. */
  productUrl?: string;
}

const ENGAGED_GALLERY_MAX = 6;
const ENGAGED_THUMB_SIZE = 64; // px — the card itself is a bit wider (padding + border)

/** A horizontally-scrollable row of cards for the products the player
 * actually engaged with this round — the highest-attention moment of the
 * whole session (the reward screen) previously showed zero product
 * imagery, and briefly showed it as bare thumbnails with a hover-only
 * name. Each card links to the product's real page when one was captured
 * during extraction. Returns null (render nothing) when `engaged` is
 * empty, matching the "skip silently" convention already used elsewhere
 * for missing per-asset data — an empty gallery block would read as a bug,
 * not a deliberate absence. */
function renderEngagedGallery(engaged: EngagedAsset[], brand: GameSpec["brand"]): HTMLElement | null {
  if (engaged.length === 0) return null;

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "10px";
  row.style.margin = "4px 0";
  row.style.padding = "2px"; // room for each card's own box-shadow, so it isn't clipped
  row.style.overflowX = "auto";
  row.style.maxWidth = "100%";
  row.style.justifyContent = engaged.length > 3 ? "flex-start" : "center";
  row.style.alignItems = "stretch";
  // Snap-scrolling reads as a deliberate swipeable card rail rather than an
  // overflow accident — this widget is typically mounted at mobile width,
  // where that gesture is the natural one.
  row.style.scrollSnapType = "x mandatory";

  for (const asset of engaged.slice(0, ENGAGED_GALLERY_MAX)) {
    // The whole card is the link target (image + name together) when a
    // product page was captured — plain <div> otherwise, same visual
    // either way, just not clickable. See RawAsset.data.productUrl's doc
    // comment for why this can legitimately be absent (manual mode, a
    // DOM-ladder-only site that found no wrapping <a>, etc.).
    const item = document.createElement(asset.productUrl ? "a" : "div") as HTMLAnchorElement | HTMLDivElement;
    if (asset.productUrl && item instanceof HTMLAnchorElement) {
      item.href = asset.productUrl;
      // _blank, not the current frame: this renders inside app/embed.js's
      // third-party-page iframe — navigating the current frame away would
      // break out of the host page the widget is embedded in.
      item.target = "_blank";
      item.rel = "noopener noreferrer";
      item.style.textDecoration = "none";
      item.style.cursor = "pointer";
    }
    item.style.display = "flex";
    item.style.flexDirection = "column";
    item.style.alignItems = "center";
    item.style.gap = "4px";
    item.style.flex = "0 0 auto";
    item.style.width = `${ENGAGED_THUMB_SIZE + 16}px`;
    item.style.boxSizing = "border-box";
    item.style.padding = "8px";
    item.style.borderRadius = "12px";
    item.style.border = `1px solid ${brand.foreground}1a`;
    item.style.background = `${brand.foreground}0a`;
    item.style.boxShadow = "0 2px 10px -2px rgba(0,0,0,0.14)";
    item.style.color = "inherit";
    item.style.scrollSnapAlign = "start";
    item.style.transition = "transform 0.15s ease, box-shadow 0.15s ease";

    if (asset.productUrl) {
      item.addEventListener("pointerenter", () => {
        item.style.transform = "translateY(-2px)";
        item.style.boxShadow = "0 6px 16px -4px rgba(0,0,0,0.2)";
      });
      item.addEventListener("pointerleave", () => {
        item.style.transform = "none";
        item.style.boxShadow = "0 2px 10px -2px rgba(0,0,0,0.14)";
      });
    }

    const thumb = document.createElement("img");
    thumb.src = asset.spriteUrl;
    thumb.alt = asset.name ?? "";
    thumb.style.width = `${ENGAGED_THUMB_SIZE}px`;
    thumb.style.height = `${ENGAGED_THUMB_SIZE}px`;
    thumb.style.objectFit = "contain";
    thumb.style.borderRadius = "8px";
    thumb.style.background = `${brand.foreground}11`;
    item.appendChild(thumb);

    // The name is the point (it needs to actually be readable, not hidden
    // behind a hover-only `title`) — skipped entirely, not shown as a
    // blank line, when there's no real name to show, matching the "skip
    // silently" convention used elsewhere for missing per-asset data.
    if (asset.name) {
      const caption = document.createElement("span");
      caption.textContent = asset.name;
      caption.title = asset.name;
      caption.style.fontSize = "11px";
      caption.style.lineHeight = "1.25";
      caption.style.textAlign = "center";
      caption.style.color = brand.foreground;
      caption.style.opacity = "0.85";
      caption.style.width = "100%";
      caption.style.display = "-webkit-box";
      caption.style.setProperty("-webkit-line-clamp", "2");
      caption.style.setProperty("-webkit-box-orient", "vertical");
      caption.style.overflow = "hidden";
      caption.style.wordBreak = "break-word";
      item.appendChild(caption);
    }

    row.appendChild(item);
  }

  return row;
}

/**
 * The coupon panel on the reward screen: a Copy button that claims a code,
 * plus the terms the merchant attached to this tier.
 *
 * The code is NOT fetched when this renders. It is claimed on the first
 * press, because claiming consumes one from a finite pool — rendering it
 * eagerly would spend a coupon on every player who reached the end screen
 * and then closed the tab.
 *
 * Raw hex/px styling rather than the app's design tokens is correct here:
 * this subtree is injected into a third-party storefront's DOM, where none
 * of our CSS exists and the only palette available is the brand's own (see
 * the note on mount.ts in CLAUDE.md's design-system section).
 */
function renderCouponBlock(
  brand: GameSpec["brand"],
  tier: GameSpec["rewards"][number],
  serverCode: string | null,
  onClaimCoupon: () => Promise<string | null>,
): HTMLElement {
  const box = document.createElement("div");
  box.dataset.role = "coupon-block";
  box.style.marginTop = "8px";
  box.style.padding = "10px";
  box.style.borderRadius = "12px";
  box.style.border = `1px solid ${brand.accent}30`;
  box.style.background = `linear-gradient(180deg, ${brand.accent}14, ${brand.accent}08)`;
  box.style.boxShadow = `0 4px 14px -6px ${brand.accent}55`;
  box.style.textAlign = "center";

  const codeLine = document.createElement("div");
  codeLine.dataset.role = "coupon-code";
  codeLine.style.fontFamily =
    "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  codeLine.style.fontSize = "18px";
  codeLine.style.fontWeight = "700";
  codeLine.style.letterSpacing = "0.08em";
  codeLine.style.wordBreak = "break-all";
  codeLine.style.color = brand.foreground;
  // Hidden until claimed — an empty monospace line would reserve space and
  // look like a rendering bug.
  codeLine.style.display = serverCode ? "block" : "none";
  codeLine.textContent = serverCode ?? "";
  box.appendChild(codeLine);

  // Without this the block is a lone button over an empty space, giving the
  // player no reason to believe it is where their reward lives.
  const prompt = document.createElement("p");
  prompt.dataset.role = "coupon-prompt";
  prompt.textContent = tier.percentOff != null
    ? `Your ${tier.percentOff}% off code`
    : "Your code";
  prompt.style.margin = "0 0 6px";
  prompt.style.fontSize = "12px";
  prompt.style.fontWeight = "600";
  prompt.style.letterSpacing = "0.04em";
  prompt.style.textTransform = "uppercase";
  prompt.style.opacity = "0.7";
  prompt.style.color = brand.foreground;
  prompt.style.display = serverCode ? "none" : "block";
  box.insertBefore(prompt, codeLine);

  const status = document.createElement("p");
  status.dataset.role = "coupon-status";
  status.style.margin = "4px 0 0";
  status.style.fontSize = "12px";
  status.style.opacity = "0.75";
  status.style.minHeight = "1.2em";
  status.style.color = brand.foreground;

  const button = makeButton("Copy my code", brand.accent, brand.background);
  button.dataset.role = "coupon-copy";
  button.style.padding = "8px 14px";
  button.style.marginTop = codeLine.style.display === "block" ? "8px" : "0";

  let claimed: string | null = serverCode;
  let busy = false;

  async function writeToClipboard(text: string): Promise<boolean> {
    try {
      // Only available on a secure origin, and rejects outright if the
      // document isn't focused — both realistic inside an iframe on someone
      // else's site.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fall through to the legacy path
    }
    try {
      // execCommand("copy") is deprecated but still the only fallback that
      // works in an iframe without clipboard permission. The textarea must
      // be in the document and selectable, hence the off-screen placement
      // rather than display:none (which cannot be selected).
      const scratch = document.createElement("textarea");
      scratch.value = text;
      scratch.setAttribute("readonly", "");
      scratch.style.position = "fixed";
      scratch.style.top = "-1000px";
      scratch.style.opacity = "0";
      document.body.appendChild(scratch);
      scratch.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(scratch);
      return ok;
    } catch {
      return false;
    }
  }

  button.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;

    try {
      if (!claimed) {
        status.textContent = "Getting your code…";
        claimed = await onClaimCoupon();
      }

      if (!claimed) {
        // Deliberately not "error": from the player's side an empty pool and
        // an expired offer are the same experience, and the honest framing is
        // that there is nothing to hand over right now.
        status.textContent = "No codes left right now — check back soon.";
        prompt.style.display = "none";
        button.style.display = "none";
        return;
      }

      codeLine.textContent = claimed;
      codeLine.style.display = "block";
      prompt.style.display = "none";
      button.style.marginTop = "8px";

      const copied = await writeToClipboard(claimed);
      status.textContent = copied
        ? "Copied to your clipboard."
        : "Select the code above to copy it.";
      button.textContent = "Copy again";
    } finally {
      busy = false;
      button.disabled = false;
    }
  });

  box.appendChild(button);
  box.appendChild(status);

  const coupon = tier.coupon;
  if (coupon?.offerUrl) {
    const link = document.createElement("a");
    link.href = coupon.offerUrl;
    link.textContent = "View offer";
    link.target = "_blank";
    // noopener/noreferrer on a link we render into someone else's page: the
    // destination must not get a handle on the opener window.
    link.rel = "noopener noreferrer";
    link.style.display = "inline-block";
    link.style.marginTop = "6px";
    link.style.fontSize = "12px";
    link.style.fontWeight = "600";
    link.style.color = brand.accent;
    box.appendChild(link);
  }

  if (coupon?.expiresAt) {
    const expiry = document.createElement("p");
    expiry.style.margin = "6px 0 0";
    expiry.style.fontSize = "11px";
    expiry.style.opacity = "0.7";
    expiry.style.color = brand.foreground;
    expiry.textContent = `Valid until ${formatExpiry(coupon.expiresAt)}`;
    box.appendChild(expiry);
  }

  if (coupon?.terms) {
    const terms = document.createElement("p");
    terms.dataset.role = "coupon-terms";
    terms.style.margin = "6px 0 0";
    terms.style.fontSize = "11px";
    terms.style.lineHeight = "1.4";
    terms.style.opacity = "0.65";
    terms.style.color = brand.foreground;
    // textContent, never innerHTML: this string is merchant-supplied and is
    // rendered inside a third-party page.
    terms.textContent = coupon.terms;
    box.appendChild(terms);
  }

  return box;
}

/**
 * "2026-09-30" -> "30 Sep 2026", falling back to the raw string.
 *
 * Parsed as UTC (the trailing Z) so the displayed date matches the date the
 * merchant typed regardless of the player's timezone — without it, a player
 * west of UTC sees the day before.
 */
function formatExpiry(iso: string): string {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(ms)) return iso;
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(ms));
  } catch {
    return iso;
  }
}

/**
 * Shown instead of a coupon block when the score cleared no tier.
 *
 * Reward tiers no longer start at 0 (REWARD_MIN_SCORE_FLOOR in
 * lib/engine/specRules.ts), so falling short is an ordinary outcome rather
 * than an edge case, and the screen has to give the player somewhere to go.
 * It states the gap as a number and names what closes it, because "you didn't
 * win" is a stop sign and "40 points from 10% off" is a target.
 *
 * `nextTier` is null only when the spec declares no tiers at all (a
 * thanks-for-playing game). There is nothing to aim at then, so the copy
 * stays warm and generic rather than inventing a threshold.
 */
function renderNearMissBlock(
  brand: GameSpec["brand"],
  finalScore: number,
  nextTier: RewardTier | null,
): HTMLElement {
  const box = document.createElement("div");
  box.dataset.role = "near-miss";
  box.style.width = "100%";
  box.style.margin = "4px 0 2px";
  box.style.padding = "12px";
  box.style.boxSizing = "border-box";
  box.style.borderRadius = "12px";
  box.style.border = `1px solid ${brand.foreground}22`;
  box.style.background = `${brand.foreground}0d`;

  const line = document.createElement("p");
  line.dataset.role = "near-miss-line";
  line.style.margin = "0";
  line.style.fontSize = "14px";
  line.style.fontWeight = "600";
  line.style.lineHeight = "1.35";

  if (!nextTier) {
    line.textContent = "Thanks for playing — go again and beat your score.";
    box.appendChild(line);
    return box;
  }

  // Never below 1: this block only renders when the score missed every tier,
  // so the gap is real, but Math.max keeps a rounding slip from printing
  // "0 more points to go".
  const gap = Math.max(1, nextTier.minScore - finalScore);
  line.textContent = `${gap} more ${gap === 1 ? "point" : "points"} and ${nextTier.label} is yours.`;
  box.appendChild(line);

  const sub = document.createElement("p");
  sub.style.margin = "4px 0 0";
  sub.style.fontSize = "12px";
  sub.style.opacity = "0.75";
  sub.textContent = `You scored ${finalScore}. ${nextTier.minScore} unlocks it — one more run should do it.`;
  box.appendChild(sub);

  // How close they got, as a bar. A number alone under-sells a near miss;
  // seeing the bar almost full is what makes the replay feel worth it.
  const track = document.createElement("div");
  track.style.marginTop = "10px";
  track.style.height = "6px";
  track.style.borderRadius = "999px";
  track.style.overflow = "hidden";
  track.style.background = `${brand.foreground}22`;

  const fill = document.createElement("div");
  fill.dataset.role = "near-miss-progress";
  fill.style.height = "100%";
  fill.style.borderRadius = "999px";
  fill.style.background = brand.accent;
  // Floor of 6% so a zero or near-zero score still shows a sliver of bar
  // rather than an empty track that reads as a rendering bug. Guard the
  // divide: minScore is validated above 0, but this runs against whatever
  // spec the embed was handed.
  const ratio = nextTier.minScore > 0 ? finalScore / nextTier.minScore : 0;
  fill.style.width = `${Math.min(100, Math.max(6, Math.round(ratio * 100)))}%`;
  track.appendChild(fill);
  box.appendChild(track);

  return box;
}

function renderRewardState(
  brand: GameSpec["brand"],
  copy: GameSpec["copy"],
  tier: GameSpec["rewards"][number],
  /** False when the score cleared no tier's minScore — `tier` is then
   * reward.ts's NO_REWARD_FALLBACK, not something the player won. */
  earned: boolean,
  /** The score just played, for the shortfall line. */
  finalScore: number,
  /** Cheapest tier still out of reach, or null when there is none. */
  nextTier: RewardTier | null,
  serverCode: string | null,
  engaged: EngagedAsset[],
  onSubmitEmail: () => void,
  onReplay: () => void,
  /**
   * Claims one coupon and resolves with the code, or null when there is none
   * to give (pool exhausted, offer expired, network failure). Called only
   * when the player actually presses the button.
   */
  onClaimCoupon: () => Promise<string | null> = async () => null,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.width = "100%";
  wrap.style.maxWidth = "360px";

  const logo = renderBrandLogo(brand.logoUrl);
  if (logo) wrap.appendChild(logo);

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
  tierLine.dataset.role = "tier-line";
  // The code no longer lives on this line. It is claimed on demand by the
  // coupon block below, because a code shown here would have to be consumed
  // from the pool before the player had asked for it.
  //
  // When nothing was earned, `tier` is NO_REWARD_FALLBACK and its label
  // ("Thanks for playing") closes the screen down — it reads like the end of
  // the interaction at the exact moment the player still has a reason to
  // continue. The near-miss block below supplies the heading instead.
  tierLine.textContent = earned ? tier.label : "So close!";
  tierLine.style.margin = "0 0 4px";
  tierLine.style.fontSize = "16px";
  tierLine.style.fontWeight = "600";
  tierLine.style.color = brand.accent;
  wrap.appendChild(tierLine);

  // Only a tier the player actually cleared gets a coupon block. `earned` is
  // load-bearing beyond the percentOff check: the fallback tier carries
  // percentOff: null today, but reading the flag means a future fallback
  // can't start handing out a claim button by accident.
  if (earned && tier.percentOff != null) {
    wrap.appendChild(renderCouponBlock(brand, tier, serverCode, onClaimCoupon));
  }

  if (!earned) {
    wrap.appendChild(renderNearMissBlock(brand, finalScore, nextTier));
  }

  const gallery = renderEngagedGallery(engaged, brand);
  if (gallery) wrap.appendChild(gallery);

  // Lead capture only when there is a code to capture a lead *for*. The
  // button says "Email it to me"; with no reward, "it" is nothing, and a
  // player who types their address gets a confirmation for a message that
  // could never contain anything. The near-miss screen keeps a single
  // obvious action — play again — and asks for the email on the run that
  // actually wins something.
  const emailRow = document.createElement("div");
  emailRow.style.display = earned ? "flex" : "none";
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

  // "Email it to me", NOT "Get my code".
  //
  // This button only captures a lead. Once the coupon block above it existed,
  // "Get my code" sat directly beneath a "Copy my code" button and read as
  // the way to obtain the code — so players pressed it, got an email capture,
  // and reported that finishing the game granted no reward. Two buttons on
  // one screen must not both look like the way to get the thing.
  //
  // Still a fixed string rather than a GameCopy field: copy.emailPrompt is
  // the input's placeholder, and a natural placeholder makes a button wider
  // than the card. Adding a field to the shared contract for a button label
  // is not worth it.
  // Secondary: the coupon block is the primary action, and two solid accent
  // buttons stacked read as equal choices. Built as a transparent button
  // directly (not a solid one overridden after the fact) — makeButton's
  // hover/press states and shadow are computed from the background it's
  // given, so building solid and then papering over it with a transparent
  // background left a stale accent-coloured shadow behind an otherwise
  // outline-style button.
  const emailButton = makeButton("Email it to me", "transparent", brand.foreground);
  emailButton.style.padding = "8px 14px";
  emailButton.style.border = `1px solid ${brand.foreground}55`;
  emailButton.style.fontWeight = "600";
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

  // Solid accent when nothing was earned, outline when something was.
  //
  // The hierarchy follows what the player still has to do. With a coupon on
  // screen, claiming it is the primary action and replaying is the quiet
  // alternative. With no coupon, replaying IS the only way to get one, and
  // leaving it as the same faint outline button it has always been buried
  // the one thing this screen is asking for.
  const replayButton = earned
    ? makeButton(copy.ctaReplay, "transparent", brand.foreground)
    : makeButton(copy.ctaReplay, brand.accent, brand.background);
  replayButton.style.marginTop = earned ? "10px" : "4px";
  if (earned) {
    replayButton.style.border = `1px solid ${brand.foreground}55`;
    replayButton.style.color = brand.foreground;
  }
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
  button.style.transition = "transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease";

  const isTransparent = background === "transparent";
  button.style.background = isTransparent
    ? "transparent"
    : `linear-gradient(180deg, ${shadeHex(background, 0.08)}, ${shadeHex(background, -0.06)})`;
  button.style.color = isTransparent ? foregroundOnAccent : bestTextColor(background);
  // A solid pill sitting flat on the page reads as inert; a coloured,
  // slightly-elevated shadow plus a press/hover response makes it read as
  // the one interactive thing on the idle/reward screen. Skipped for the
  // transparent "secondary" button (replay) — it deliberately stays flat
  // so it doesn't visually compete with the primary action beside it.
  button.style.boxShadow = isTransparent ? "none" : `0 6px 16px -4px ${background}80`;

  if (!isTransparent) {
    button.addEventListener("pointerenter", () => {
      button.style.transform = "translateY(-1px)";
      button.style.filter = "brightness(1.04)";
    });
    button.addEventListener("pointerleave", () => {
      button.style.transform = "none";
      button.style.filter = "none";
    });
    button.addEventListener("pointerdown", () => {
      button.style.transform = "translateY(0) scale(0.97)";
      button.style.boxShadow = `0 2px 8px -2px ${background}80`;
    });
    const release = () => {
      button.style.transform = "translateY(-1px)";
      button.style.boxShadow = `0 6px 16px -4px ${background}80`;
    };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
  }

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
