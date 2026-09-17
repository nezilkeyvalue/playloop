// app/(app)/games/[id]/page.tsx
//
// Preview + the capped editor (spec §15: four properties, no more — swap
// or remove an image, accent colour, copy, reward thresholds). Renders the
// REAL runtime by dynamically importing lib/runtime/mount and mounting it
// directly against the fetched GameSpec, so this page has zero coupling to
// the other track's /play/:slug route (which an unpublished draft doesn't
// have a slug for anyway).
"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AuthGate } from "@/components/AuthGate";
import { CouponManager } from "@/components/CouponManager";
import {
  findIncompleteRoles,
  getCapability,
  playableAssetsForRole,
  roleAssetIds,
  roleIsSatisfied,
  trackedRoles,
} from "@/lib/capabilities";
import {
  resolveMaxRealisticScoreForSpec,
  staticMaxRealisticScore,
} from "@/lib/engine/scoreCeiling";
import {
  COPY_RULES,
  PERCENT_OFF_MAX,
  PERCENT_OFF_MIN,
  REWARD_CODE_MAX,
  REWARD_LABEL_MAX,
  hasBaselineTier,
  normalizeRewardTier,
  suggestNextMinScore,
  validateCopyField,
  validateRewardTier,
  type RewardTierDraft,
  type RewardTierField,
  type RewardTierIssue,
} from "@/lib/engine/specRules";
import {
  CheckIcon,
  ChevronIcon,
  ControllerIcon,
  FlagIcon,
  GiftIcon,
  ImageIcon,
  LayersIcon,
  PaletteIcon,
  TextIcon,
  TrophyIcon,
} from "@/components/EditorIcons";
import type {
  CapabilityRole,
  GameCapability,
  GameCopy,
  GameRecord,
  GameSpec,
  ProcessedAsset,
  RewardTier,
} from "@/lib/engine/types";

type Device = "desktop" | "mobile";

/**
 * The editor is organized by which moment in the play flow a change
 * affects, not by field type — a merchant thinks "the start screen" or "the
 * end screen", not "copy" vs. "branding". "whole" holds the one thing that
 * genuinely applies everywhere (branding) rather than forcing it into one
 * of the three actual screens the runtime shows (mount.ts: idle → play →
 * reward).
 */
type Screen = "whole" | "start" | "game" | "end";

const SCREENS: { id: Screen; label: string; hint: string; icon: ReactNode }[] = [
  { id: "whole", label: "Whole game", hint: "Branding", icon: <LayersIcon className="h-4 w-4" /> },
  { id: "start", label: "Start screen", hint: "Headline & CTA", icon: <FlagIcon className="h-4 w-4" /> },
  { id: "game", label: "Game screen", hint: "Images in play", icon: <ControllerIcon className="h-4 w-4" /> },
  { id: "end", label: "End summary", hint: "Rewards & replay", icon: <TrophyIcon className="h-4 w-4" /> },
];

// Curated rather than free-text — mount.ts only ever actually loads whatever
// name is here (see ensureGoogleFontLoaded in lib/runtime/mount.ts), so an
// arbitrary typed name would just silently fall back to the default sans.
// A handful of names spanning clean/geometric/serif/display covers most
// brand voices without turning this into an open-ended text field.
const FONT_OPTIONS = [
  "Inter",
  "Poppins",
  "Montserrat",
  "DM Sans",
  "Space Grotesk",
  "Playfair Display",
  "Fraunces",
  "Bebas Neue",
];

/** A patch is described as a function of the CURRENT spec rather than as a
 * finished object, so it can be (re)built at send time — and rebuilt again on
 * a retry — against whatever has landed since the merchant edited the field. */
type PatchBuilder = (current: GameSpec) => Partial<GameSpec>;

interface SaveFailure {
  id: number;
  /** The merchant-facing field name, also the dedupe key: re-editing one
   * field replaces its outstanding failure instead of stacking another. */
  label: string;
  build: PatchBuilder;
  message: string;
}

/** Turns a non-OK PATCH into one sentence a merchant can act on. The route's
 * 400s carry a merchant-facing `message` from validateSpecPatch, so those are
 * rendered verbatim rather than flattened into a generic failure. */
async function describeSaveFailure(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as
    | { error?: string; message?: string }
    | null;
  if (res.status === 404 || body?.error === "not_found") {
    return "This game no longer exists — reload the page.";
  }
  if (res.status === 400) return body?.message ?? "That change was rejected.";
  return "The server couldn't save this change.";
}

/** The score the static End-summary mock renders at — mirrors mount.ts's own
 * STATIC_PREVIEW_EXAMPLE_SCORE default. A reward row can retarget it so a
 * tier above the default can actually be seen. */
const DEFAULT_PREVIEW_SCORE = 128;

/** "collectible" -> "collectible", "priceTag" -> "price Tag". Hoisted out of
 * the role headings so counters, control names and save-failure labels all
 * refer to a role the same way. */
function humanRoleLabel(roleId: string): string {
  return roleId.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Merchant-facing name, granularity and units for each key a capability's
 * `tuning` block can declare. A raw JSON key ("hazardRatio", "spawnRateHz")
 * is a runtime identifier, not a setting a shop owner can reason about, and
 * the step is per-key because these are wildly different scales — 0.05 of a
 * ratio and 10px/s of fall speed are both "one notch". */
const TUNING_FIELDS: Record<
  string,
  { label: string; step: number; format: (value: number) => string }
> = {
  durationSec: { label: "Round length", step: 1, format: (v) => `${Math.round(v)}s` },
  spawnRateHz: { label: "Items per second", step: 0.1, format: (v) => v.toFixed(1) },
  fallSpeed: { label: "Item speed", step: 10, format: (v) => String(Math.round(v)) },
  hazardRatio: { label: "Share of hazards", step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
  fireRateHz: { label: "Shots per second", step: 0.1, format: (v) => v.toFixed(1) },
  targetRatio: {
    label: "Share that are targets",
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  roundCount: { label: "Rounds", step: 1, format: (v) => String(Math.round(v)) },
  roundSeconds: { label: "Seconds per round", step: 1, format: (v) => `${Math.round(v)}s` },
  tolerancePercent: { label: "Price tolerance", step: 1, format: (v) => `${Math.round(v)}%` },
  // Integers: chainPop.ts Math.rounds both before building the board.
  gridCols: { label: "Board width", step: 1, format: (v) => String(Math.round(v)) },
  gridRows: { label: "Board height", step: 1, format: (v) => String(Math.round(v)) },
  minChainLength: { label: "Chain length to pop", step: 1, format: (v) => String(Math.round(v)) },
};

/** Capabilities are data, so a template added later can declare a tuning key
 * this file has never heard of. Falling back to a humanised key keeps that
 * setting editable instead of silently dropping it from the panel. */
function tuningField(key: string): { label: string; step: number; format: (value: number) => string } {
  const known = TUNING_FIELDS[key];
  if (known) return known;
  const label = humanRoleLabel(key);
  return {
    label: label.charAt(0).toUpperCase() + label.slice(1),
    step: 0.1,
    format: (v) => String(v),
  };
}

/** The reason unassigning one image from `role` would break the game, or
 * null. Only a `fallback: "none"` role can break: every other role has a
 * stand-in the runtime knows how to draw. */
function unassignBlockedReason(
  cap: GameCapability,
  role: CapabilityRole,
  playableCount: number,
): string | null {
  if (role.fallback !== "none" || playableCount > role.count.min) return null;
  return `${cap.name} needs at least ${role.count.min} ${humanRoleLabel(role.id)} image${
    role.count.min === 1 ? "" : "s"
  } — removing this one would leave players with nothing to play against.`;
}

/** Same guard for the irreversible delete, which drops the asset from every
 * role at once. Written against the whole spec rather than one role because
 * the caller (the flat and unassigned lists) doesn't know which roles the
 * asset is in. */
function deleteBlockedReason(
  spec: GameSpec,
  cap: GameCapability,
  assetId: string,
): string | null {
  for (const role of cap.roles) {
    if (role.fallback !== "none") continue;
    const playable = playableAssetsForRole(spec, cap, role.id);
    if (!playable.some((a) => a.id === assetId)) continue;
    const reason = unassignBlockedReason(cap, role, playable.length);
    if (reason) return reason;
  }
  return null;
}

/** An irreversible control: full-strength destructive text (destructive/80
 * over card measures below AA at 12px) and px-2 py-1 so the hit target
 * clears WCAG 2.2 SC 2.5.8's 24×24. Reversible actions deliberately keep the
 * underlined-link look, so underline consistently reads as "safe". */
const DESTRUCTIVE_BUTTON_CLASS =
  "shrink-0 rounded-md px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";

/** The focus ring a `peer sr-only` file input projects onto its own label —
 * a 1px clipped input's own ring is invisible, so the label has to wear it. */
const PEER_FOCUS_RING_CLASS =
  "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 " +
  "peer-focus-visible:ring-offset-background";

export default function GamePreviewEditorPage() {
  return (
    <AuthGate title="Sign in to edit this game" description="These pages show one game's spec, stats and embed code. Sign in to the account that owns it.">
      <GameEditor />
    </AuthGate>
  );
}

function GameEditor() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [game, setGame] = useState<GameRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [screen, setScreen] = useState<Screen>("whole");
  const [justSaved, setJustSaved] = useState(false);
  /** Counted, not a boolean: "Saving…" must stay up until the LAST queued
   * write lands, not until the first one does. */
  const [inFlight, setInFlight] = useState(0);
  const [saveFailures, setSaveFailures] = useState<SaveFailure[]>([]);
  /** Which score the End-summary mock is drawn at — a reward row's "Preview
   * this tier" retargets it, so a tier above the default can be inspected. */
  const [previewScore, setPreviewScore] = useState(DEFAULT_PREVIEW_SCORE);
  /** The caption under the preview. The static mock is a picture, and this
   * sentence says what it is a picture of, so it is the mock's description
   * rather than an unrelated paragraph that happens to sit beneath it. */
  const previewCaptionId = useId();

  // The freshest spec, readable synchronously. Patch builders run against
  // THIS at send time rather than against the spec that was on screen when
  // the field was edited, so two edits inside one round trip compose instead
  // of the second reverting the first.
  const specRef = useRef<GameSpec | null>(null);
  // One promise chain: at most one PATCH is ever in flight, so responses can
  // never land out of order and "last edit wins" means the last edit the
  // merchant made, not the request that happened to return last.
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failureIdRef = useRef(0);

  useEffect(() => {
    specRef.current = game?.spec ?? null;
  }, [game]);

  // The "Saved" tick runs on a timer that would otherwise outlive a fast
  // navigation away from the editor.
  useEffect(
    () => () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    },
    [],
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [mountError, setMountError] = useState<string | null>(null);

  // In-progress keystrokes for the start/end screen copy fields, so the
  // static preview (StaticScreenPreview) updates the instant you type
  // rather than waiting on the blur-triggered PATCH.
  const [copyDraft, setCopyDraft] = useState<Partial<GameSpec["copy"]>>({});
  // Drops only the keys the server has caught up with. Clearing the whole
  // draft whenever the copy OBJECT changed meant any save at all (a reward,
  // a colour, a role — every PATCH response is freshly parsed JSON) snapped
  // the mock back to committed copy while the input beside it still showed
  // what was being typed. Returning the same object when nothing settled
  // also avoids a pointless extra render on first load.
  useEffect(() => {
    const copy = game?.spec.copy;
    if (!copy) return;
    setCopyDraft((d) => {
      const next = Object.fromEntries(
        Object.entries(d).filter(([k, v]) => copy[k as keyof GameSpec["copy"]] !== v),
      ) as Partial<GameSpec["copy"]>;
      return Object.keys(next).length === Object.keys(d).length ? d : next;
    });
  }, [game?.spec.copy]);

  useEffect(() => {
    fetch(`/api/games/${id}?full=1`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("Game not found.");
        return res.json();
      })
      .then(setGame)
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load."));
  }, [id]);

  const spec = game?.spec ?? null;

  // The highest score a real player can reach in THIS game. The capability's
  // maxRealistic is a per-template constant chosen against default tuning, so
  // it is only the seed; the tuning-aware ceiling has to be resolved through
  // the template's own runtime module, which is async.
  const [resolvedMaxScore, setResolvedMaxScore] = useState<number | undefined>(undefined);
  const maxScore = resolvedMaxScore ?? (spec ? staticMaxRealisticScore(spec.template) : undefined);
  useEffect(() => {
    if (!spec) return;
    let cancelled = false;
    resolveMaxRealisticScoreForSpec(spec)
      .then((value) => {
        if (!cancelled) setResolvedMaxScore(value);
      })
      .catch(() => {
        // Leaves the static seed in place — the honest degraded answer.
      });
    return () => {
      cancelled = true;
    };
    // Only the inputs to the ceiling, not every spec edit: re-resolving on a
    // copy change would dynamic-import the runtime module for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec?.template, spec?.tuning, spec?.durationSeconds]);

  // Mount the real runtime against the current spec — but only for the two
  // tabs that actually need the canvas ("whole game" and "game screen"; the
  // start/end screens render a static preview below instead, built from the
  // same overlay DOM mount.ts itself uses — see StaticScreenPreview).
  // Re-runs whenever the spec changes (an edit saved), the device toggle
  // changes (canvas re-fits its container), or the screen tab switches
  // into/out of a canvas tab.
  useEffect(() => {
    let cancelled = false;
    let handle: { teardown(): void } | undefined;

    async function run() {
      if (!containerRef.current) return;
      containerRef.current.innerHTML = "";
      setMountError(null);
      if (screen !== "whole" && screen !== "game") return;
      if (!spec || !game) return;
      try {
        const { mount } = await import("@/lib/runtime/mount");
        if (cancelled) return;
        // Pass the game's real slug (once published) so telemetry
        // (POST /api/plays/start|finish) ties back to this game instead of
        // the synthetic spec.id fallback mount() uses when no slug is given.
        handle = mount(spec, containerRef.current, game.placement, {
          slug: game.slug ?? undefined,
          // "Game screen" wants to show gameplay immediately, not force a
          // click through the idle screen first — that idle screen is its
          // own tab already.
          autoStart: screen === "game",
        });
      } catch {
        if (!cancelled) {
          setMountError(
            "Live preview isn't available yet in this build — the game runtime is being built on another track.",
          );
        }
      }
    }
    run();
    return () => {
      cancelled = true;
      handle?.teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, device, screen]);

  /**
   * The one write path. Takes a builder rather than a finished patch so the
   * patch is computed at send time against the freshest spec, and a label
   * that names the edit in both the failure row and its retry.
   */
  function patchSpec(build: PatchBuilder, label: string): Promise<void> {
    const run = async () => {
      const base = specRef.current;
      if (!base) return;
      const patch = build(base);

      // Optimistic: the panel and the preview must not wait a round trip.
      const optimistic: GameSpec = { ...base, ...patch };
      specRef.current = optimistic;
      setGame((prev) => (prev ? { ...prev, spec: optimistic } : prev));

      const body = JSON.stringify(patch);
      setInFlight((n) => n + 1);
      let failure: string | null = null;
      try {
        const res = await fetch(`/api/games/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body,
          // Lets the save started by the blur that precedes a click on
          // "Continue to embed & publish" outlive the navigation. keepalive
          // caps the body at 64 KB and an `assets` patch could approach it,
          // so it is opt-in by size rather than unconditional.
          keepalive: body.length < 60_000,
        });
        if (!res.ok) {
          failure = await describeSaveFailure(res);
        } else {
          const serverSpec = (await res.json().catch(() => null)) as GameSpec | null;
          // The echo is normally identical to what was already applied;
          // setting it again would tear the live canvas down and re-mount it
          // a second time for one edit.
          if (serverSpec && JSON.stringify(serverSpec) !== JSON.stringify(optimistic)) {
            specRef.current = serverSpec;
            setGame((prev) => (prev ? { ...prev, spec: serverSpec } : prev));
          }
        }
      } catch {
        // fetch() rejects only on a network-level failure; every HTTP status
        // resolves normally and is handled above.
        failure = "You appear to be offline — this change wasn't saved.";
      } finally {
        setInFlight((n) => n - 1);
      }

      if (failure !== null) {
        failureIdRef.current += 1;
        const entry: SaveFailure = { id: failureIdRef.current, label, build, message: failure };
        // Replace this field's outstanding failure, keep everyone else's: an
        // unrelated successful save must never erase the news that an earlier
        // edit was dropped.
        setSaveFailures((prev) => [...prev.filter((e) => e.label !== label), entry]);
        return;
      }

      setSaveFailures((prev) => prev.filter((e) => e.label !== label));
      setJustSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setJustSaved(false), 1800);
    };

    chainRef.current = chainRef.current.then(run, run);
    return chainRef.current;
  }

  const warnings = useMemo(() => spec?.meta.warnings ?? [], [spec]);

  if (loadError)
    return (
      <p role="alert" className="text-sm text-destructive">
        {loadError}
      </p>
    );
  if (!game || !spec) return <p className="text-sm text-muted">Loading…</p>;

  // Merges in-flight copy keystrokes over the committed spec, for the
  // start/end static preview mocks only — every other reader keeps using
  // `spec` (the settings inputs, the live canvas, patchSpec) unchanged.
  const previewSpec: GameSpec = { ...spec, copy: { ...spec.copy, ...copyDraft } };

  // Display order = evaluation order. Both reward resolvers sort internally,
  // so the stored array order means nothing to the runtime but reads as
  // arbitrary on screen. The ORIGINAL index travels with each row: every
  // callback indexes into spec.rewards, so keying or patching by the sorted
  // position would edit a different tier than the one on screen.
  const orderedRewards = spec.rewards
    .map((reward, index) => ({ reward, index }))
    .sort((a, b) => a.reward.minScore - b.reward.minScore);
  const baseline = orderedRewards[0];

  // The same predicate the publish route refuses on, so this CTA can never
  // promise a journey the server will reject. An outstanding save failure
  // blocks too: publishing past a dropped edit ships something the merchant
  // has already been told did not save.
  const firstGap = findIncompleteRoles(spec)[0];
  const missing = firstGap ? firstGap.need - firstGap.have : 0;
  const exitBlockedReason = firstGap
    ? `Add ${missing} more ${humanRoleLabel(firstGap.label)} image${
        missing === 1 ? "" : "s"
      } before publishing — the game is unplayable without them.`
    : saveFailures.length > 0
      ? "Resolve the unsaved changes above first."
      : null;

  return (
    <div className="animate-fade-up">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="font-display text-2xl font-semibold tracking-tight">{game.name}</h1>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
              game.status === "published"
                ? "bg-success/10 text-success"
                : "bg-foreground/[0.06] text-muted"
            }`}
          >
            {game.status}
          </span>
        </div>
        {/* aria-pressed, not role="tab"/aria-selected: the tab contract
            requires roving tabindex and Arrow-key handling this doesn't
            implement, and these buttons don't navigate either. The ring and
            font weight are not decoration — forced-colors mode flattens
            `bg-*` away, so background alone would leave no visible
            indication of which device is selected. */}
        <div
          role="group"
          aria-label="Preview device"
          className="flex gap-1 rounded-full border border-border bg-card p-1 text-sm shadow-card"
        >
          <button
            type="button"
            aria-pressed={device === "desktop"}
            className={`rounded-full px-3 py-1 transition ${
              device === "desktop"
                ? "bg-primary font-semibold text-primary-foreground ring-2 ring-primary"
                : "text-muted hover:text-foreground"
            }`}
            onClick={() => setDevice("desktop")}
          >
            Desktop
          </button>
          <button
            type="button"
            aria-pressed={device === "mobile"}
            className={`rounded-full px-3 py-1 transition ${
              device === "mobile"
                ? "bg-primary font-semibold text-primary-foreground ring-2 ring-primary"
                : "text-muted hover:text-foreground"
            }`}
            onClick={() => setDevice("mobile")}
          >
            Mobile
          </button>
        </div>
      </div>

      {/* Three columns: which screen (left) → what it looks like (middle,
          live for whole-game/game-screen, a static instant-updating mock for
          start/end since those two are simple overlays, not canvas state) →
          the fields that affect only that screen (right). Editing was
          previously one flat "every field, grouped by type" list; a
          merchant thinks in terms of the screen a player actually sees
          (start / mid-game / end), not "copy" vs. "branding". */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[168px_1fr_360px] lg:items-start">
        <nav
          aria-label="Editor screen"
          className="flex gap-2 overflow-x-auto pb-1 lg:sticky lg:top-24 lg:w-auto lg:shrink-0 lg:flex-col lg:overflow-visible lg:pb-0"
        >
          {SCREENS.map((s) => (
            <button
              key={s.id}
              type="button"
              // Same reasoning as the device toggle: aria-pressed rather than
              // a tab/aria-current contract this doesn't honour, and a ring +
              // weight cue because forced-colors mode drops the tinted
              // background these otherwise rely on entirely.
              aria-pressed={screen === s.id}
              onClick={() => setScreen(s.id)}
              className={`flex shrink-0 items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition lg:w-full ${
                screen === s.id
                  ? "border-primary/30 bg-primary/10 text-primary ring-2 ring-primary"
                  : "border-border bg-card text-foreground hover:border-primary/30"
              }`}
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                  screen === s.id ? "bg-primary/15" : "bg-foreground/[0.06] text-muted"
                }`}
              >
                {s.icon}
              </span>
              <span className="min-w-0">
                <span
                  className={`block whitespace-nowrap text-sm ${
                    screen === s.id ? "font-semibold" : "font-medium"
                  }`}
                >
                  {s.label}
                </span>
                <span className="hidden truncate text-xs text-muted lg:block">{s.hint}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="lg:sticky lg:top-24">
          <div
            className={`overflow-hidden rounded-2xl border border-border bg-card shadow-card ${
              device === "mobile" ? "mx-auto max-w-sm" : "w-full"
            }`}
            style={{ minHeight: 480 }}
          >
            {screen === "whole" || screen === "game" ? (
              <>
                <div ref={containerRef} className="h-full w-full" style={{ minHeight: 480 }} />
                {mountError && (
                  // status, not alert: this is an informational "preview
                  // unavailable" notice, not a failed user action.
                  <div role="status" className="p-6 text-center text-sm text-muted">
                    {mountError}
                  </div>
                )}
              </>
            ) : screen === "start" ? (
              <StaticScreenPreview
                kind="idle"
                spec={previewSpec}
                exampleScore={previewScore}
                describedById={previewCaptionId}
              />
            ) : (
              <StaticScreenPreview
                kind="reward"
                spec={previewSpec}
                exampleScore={previewScore}
                describedById={previewCaptionId}
              />
            )}
          </div>
          <p id={previewCaptionId} className="mt-2 text-center text-xs text-muted">
            {screen === "whole" && "The full flow — press play to try it."}
            {screen === "start" && "What players see before pressing play. Updates as you type."}
            {screen === "game" && "Gameplay, using whatever images are assigned below."}
            {screen === "end" && "What players see after finishing. Updates as you type."}
          </p>
        </div>

        <aside>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold tracking-tight">Customize your game</h2>
              <p className="text-xs text-muted">Changes save automatically.</p>
            </div>
            {/* Always rendered so the live region exists on first paint and
                only its text changes — a region inserted at the same moment
                its message appears is frequently not announced at all, and
                edits here commit on blur, so there is no click for assistive
                tech to associate the outcome with. */}
            <div role="status" aria-live="polite" aria-atomic="true" className="min-h-[1.25rem]">
              <SaveStatus
                saving={inFlight > 0}
                justSaved={justSaved}
                hasFailures={saveFailures.length > 0}
              />
            </div>
          </div>
          <div role="alert" className={saveFailures.length > 0 ? "mt-2 space-y-2" : ""}>
            {saveFailures.map((failure) => (
              <div
                key={failure.id}
                className="rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-destructive"
              >
                <p className="text-xs">
                  <span className="font-medium">{failure.label} didn&rsquo;t save.</span>{" "}
                  {failure.message}
                </p>
                <div className="mt-1.5 flex gap-1.5">
                  {/* Retry rebuilds against the CURRENT spec, so it can
                      never clobber a sibling field that saved meanwhile. */}
                  <button
                    type="button"
                    onClick={() => {
                      void patchSpec(failure.build, failure.label);
                    }}
                    className="rounded-md border border-destructive/30 px-2 py-1 text-xs font-medium hover:bg-destructive/20"
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setSaveFailures((prev) => prev.filter((e) => e.id !== failure.id))
                    }
                    className="rounded-md px-2 py-1 text-xs font-medium hover:bg-destructive/20"
                  >
                    Discard
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Global, not screen-scoped, so it's always visible no matter
              which tab is open — a gap in the game screen's images is just
              as worth surfacing while looking at the start screen. */}
          {warnings.length > 0 && (
            <div className="mt-4 rounded-2xl border border-warning/25 bg-warning/10 p-3 text-sm text-warning">
              <p className="font-medium">What we inferred</p>
              <ul className="mt-1 list-disc pl-5">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 space-y-3">
            {screen === "whole" && (
              // Branding is the one thing that isn't scoped to a single
              // screen — logo, colours and font show up on all three.
              <EditorSection
                icon={<PaletteIcon className="h-4 w-4" />}
                title="Branding"
                description="Logo, colours and font — used on every screen"
                defaultOpen
              >
                <div className="space-y-4">
                  <div>
                    <span className="mb-1.5 block text-xs text-muted">Logo</span>
                    <div className="flex items-center gap-3">
                      {spec.brand.logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={spec.brand.logoUrl}
                          alt="Logo"
                          className="h-10 w-10 rounded-lg border border-border object-contain p-1"
                        />
                      ) : (
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted">
                          None
                        </div>
                      )}
                      <LogoUploadButton
                        onUploaded={(url) => {
                          void patchSpec(
                            (cur) => ({ brand: { ...cur.brand, logoUrl: url } }),
                            "Logo",
                          );
                        }}
                      />
                      {spec.brand.logoUrl && (
                        <button
                          type="button"
                          onClick={() => {
                            void patchSpec(
                              (cur) => ({ brand: { ...cur.brand, logoUrl: undefined } }),
                              "Logo",
                            );
                          }}
                          // No confirm: a removed logo is re-uploadable from
                          // the control right beside it.
                          aria-label="Remove the logo"
                          className={DESTRUCTIVE_BUTTON_CLASS}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <ColorField
                      label="Primary colour"
                      value={spec.brand.accent}
                      onCommit={(hex) => {
                        void patchSpec(
                          (cur) => ({ brand: { ...cur.brand, accent: hex } }),
                          "Primary colour",
                        );
                      }}
                    />
                    {/* secondaryAccent is optional and its ABSENCE is what the
                        runtime reads (catch.ts falls back to a neutral hazard
                        tone, shooter.ts to brand.accent). Showing
                        `secondaryAccent ?? foreground` in a colour well made
                        "unset" look like a configured near-white, with no way
                        back once touched. */}
                    {spec.brand.secondaryAccent === undefined ? (
                      <div className="text-xs">
                        <span className="block text-muted">Secondary colour</span>
                        <div className="mt-1 flex items-center gap-2">
                          <div className="h-9 w-12 shrink-0 rounded-md border border-dashed border-border" />
                          <div className="min-w-0">
                            <span className="block text-muted">Not set — template default</span>
                            <button
                              type="button"
                              onClick={() => {
                                // Seeded from accent, never foreground: no
                                // runtime reads foreground as a secondary.
                                void patchSpec(
                                  (cur) => ({
                                    brand: { ...cur.brand, secondaryAccent: cur.brand.accent },
                                  }),
                                  "Secondary colour",
                                );
                              }}
                              className="text-xs font-medium text-primary underline underline-offset-4"
                            >
                              Set colour
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <ColorField
                          label="Secondary colour"
                          value={spec.brand.secondaryAccent}
                          onCommit={(hex) => {
                            void patchSpec(
                              (cur) => ({ brand: { ...cur.brand, secondaryAccent: hex } }),
                              "Secondary colour",
                            );
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            // Genuinely deletes the key: the builder replaces
                            // the whole brand object and updateGameSpec merges
                            // only at the top level, so an undefined here
                            // drops out of the JSON body and the key is gone.
                            void patchSpec(
                              (cur) => ({ brand: { ...cur.brand, secondaryAccent: undefined } }),
                              "Secondary colour",
                            );
                          }}
                          aria-label="Remove the secondary colour"
                          className={`mt-1 ${DESTRUCTIVE_BUTTON_CLASS}`}
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </div>

                  <Field label="Font">
                    <select
                      value={FONT_OPTIONS.includes(spec.brand.fontFamily) ? spec.brand.fontFamily : FONT_OPTIONS[0]}
                      onChange={(e) => {
                        const fontFamily = e.target.value;
                        void patchSpec((cur) => ({ brand: { ...cur.brand, fontFamily } }), "Font");
                      }}
                      className={FIELD_CONTROL_CLASS}
                    >
                      {FONT_OPTIONS.map((font) => (
                        <option key={font} value={font}>
                          {font}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              </EditorSection>
            )}

            {screen === "start" && (
              <EditorSection
                icon={<TextIcon className="h-4 w-4" />}
                title="Start screen copy"
                description="What players see before pressing play"
                defaultOpen
              >
                <div className="space-y-3">
                  <EditableField
                    field="headline"
                    value={spec.copy.headline}
                    onCommit={(v) => {
                      void patchSpec(
                        (cur) => ({ copy: { ...cur.copy, headline: v } }),
                        COPY_RULES.headline.label,
                      );
                    }}
                    onDraftChange={(v) => setCopyDraft((d) => ({ ...d, headline: v }))}
                  />
                  <EditableField
                    field="subhead"
                    value={spec.copy.subhead}
                    onCommit={(v) => {
                      void patchSpec(
                        (cur) => ({ copy: { ...cur.copy, subhead: v } }),
                        COPY_RULES.subhead.label,
                      );
                    }}
                    onDraftChange={(v) => setCopyDraft((d) => ({ ...d, subhead: v }))}
                  />
                  <EditableField
                    field="ctaStart"
                    value={spec.copy.ctaStart}
                    onCommit={(v) => {
                      void patchSpec(
                        (cur) => ({ copy: { ...cur.copy, ctaStart: v } }),
                        COPY_RULES.ctaStart.label,
                      );
                    }}
                    onDraftChange={(v) => setCopyDraft((d) => ({ ...d, ctaStart: v }))}
                  />
                </div>
              </EditorSection>
            )}

            {screen === "game" && (
              <>
                {/* Images, grouped by the role each one plays in the game. */}
                <EditorSection
                  icon={<ImageIcon className="h-4 w-4" />}
                  title="Images"
                  description="Assign photos to each role in the game"
                  badge={<RoleCompletenessBadge spec={spec} />}
                  defaultOpen
                >
                  <RoleImagesEditor spec={spec} patchSpec={patchSpec} />
                </EditorSection>
                <TuningSection spec={spec} patchSpec={patchSpec} />
              </>
            )}

            {screen === "end" && (
              <>
                <EditorSection
                  icon={<TextIcon className="h-4 w-4" />}
                  title="End screen copy"
                  description="Score reveal, reward line and replay"
                  defaultOpen
                >
                  <div className="space-y-3">
                    <EditableField
                      field="rewardIntro"
                      value={spec.copy.rewardIntro}
                      onCommit={(v) => {
                        void patchSpec(
                          (cur) => ({ copy: { ...cur.copy, rewardIntro: v } }),
                          COPY_RULES.rewardIntro.label,
                        );
                      }}
                      onDraftChange={(v) => setCopyDraft((d) => ({ ...d, rewardIntro: v }))}
                    />
                    {/* COPY_RULES names this "Email placeholder": after the
                        submit button got its own fixed label, emailPrompt has
                        exactly one use left. */}
                    <EditableField
                      field="emailPrompt"
                      value={spec.copy.emailPrompt}
                      hint="The hint shown inside the email box on the end screen."
                      onCommit={(v) => {
                        void patchSpec(
                          (cur) => ({ copy: { ...cur.copy, emailPrompt: v } }),
                          COPY_RULES.emailPrompt.label,
                        );
                      }}
                      onDraftChange={(v) => setCopyDraft((d) => ({ ...d, emailPrompt: v }))}
                    />
                    <EditableField
                      field="ctaReplay"
                      value={spec.copy.ctaReplay}
                      onCommit={(v) => {
                        void patchSpec(
                          (cur) => ({ copy: { ...cur.copy, ctaReplay: v } }),
                          COPY_RULES.ctaReplay.label,
                        );
                      }}
                      onDraftChange={(v) => setCopyDraft((d) => ({ ...d, ctaReplay: v }))}
                    />
                  </div>
                </EditorSection>

                {/* Reward thresholds — fully optional; a game with zero
                    tiers just shows a "thanks for playing" screen
                    (lib/runtime/reward.ts already handles an empty rewards
                    array). */}
                <EditorSection
                  icon={<GiftIcon className="h-4 w-4" />}
                  title="Rewards"
                  description="Optional — discount tiers unlocked by score"
                  badge={
                    <span className="shrink-0 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-xs text-muted">
                      {spec.rewards.length === 0 ? "Off" : spec.rewards.length}
                    </span>
                  }
                  defaultOpen
                >
                  <div className="space-y-3">
                    {maxScore !== undefined && (
                      <p className="text-xs text-muted">
                        Typical scores for this game run 0–{maxScore}.
                      </p>
                    )}
                    {spec.rewards.length === 0 && (
                      <p className="text-xs text-muted">
                        No reward tiers yet — players just see a &ldquo;thanks for playing&rdquo; screen.
                        Add a tier to offer a discount instead.
                      </p>
                    )}
                    {/* Non-blocking on purpose: a raised floor can be
                        deliberate, and silently rewriting the lowest tier to 0
                        would discard that intent. */}
                    {baseline && !hasBaselineTier(spec.rewards) && (
                      <p className="rounded-lg border border-border p-2 text-xs text-muted">
                        Players scoring below {baseline.reward.minScore} see no reward. Add a tier
                        at min score 0 to always give something.
                      </p>
                    )}
                    {orderedRewards.map(({ reward, index }) => (
                      <RewardRow
                        key={index}
                        gameId={id}
                        reward={reward}
                        index={index}
                        maxScore={maxScore}
                        otherMinScores={spec.rewards
                          .filter((_, idx) => idx !== index)
                          .map((tier) => tier.minScore)}
                        isBaseline={baseline?.index === index}
                        previewing={previewScore === reward.minScore}
                        onCommit={(patch) => {
                          void patchSpec(
                            (cur) => ({
                              rewards: cur.rewards.map((existing, idx) =>
                                idx === index ? { ...existing, ...patch } : existing,
                              ),
                            }),
                            `Reward tier ${index + 1}`,
                          );
                        }}
                        onRemove={() => {
                          void patchSpec(
                            (cur) => ({ rewards: cur.rewards.filter((_, idx) => idx !== index) }),
                            `Reward tier ${index + 1}`,
                          );
                        }}
                        onPreview={() => setPreviewScore(reward.minScore)}
                      />
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        // A generated game always already has a tier at 0
                        // (brain.ts guarantees it), so a hardcoded minScore of
                        // 0 made the very first "Add another tier" a
                        // guaranteed collision — and both reward resolvers
                        // resolve a duplicate threshold silently.
                        void patchSpec(
                          (cur) => ({
                            rewards: [
                              ...cur.rewards,
                              {
                                minScore: suggestNextMinScore(cur.rewards, maxScore),
                                label: "New tier",
                                percentOff: 10,
                              },
                            ],
                          }),
                          "Reward tiers",
                        );
                      }}
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2 text-xs font-medium text-primary hover:border-primary/40"
                    >
                      + Add {spec.rewards.length === 0 ? "a reward tier" : "another tier"}
                    </button>
                  </div>
                </EditorSection>
              </>
            )}
          </div>

          {/* Deliberately outside the four screen conditionals: a gap in the
              game screen's images is just as blocking while looking at the
              start screen, and this is the one control every tab shares. */}
          {exitBlockedReason ? (
            <div className="mt-4">
              <span
                aria-disabled="true"
                className="block cursor-not-allowed rounded-xl bg-primary px-4 py-3 text-center text-sm font-semibold text-primary-foreground opacity-40 shadow-elevated"
              >
                Continue to embed &amp; publish
              </span>
              <p className="mt-1.5 text-xs text-warning">{exitBlockedReason}</p>
            </div>
          ) : (
            <Link
              href={`/games/${id}/embed`}
              aria-busy={inFlight > 0}
              onClick={(e) => {
                // The blur that precedes this click has already queued its
                // save onto the chain, so awaiting the chain is what
                // guarantees the last edit lands before the next page reads
                // the spec back. router.push also keeps this inside the app
                // router instead of reloading the whole document.
                e.preventDefault();
                void chainRef.current.then(() => router.push(`/games/${id}/embed`));
              }}
              className="mt-4 block rounded-xl bg-primary px-4 py-3 text-center text-sm font-semibold text-primary-foreground shadow-elevated transition active:scale-[0.98]"
            >
              {inFlight > 0 ? "Saving…" : "Continue to embed & publish"}
            </Link>
          )}
        </aside>
      </div>
    </div>
  );
}

function SaveStatus({
  saving,
  justSaved,
  hasFailures,
}: {
  saving: boolean;
  justSaved: boolean;
  /** At least one edit is still unsaved. */
  hasFailures: boolean;
}) {
  if (saving) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        Saving…
      </span>
    );
  }
  // A green tick beside an outstanding failure row would read as "everything
  // is saved"; in that state the failure row is the only honest status.
  if (justSaved && !hasFailures) {
    return (
      <span className="flex items-center gap-1 text-xs font-medium text-success">
        <CheckIcon className="h-3.5 w-3.5" />
        Saved
      </span>
    );
  }
  return null;
}

/**
 * Static preview of the idle ("start") or reward ("end") overlay for the
 * screen-scoped tabs. Renders via mount.ts's own renderStaticScreen() —
 * the exact same DOM-building code the "Whole game" tab's live canvas mount
 * uses for these two overlays — rather than a separate JSX
 * reimplementation. That's not a style preference: a hand-rolled parallel
 * copy previously lived here and visibly drifted from the real thing (a
 * lighter font weight, a max-width that wrapped the subhead differently,
 * a slightly different button size) — it's *possible* to keep such a copy
 * pixel-synced by hand, but nothing forces it to stay that way the next
 * time mount.ts's overlay changes, so this instead makes drift structurally
 * impossible. Re-renders on every keystroke via `spec` (the caller passes
 * the live copy-draft-merged spec — see `previewSpec` in the page
 * component), which is cheap: this is a handful of DOM nodes, no game loop.
 */
function StaticScreenPreview({
  kind,
  spec,
  exampleScore,
  describedById,
}: {
  kind: "idle" | "reward";
  spec: GameSpec;
  /** The score the reward mock resolves its tier at. Defaults inside
   * renderStaticScreen; a reward row raises it so a tier above the default
   * can actually be inspected. */
  exampleScore: number;
  describedById?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const { renderStaticScreen } = await import("@/lib/runtime/mount");
      if (cancelled || !ref.current) return;
      ref.current.innerHTML = "";
      ref.current.appendChild(renderStaticScreen(kind, spec, exampleScore));
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [kind, spec, exampleScore]);

  return (
    <div
      role="group"
      aria-label={`Preview of the ${
        kind === "idle" ? "start screen" : "end summary"
      } as players will see it`}
      aria-describedby={describedById}
      className="h-full w-full"
      style={{ minHeight: 480 }}
    >
      {/* The idle screen is still fully `inert`: this is a picture of the
          game, not the game — renderStaticScreen builds a real <button> via
          makeButton wired to a no-op, and a real <h2> that would otherwise
          duplicate the panel's own heading in the outline, so `inert` takes
          both out of the tab order and the a11y tree at once.

          The reward screen is NOT inert: its gallery of engaged products can
          carry real, meaningful links to each product's actual page (see
          RawAsset.data.productUrl in lib/engine/types.ts) — those need to
          stay genuinely clickable/focusable even in this "preview" tab, so
          `inert` (which has no per-descendant opt-out) can't wrap this one.
          renderStaticScreen instead disables its own no-op buttons/inputs
          directly (`button.disabled = true`, same for the email field) so
          only the real links remain interactive. role="group" (not "img")
          on this wrapper reflects that: the reward preview genuinely has
          live content inside it now, not just a flat picture. */}
      <div
        ref={ref}
        inert={kind === "idle" ? true : undefined}
        className="h-full w-full"
        style={{ minHeight: 480 }}
      />
    </div>
  );
}

/** The badge answers "is this game's image set complete?" — so it has to ask
 * the question the runtime asks. Counting `entry.length >= count.min` over
 * non-optional roles got it wrong in three directions at once: a legitimate
 * `{ fallback }` stand-in (what the matcher writes for catch's catcher) read
 * as a permanent shortfall, chain_pop and shooter got no badge at all because
 * every one of their roles is marked optional, and a guess_price hero with no
 * price counted as filled even though guessPrice.ts drops it from the round
 * order. trackedRoles/roleIsSatisfied are the shared definitions. */
function RoleCompletenessBadge({ spec }: { spec: GameSpec }) {
  const capability = getCapability(spec.template);
  if (!capability) return null;
  const tracked = trackedRoles(capability);
  if (tracked.length === 0) return null;
  const filled = tracked.filter((role) => roleIsSatisfied(spec, capability, role)).length;
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
        filled === tracked.length ? "bg-success/10 text-success" : "bg-warning/10 text-warning"
      }`}
    >
      {filled}/{tracked.length}
    </span>
  );
}

/** Collapsible panel — icon + title (+ optional status badge). Every current
 * call site opens by default; collapsing is user-initiated. The badges (e.g.
 * RoleCompletenessBadge) stay visible in the header so a collapsed section can
 * still surface a problem. */
function EditorSection({
  icon,
  title,
  description,
  badge,
  defaultOpen = true,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-3 p-4 text-left"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          {description && <span className="block truncate text-xs text-muted">{description}</span>}
        </span>
        {badge}
        <ChevronIcon
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div
        id={panelId}
        // visibility is transitioned alongside the row so the close still
        // animates — CSS holds `visible` for the full duration when animating
        // to hidden, which display:none would cut dead.
        className={`grid transition-[grid-template-rows,visibility] duration-200 ease-out ${
          open ? "grid-rows-[1fr] visible" : "grid-rows-[0fr] invisible"
        }`}
      >
        {/* grid-rows-[0fr] + overflow-hidden collapses the panel to zero
            height but leaves every input focusable and in the a11y tree — you
            could Tab into an invisible Min score box. `inert` removes both in
            one attribute, so no separate aria-hidden is needed. */}
        <div className="overflow-hidden" inert={!open}>
          <div className="border-t border-border p-4 pt-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

/** The panel's one control class. Four different heights and two label sizes
 * used to ship for fields that sit side by side, purely depending on which
 * component drew them. */
const FIELD_CONTROL_CLASS =
  "mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-primary/50";

/** Ids for a field's hint and error text, derived from the control's own id
 * so a caller can wire aria-describedby without Field having to hand anything
 * back out through its children. */
function hintIdFor(controlId: string): string {
  return `${controlId}-hint`;
}
function errorIdFor(controlId: string): string {
  return `${controlId}-error`;
}

/** Joins the ids that are actually rendered; undefined when there are none,
 * because an aria-describedby pointing at a missing id names nothing. */
function describedBy(...ids: (string | null | undefined | false)[]): string | undefined {
  const present = ids.filter((id): id is string => Boolean(id));
  return present.length > 0 ? present.join(" ") : undefined;
}

/**
 * The shared field shell: label, control, optional hint, optional error.
 *
 * Hint and error deliberately sit OUTSIDE the <label>. A label's contents
 * become the control's accessible name, so an error message rendered inside
 * it would be read as part of the field's name and then again as its
 * description.
 */
function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  const generatedId = useId();
  const controlId = htmlFor ?? generatedId;
  return (
    <div>
      <label className="block text-xs" htmlFor={htmlFor}>
        <span className="block text-muted">{label}</span>
        {children}
      </label>
      {hint && (
        <p id={hintIdFor(controlId)} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorIdFor(controlId)} className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A brand colour well.
 *
 * React maps onChange to the DOM `input` event, which fires continuously
 * while an OS colour picker is dragged — driving the swatch straight off the
 * spec meant dozens of PATCHes, and dozens of canvas teardown/remount cycles,
 * for one colour pick. Local state renders the drag instantly; the write is
 * debounced and flushed on the native `change` event (the picker closing) and
 * on blur.
 */
function ColorField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (hex: string) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [local, setLocal] = useState(value);
  /** The value the server has (or has been asked for) vs. the value under the
   * cursor — the two together are what make a no-op drag issue no write. */
  const committedRef = useRef(value);
  const pendingRef = useRef(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<() => void>(() => {});

  useEffect(() => {
    committedRef.current = value;
    pendingRef.current = value;
    setLocal(value);
  }, [value]);

  function flush() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const next = pendingRef.current;
    if (next === committedRef.current) return;
    // Marked as requested before the round trip: React also routes the native
    // `change` event to onChange for a colour input, so without this the
    // debounce that re-arms would issue the identical write a second time.
    committedRef.current = next;
    onCommit(next);
  }

  // Kept in a ref so the native listener below can stay mounted once.
  useEffect(() => {
    flushRef.current = flush;
  });

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onNativeChange = () => flushRef.current();
    el.addEventListener("change", onNativeChange);
    return () => el.removeEventListener("change", onNativeChange);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <Field label={label} htmlFor={inputId}>
      <div className="mt-1 flex items-center gap-2">
        <input
          id={inputId}
          ref={inputRef}
          type="color"
          value={local}
          onChange={(e) => {
            pendingRef.current = e.target.value;
            setLocal(e.target.value);
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => flushRef.current(), 250);
          }}
          onBlur={() => flush()}
          className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-border"
        />
        <span className="font-mono text-xs uppercase text-muted">{local}</span>
      </div>
    </Field>
  );
}

function EditableField({
  field,
  value,
  hint,
  onCommit,
  onDraftChange,
}: {
  /** The field reads its own label, required-ness and cap from COPY_RULES, so
   * the editor and the PATCH schema cannot disagree about any of them. */
  field: keyof GameCopy;
  value: string;
  hint?: string;
  onCommit: (v: string) => void;
  /** Fires on every keystroke, before the blur-triggered save — lets the
   * start/end screen mocks track what's being typed instantly instead of
   * waiting for the PATCH round-trip that onCommit kicks off. */
  onDraftChange?: (v: string) => void;
}) {
  const rule = COPY_RULES[field];
  const inputId = useId();
  const [local, setLocal] = useState(value);
  const [error, setError] = useState<string | null>(null);
  /** True between a keystroke and the commit that settles it. */
  const dirty = useRef(false);

  // Guarded resync: an unguarded one wiped whatever was being typed whenever
  // an unrelated PATCH landed, because every response replaces the whole spec.
  useEffect(() => {
    if (!dirty.current) setLocal(value);
  }, [value]);

  function commit() {
    // Nothing typed since the last settle. This is also what makes the blur
    // that follows an Enter-commit a no-op rather than a second PATCH.
    if (!dirty.current) return;
    const next = local.trim();
    const result = validateCopyField(field, next);
    if (!result.ok) {
      setError(result.message);
      // Snap the input AND the mock back to the committed value: an empty
      // headline must never be what the preview — or a live embed — shows.
      setLocal(value);
      onDraftChange?.(value);
      dirty.current = false;
      return;
    }
    setError(null);
    dirty.current = false;
    setLocal(next);
    onDraftChange?.(next);
    if (next !== value) onCommit(next);
  }

  const remaining = rule.max - local.length;

  return (
    <Field label={rule.label} htmlFor={inputId} hint={hint} error={error}>
      <input
        id={inputId}
        value={local}
        maxLength={rule.max}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy(
          hint && hintIdFor(inputId),
          error && errorIdFor(inputId),
        )}
        onChange={(e) => {
          dirty.current = true;
          setLocal(e.target.value);
          onDraftChange?.(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          // The field isn't inside a <form>, so Enter would otherwise do
          // nothing at all.
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setLocal(value);
            onDraftChange?.(value);
            setError(null);
            dirty.current = false;
            e.currentTarget.blur();
          }
        }}
        className={FIELD_CONTROL_CLASS}
      />
      {/* aria-hidden: maxLength already tells assistive tech the cap, and
          anything inside the <label> would otherwise join the field's name. */}
      <span
        aria-hidden="true"
        className={`mt-1 block text-right text-xs ${remaining <= 10 ? "text-warning" : "text-muted"}`}
      >
        {local.length}/{rule.max}
      </span>
    </Field>
  );
}

function RewardRow({
  gameId,
  reward,
  index,
  maxScore,
  otherMinScores,
  isBaseline,
  previewing,
  onCommit,
  onRemove,
  onPreview,
}: {
  /** Needed for the coupon endpoints, which are scoped per game. */
  gameId: string;
  reward: RewardTier;
  /** Position in spec.rewards — rows render in threshold order, so this is
   * NOT the row's position on screen. */
  index: number;
  maxScore?: number;
  otherMinScores: number[];
  /** This row holds the lowest threshold: removing it raises the floor. */
  isBaseline: boolean;
  previewing: boolean;
  onCommit: (patch: Partial<RewardTier>) => void;
  onRemove: () => void;
  onPreview: () => void;
}) {
  const baseId = useId();
  const minScoreId = `${baseId}-min`;
  const percentOffId = `${baseId}-pct`;
  const labelId = `${baseId}-label`;
  const codeId = `${baseId}-code`;

  // Every value is held as a string. For percentOff that's load-bearing: null
  // ("no discount, just a thank-you") and 0 are different tiers, and
  // Number("") === 0 would silently turn the first into the second whenever
  // the merchant edited the label of a no-discount tier. minScore follows the
  // same rule so an emptied box reports "Enter a number." instead of quietly
  // retargeting the tier to 0.
  const [minScore, setMinScore] = useState(String(reward.minScore));
  const [label, setLabel] = useState(reward.label);
  const [percentOff, setPercentOff] = useState(
    reward.percentOff == null ? "" : String(reward.percentOff),
  );
  const [code, setCode] = useState(reward.code ?? "");
  const [issues, setIssues] = useState<RewardTierIssue[]>([]);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  useEffect(() => {
    setMinScore(String(reward.minScore));
    setLabel(reward.label);
    setPercentOff(reward.percentOff == null ? "" : String(reward.percentOff));
    setCode(reward.code ?? "");
  }, [reward]);

  function issueFor(field: RewardTierField): string | null {
    return issues.find((issue) => issue.field === field)?.message ?? null;
  }

  function commit() {
    const draft: RewardTierDraft = {
      minScore: minScore.trim() === "" ? Number.NaN : Number(minScore),
      label,
      percentOff: percentOff.trim() === "" ? null : Number(percentOff),
      code,
    };
    // min/max on a number input constrain neither typed nor programmatic
    // values, so the real gate is here — and it's the same gate the PATCH
    // route runs, so nothing the editor accepts can be rejected server-side.
    const found = validateRewardTier(draft, { maxScore, otherMinScores });
    if (found.length > 0) {
      // Keep the invalid text on screen: the merchant is mid-fix, and nothing
      // reaches the server until it validates.
      setIssues(found);
      return;
    }
    setIssues([]);
    const next = normalizeRewardTier(draft);
    const changed =
      next.minScore !== reward.minScore ||
      next.label !== reward.label ||
      next.percentOff !== reward.percentOff ||
      (next.code ?? "") !== (reward.code ?? "");
    if (!changed) return;
    // `code` is always sent, including as undefined: the page spreads this
    // patch over the stored tier, so an omitted key would leave a code the
    // merchant just cleared in place.
    onCommit({
      minScore: next.minScore,
      label: next.label,
      percentOff: next.percentOff,
      code: next.code,
    });
  }

  const minScoreError = issueFor("minScore");
  const percentOffError = issueFor("percentOff");
  const labelError = issueFor("label");
  const codeError = issueFor("code");
  // Only confirm when there is another tier to fall back to: removing the one
  // and only tier is the documented "no rewards" configuration, not a trap.
  const confirmBeforeRemove = isBaseline && otherMinScores.length > 0;

  return (
    <div className="rounded-lg border border-border p-2.5">
      {/* Three lines rather than one: the panel is a fixed 360px track, which
          left the old single-row Label field about 130px — a dozen characters
          of "20% off your first order". */}
      <div className="flex items-start gap-2">
        <div className="w-20 shrink-0">
          <Field label="Min score" htmlFor={minScoreId} error={minScoreError}>
            <input
              id={minScoreId}
              type="number"
              min={0}
              max={maxScore}
              step={1}
              value={minScore}
              onChange={(e) => setMinScore(e.target.value)}
              onBlur={commit}
              aria-invalid={Boolean(minScoreError)}
              aria-describedby={describedBy(minScoreError && errorIdFor(minScoreId))}
              className={FIELD_CONTROL_CLASS}
            />
          </Field>
        </div>
        <div className="w-16 shrink-0">
          <Field label="% off" htmlFor={percentOffId} error={percentOffError}>
            <input
              id={percentOffId}
              type="number"
              min={PERCENT_OFF_MIN}
              max={PERCENT_OFF_MAX}
              step={1}
              placeholder="—"
              value={percentOff}
              onChange={(e) => setPercentOff(e.target.value)}
              onBlur={commit}
              aria-invalid={Boolean(percentOffError)}
              aria-describedby={describedBy(percentOffError && errorIdFor(percentOffId))}
              className={FIELD_CONTROL_CLASS}
            />
          </Field>
        </div>
        <button
          type="button"
          onClick={() =>
            confirmBeforeRemove && !confirmingRemove ? setConfirmingRemove(true) : onRemove()
          }
          aria-label={
            confirmingRemove
              ? `Confirm removing reward tier ${index + 1}`
              : `Remove reward tier ${index + 1}`
          }
          className="ml-auto mt-5 rounded-md px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
        >
          {confirmingRemove ? "Remove the baseline tier?" : "Remove tier"}
        </button>
      </div>
      {confirmingRemove && (
        <p className="mt-1 text-xs text-muted">
          Players scoring below the next tier will see no reward.
        </p>
      )}

      <div className="mt-2 min-w-0">
        <Field label="Label" htmlFor={labelId} error={labelError}>
          <input
            id={labelId}
            value={label}
            maxLength={REWARD_LABEL_MAX}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={commit}
            aria-invalid={Boolean(labelError)}
            aria-describedby={describedBy(labelError && errorIdFor(labelId))}
            className={FIELD_CONTROL_CLASS}
          />
        </Field>
      </div>

      {/* Keyed off the STORED percentOff, matching mount.ts's own condition
          for printing a code — a code typed into a tier being edited back to
          "no discount" would never be shown to anyone. */}
      {reward.percentOff != null && (
        <div className="mt-2 min-w-0">
          <Field
            label="Discount code"
            htmlFor={codeId}
            hint={
              code.trim() === ""
                ? "Leave blank and PlayLoop shows each winner a randomly generated placeholder code that isn't redeemable in your store."
                : undefined
            }
            error={codeError}
          >
            <input
              id={codeId}
              value={code}
              maxLength={REWARD_CODE_MAX}
              onChange={(e) => setCode(e.target.value)}
              onBlur={() => {
                // Display-only: normalizeRewardTier uppercases on the way to
                // the server regardless.
                setCode(code.trim().toUpperCase());
                commit();
              }}
              aria-invalid={Boolean(codeError)}
              aria-describedby={describedBy(
                code.trim() === "" && hintIdFor(codeId),
                codeError && errorIdFor(codeId),
              )}
              className={FIELD_CONTROL_CLASS}
            />
          </Field>
        </div>
      )}

      <button
        type="button"
        onClick={onPreview}
        aria-pressed={previewing}
        className={`mt-2 rounded-md px-2 py-1 text-xs font-medium ${
          previewing ? "text-primary" : "text-muted hover:text-foreground"
        }`}
      >
        {previewing ? "Previewing this tier" : "Preview this tier"}
      </button>

      {/* Only a tier that actually discounts something gets a coupon pool.
          A percentOff of null is the "thanks for playing" tier — the runtime
          renders no code block for it (see renderCouponBlock's call site in
          lib/runtime/mount.ts), so offering the merchant an inventory to
          stock would promise a handover that never happens. */}
      {reward.percentOff != null && (
        <CouponManager
          gameId={gameId}
          tierIndex={index}
          tier={reward}
          onCommitTerms={(coupon) => onCommit({ coupon: coupon ?? undefined })}
        />
      )}
    </div>
  );
}

/**
 * Difficulty and round length, driven entirely by the template's own
 * `capability.tuning` block: compose.ts populates spec.tuning from it,
 * mount.ts re-clamps to the same min/max, and every game module reads the
 * values each frame. Nothing surfaced them, so the two most obvious settings
 * in a mini-game product — how long a round runs, how hard it plays —
 * previously required re-running generation to change.
 */
function TuningSection({
  spec,
  patchSpec,
}: {
  spec: GameSpec;
  patchSpec: (build: PatchBuilder, label: string) => Promise<void>;
}) {
  const capability = getCapability(spec.template);
  const baseId = useId();
  /** Held while a slider is being dragged, so a drag doesn't PATCH per pixel. */
  const [draft, setDraft] = useState<Record<string, number>>({});

  // Drops only the keys the server has caught up with — the same shape as the
  // page's copyDraft, and for the same reason: an unrelated save must not snap
  // a slider back out from under the cursor.
  useEffect(() => {
    setDraft((d) => {
      const next = Object.fromEntries(
        Object.entries(d).filter(([key, value]) => spec.tuning[key] !== value),
      );
      return Object.keys(next).length === Object.keys(d).length ? d : next;
    });
  }, [spec.tuning]);

  const entries = capability ? Object.entries(capability.tuning) : [];
  // A reserved template has no registered capability, so there is no tuning
  // schema to derive a range from and nothing honest to render.
  if (entries.length === 0) return null;

  return (
    <EditorSection
      icon={<ControllerIcon className="h-4 w-4" />}
      title="Difficulty & length"
      description="How long a round runs and how hard it plays"
      defaultOpen
    >
      <div className="space-y-3">
        {entries.map(([key, range]) => {
          const field = tuningField(key);
          const inputId = `${baseId}-${key}`;
          const committed = spec.tuning[key] ?? range.default;
          const value = draft[key] ?? committed;
          const commit = () => {
            if (value === committed) return;
            void patchSpec(
              (cur) => ({
                tuning: { ...cur.tuning, [key]: value },
                // durationSeconds is not redundant with tuning.durationSec:
                // mount.ts does prefer the tuning value, but finishPlay
                // derives its minimum-plausible-play-time floor from
                // durationSeconds alone, so leaving it stale would flag
                // legitimate plays of a shortened game as forged.
                ...(key === "durationSec" ? { durationSeconds: value } : {}),
              }),
              field.label,
            );
          };
          return (
            <Field key={key} label={field.label} htmlFor={inputId}>
              <div className="mt-1 flex items-center gap-2">
                <input
                  id={inputId}
                  type="range"
                  min={range.min}
                  max={range.max}
                  step={field.step}
                  value={value}
                  aria-valuetext={field.format(value)}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setDraft((d) => ({ ...d, [key]: next }));
                  }}
                  onPointerUp={commit}
                  onKeyUp={commit}
                  onBlur={commit}
                  className="h-9 min-w-0 flex-1 accent-primary"
                />
                {/* aria-hidden: aria-valuetext already carries the formatted
                    value, and anything inside the <label> would otherwise join
                    the slider's accessible name. */}
                <span
                  aria-hidden="true"
                  className="w-12 shrink-0 text-right font-mono text-xs text-muted"
                >
                  {field.format(value)}
                </span>
              </div>
            </Field>
          );
        })}
      </div>
    </EditorSection>
  );
}

/**
 * Replaces the old flat "every asset in one list" editor with one section
 * per capability role (collectible/catcher/hazard/etc.) — the point being
 * that customisation should work the way the matcher itself thinks about
 * assets: assigned to a specific role, not just "in the pile". Lets you
 * unassign without deleting, reuse an already-uploaded image in a different
 * role, or upload straight into a role that's currently empty (e.g. add
 * hazards to a Catch game the auto-match left without any).
 */
function RoleImagesEditor({
  spec,
  patchSpec,
}: {
  /** Render-only. Every mutator below builds its patch from the builder's own
   * `cur` argument instead, so an assignment made while another save is still
   * in flight composes with it rather than reverting it. */
  spec: GameSpec;
  patchSpec: (build: PatchBuilder, label: string) => Promise<void>;
}) {
  const capability = getCapability(spec.template);

  function unassignFromRole(roleId: string, assetId: string) {
    void patchSpec(
      (cur) => ({
        roles: {
          ...cur.roles,
          [roleId]: roleAssetIds(cur, roleId).filter((id) => id !== assetId),
        },
      }),
      `Images for ${humanRoleLabel(roleId)}`,
    );
  }

  function assignExistingToRole(roleId: string, assetId: string) {
    void patchSpec((cur) => {
      const ids = roleAssetIds(cur, roleId);
      return {
        roles: { ...cur.roles, [roleId]: ids.includes(assetId) ? ids : [...ids, assetId] },
      };
    }, `Images for ${humanRoleLabel(roleId)}`);
  }

  function addNewAssetToRole(roleId: string, asset: ProcessedAsset) {
    void patchSpec(
      (cur) => ({
        assets: [...cur.assets, asset],
        roles: { ...cur.roles, [roleId]: [...roleAssetIds(cur, roleId), asset.id] },
      }),
      `Images for ${humanRoleLabel(roleId)}`,
    );
  }

  // Clearing the treatment metadata is the point of this function, not
  // tidiness: presentation, backgroundColor, backgroundTreatment,
  // subjectBounds and colorAdjust all describe the pixels of the image being
  // REPLACED. chainPop.ts uses subjectBounds as the drawImage source rect and
  // backgroundColor as the chip fill (shooter.ts likewise), so carrying them
  // over would crop a different photograph to a rectangle measured on the old
  // one — exactly the "crop into the subject" failure the contract forbids.
  // Absent presentation means "treat as isolated" and absent subjectBounds
  // means "the whole frame is subject": the documented safe defaults. id,
  // data and every role assignment survive, so a swap stays a swap.
  function swapAsset(assetId: string, url: string, name: string) {
    void patchSpec(
      (cur) => ({
        assets: cur.assets.map((a) =>
          a.id === assetId
            ? {
                ...a,
                spriteUrl: url,
                presentation: undefined,
                backgroundColor: undefined,
                backgroundTreatment: undefined,
                subjectBounds: undefined,
                colorAdjust: undefined,
              }
            : a,
        ),
      }),
      `Image for ${name}`,
    );
  }

  /** An explicitly-undefined value clears the key: the builder replaces the
   * whole assets array and undefined drops out of the JSON body. */
  function updateAssetData(
    assetId: string,
    patch: { name?: string; priceMinor?: number },
    label: string,
  ) {
    void patchSpec(
      (cur) => ({
        assets: cur.assets.map((a) =>
          a.id === assetId ? { ...a, data: { ...a.data, ...patch } } : a,
        ),
      }),
      label,
    );
  }

  // Strips the asset from every role's assignment list too, not just
  // spec.assets — the old flat "Remove" left a dangling id in spec.roles,
  // which mount.ts's resolveRoles() silently drops (loadAsset never finds
  // it) rather than erroring, so the bug was invisible but real.
  function deleteAssetEverywhere(assetId: string) {
    void patchSpec(
      (cur) => ({
        assets: cur.assets.filter((a) => a.id !== assetId),
        roles: Object.fromEntries(
          Object.entries(cur.roles).map(([roleId, entry]) => [
            roleId,
            Array.isArray(entry) ? entry.filter((id) => id !== assetId) : entry,
          ]),
        ),
      }),
      "Images",
    );
  }

  if (!capability) {
    // Reserved/unimplemented template — degrade to a flat list rather than
    // crash; there's no role schema to group by, and therefore no role a
    // deletion could break, so nothing here is guarded.
    return (
      <ul className="space-y-2">
        {spec.assets.map((asset) => (
          <LooseAssetRow
            key={asset.id}
            asset={asset}
            deleteReason={null}
            onSwap={(url) => swapAsset(asset.id, url, asset.data?.name ?? asset.id)}
            onDelete={() => deleteAssetEverywhere(asset.id)}
          />
        ))}
      </ul>
    );
  }

  const allAssignedIds = new Set(
    Object.values(spec.roles).flatMap((entry) => (Array.isArray(entry) ? entry : [])),
  );
  const unassigned = spec.assets.filter((a) => !allAssignedIds.has(a.id));
  // guess_price declares data.required: ["priceMinor"] and guessPrice.ts
  // filters the hero pool down to assets that have one, so an unpriced hero is
  // listed, counted and never seen — and if it is the only hero, the round
  // order is empty and the game ends instantly at 0. Pricing belongs on the
  // row that added the image, not back through generation.
  const requiresPrice = capability.data.required.includes("priceMinor");

  return (
    <div className="space-y-4">
      {capability.roles.map((role, i) => {
        // What the RUNTIME will play with, not what the array happens to
        // contain: a dangling id or an asset missing this capability's
        // required data counts for nothing on screen, so it counts for
        // nothing here either.
        const playable = playableAssetsForRole(spec, capability, role.id);
        const assigned = roleAssetIds(spec, role.id)
          .map((id) => spec.assets.find((a) => a.id === id))
          .filter((a): a is ProcessedAsset => Boolean(a));
        const atMax = assigned.length >= role.count.max;
        const needsAttention = !roleIsSatisfied(spec, capability, role);
        const roleLabel = humanRoleLabel(role.id);
        const unassignReason = unassignBlockedReason(capability, role, playable.length);

        return (
          <div key={role.id} className={i > 0 ? "border-t border-border pt-4" : ""}>
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-medium capitalize">{roleLabel}</h3>
              <span
                className={`text-xs ${needsAttention ? "font-medium text-warning" : "text-muted"}`}
              >
                {playable.length}/{role.count.max}
                {role.optional ? " · optional" : ""}
              </span>
            </div>
            <p className="text-xs text-muted">{role.purpose}</p>

            {assigned.length > 0 && (
              <ul className="mt-2 space-y-2">
                {assigned.map((asset) => (
                  <AssignedAssetRow
                    key={asset.id}
                    asset={asset}
                    roleLabel={roleLabel}
                    requiresPrice={requiresPrice}
                    unassignReason={unassignReason}
                    onSwap={(url) => swapAsset(asset.id, url, asset.data?.name ?? asset.id)}
                    onUnassign={() => unassignFromRole(role.id, asset.id)}
                    onCommitData={(patch) =>
                      updateAssetData(
                        asset.id,
                        patch,
                        `Details for ${asset.data?.name ?? asset.id}`,
                      )
                    }
                  />
                ))}
              </ul>
            )}
            {assigned.length === 0 && (
              <p className="mt-2 text-xs text-muted">No image assigned yet.</p>
            )}

            {!atMax && (
              <div className="mt-3 flex flex-col items-start gap-2 border-t border-border pt-3">
                {unassigned.length > 0 && (
                  <select
                    defaultValue=""
                    // Several of these sit one above the other and its only
                    // name-like text is a disabled placeholder option, which
                    // is option content, not an accessible name. Naming it
                    // after the role alone ("collectible") is the ambiguity
                    // being fixed, so the label says what the control does.
                    aria-label={`Assign an existing image to ${roleLabel}`}
                    onChange={(e) => {
                      if (e.target.value) assignExistingToRole(role.id, e.target.value);
                      e.target.value = "";
                    }}
                    // min-w-0/max-w-full stop a long filename in an <option>
                    // blowing the select out past the 360px panel track.
                    className={`${FIELD_CONTROL_CLASS} min-w-0 max-w-full`}
                  >
                    <option value="" disabled>
                      + Use an unassigned image…
                    </option>
                    {unassigned.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.data?.name ?? a.id}
                      </option>
                    ))}
                  </select>
                )}
                <AddImageButton
                  roleId={role.id}
                  onUploaded={(asset) => addNewAssetToRole(role.id, asset)}
                />
              </div>
            )}
          </div>
        );
      })}

      {unassigned.length > 0 && (
        <div className="rounded-xl border border-dashed border-border p-3">
          <h3 className="text-sm font-medium">Not used in any role</h3>
          <p className="text-xs text-muted">Assign these above, or remove them for good.</p>
          <ul className="mt-2 space-y-2">
            {unassigned.map((asset) => (
              <LooseAssetRow
                key={asset.id}
                asset={asset}
                dimmed
                // Always null in practice for a genuinely unassigned asset —
                // computed anyway so the guard travels with the control
                // rather than with the caller's assumption about it.
                deleteReason={deleteBlockedReason(spec, capability, asset.id)}
                onDelete={() => deleteAssetEverywhere(asset.id)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One assigned image: the swap/unassign pair, plus the name and price the
 * runtime needs when the template's capability requires them. */
function AssignedAssetRow({
  asset,
  roleLabel,
  requiresPrice,
  unassignReason,
  onSwap,
  onUnassign,
  onCommitData,
}: {
  asset: ProcessedAsset;
  roleLabel: string;
  /** The capability declares data.required: ["priceMinor"] — see
   * RoleImagesEditor for why an unpriced asset is worse than a missing one. */
  requiresPrice: boolean;
  /** Non-null when unassigning would drop a hard-required role below its
   * minimum. Rendered visibly as well as via title: a greyed-out control with
   * no stated reason is its own defect. */
  unassignReason: string | null;
  onSwap: (url: string) => void;
  onUnassign: () => void;
  onCommitData: (patch: { name?: string; priceMinor?: number }) => void;
}) {
  const baseId = useId();
  const nameId = `${baseId}-name`;
  const priceId = `${baseId}-price`;
  const reasonId = `${baseId}-reason`;
  const displayName = asset.data?.name ?? asset.id;
  const storedName = asset.data?.name ?? "";
  const storedPrice = asset.data?.priceMinor;

  const [name, setName] = useState(storedName);
  const [price, setPrice] = useState(storedPrice === undefined ? "" : String(storedPrice));
  const [priceError, setPriceError] = useState<string | null>(null);

  useEffect(() => {
    const nextName = asset.data?.name ?? "";
    const nextPrice = asset.data?.priceMinor;
    setName(nextName);
    setPrice(nextPrice === undefined ? "" : String(nextPrice));
  }, [asset]);

  function commitName() {
    const next = name.trim();
    if (next === storedName) return;
    onCommitData({ name: next === "" ? undefined : next });
  }

  function commitPrice() {
    const raw = price.trim();
    if (raw === "") {
      setPriceError(null);
      if (storedPrice !== undefined) onCommitData({ priceMinor: undefined });
      return;
    }
    const parsed = Number(raw);
    // Money is integer minor units everywhere in this codebase, never floats —
    // a fraction or a negative typed here has to be refused, not rounded into
    // the spec where something downstream decides what it meant.
    if (!Number.isInteger(parsed) || parsed < 0) {
      setPriceError("Whole minor units only — 1999 for £19.99.");
      return;
    }
    setPriceError(null);
    if (parsed !== storedPrice) onCommitData({ priceMinor: parsed });
  }

  return (
    <li className={requiresPrice ? "rounded-lg border border-border p-2" : ""}>
      <div className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={asset.spriteUrl}
          alt={displayName}
          className="h-10 w-10 rounded-lg border border-border object-contain"
        />
        <span className="flex-1 truncate text-sm">{displayName}</span>
        <SwapButton assetId={asset.id} name={displayName} onUploaded={onSwap} />
        <button
          type="button"
          disabled={Boolean(unassignReason)}
          title={unassignReason ?? undefined}
          // Every role renders a row of identically-labelled buttons and the
          // name beside them is a sibling, not part of any accessible name.
          aria-label={`Unassign ${displayName} from ${roleLabel}`}
          aria-describedby={unassignReason ? reasonId : undefined}
          onClick={onUnassign}
          className="shrink-0 rounded-md text-xs text-muted underline hover:text-foreground disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50"
        >
          Unassign
        </button>
      </div>
      {unassignReason && (
        <p id={reasonId} className="mt-1 text-xs text-muted">
          {unassignReason}
        </p>
      )}

      {requiresPrice && (
        <>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Field label="Name" htmlFor={nameId}>
              <input
                id={nameId}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={commitName}
                className={FIELD_CONTROL_CLASS}
              />
            </Field>
            <Field label="Price (minor units)" htmlFor={priceId} error={priceError}>
              <input
                id={priceId}
                type="number"
                min={0}
                step={1}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                onBlur={commitPrice}
                aria-invalid={Boolean(priceError)}
                aria-describedby={describedBy(priceError && errorIdFor(priceId))}
                className={FIELD_CONTROL_CLASS}
              />
            </Field>
          </div>
          {/* Flagged, not blocked: the merchant can add the image and price it
              in the same row rather than being stopped at the upload. */}
          {storedPrice === undefined && (
            <p className="mt-1 text-xs text-warning">Won&rsquo;t appear in play — needs a price.</p>
          )}
        </>
      )}
    </li>
  );
}

/** An image that belongs to no role — either because the template has no role
 * schema at all, or because it was unassigned. Delete is the only destructive
 * action in this editor with no undo, so it is the only one that confirms. */
function LooseAssetRow({
  asset,
  dimmed = false,
  deleteReason,
  onSwap,
  onDelete,
}: {
  asset: ProcessedAsset;
  dimmed?: boolean;
  deleteReason: string | null;
  onSwap?: (url: string) => void;
  onDelete: () => void;
}) {
  const reasonId = useId();
  const displayName = asset.data?.name ?? asset.id;
  return (
    <li className="flex items-center gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={asset.spriteUrl}
        alt={displayName}
        className={`h-10 w-10 rounded-lg border border-border object-contain ${
          dimmed ? "opacity-60" : ""
        }`}
      />
      <span className={`flex-1 truncate text-sm ${dimmed ? "text-muted" : ""}`}>{displayName}</span>
      {onSwap && <SwapButton assetId={asset.id} name={displayName} onUploaded={onSwap} />}
      <ConfirmRemoveButton
        ariaLabel={`Delete ${displayName} from this game`}
        disabledReason={deleteReason}
        describedById={deleteReason ? reasonId : undefined}
        onConfirm={onDelete}
      />
      {deleteReason && (
        <p id={reasonId} className="sr-only">
          {deleteReason}
        </p>
      )}
    </li>
  );
}

/**
 * A destructive control that means it. The first click arms it and swaps the
 * label; the second commits. In-place rather than window.confirm so it wears
 * the app's own tokens and can't be suppressed by the browser — and because
 * this action (drop the asset from spec.assets AND from every role at once)
 * has no undo, while the visually identical "Unassign" beside it is fully
 * reversible.
 */
function ConfirmRemoveButton({
  ariaLabel,
  disabledReason,
  describedById,
  onConfirm,
}: {
  ariaLabel: string;
  disabledReason: string | null;
  describedById?: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      disabled={Boolean(disabledReason)}
      title={disabledReason ?? undefined}
      aria-label={armed ? `Confirm: ${ariaLabel}` : ariaLabel}
      aria-describedby={describedById}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
      // Moving on disarms it, so a half-pressed control can't be committed by
      // a click that lands on it minutes later.
      onBlur={() => setArmed(false)}
      className={DESTRUCTIVE_BUTTON_CLASS}
    >
      {armed ? "Remove for good?" : "Remove"}
    </button>
  );
}

function AddImageButton({
  roleId,
  onUploaded,
}: {
  roleId: string;
  onUploaded: (asset: ProcessedAsset) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = (await res.json()) as { assets?: { id: string; url: string; name: string }[] };
      const uploaded = data.assets?.[0];
      if (res.ok && uploaded) {
        onUploaded({
          id: uploaded.id,
          spriteUrl: uploaded.url,
          width: 256,
          height: 256,
          // 0 means "not measured", not "almost empty". /api/upload doesn't
          // run the pipeline's sprite processing, so there is no real
          // coverage to record — and a fabricated 0.6 read as a measurement
          // something downstream could act on. Nothing in lib/runtime reads
          // coverage, so an honest zero costs nothing today. Giving the
          // upload route a processSprites path (which would also yield real
          // width/height, subjectBounds and presentation) is the durable fix
          // and is deliberately left as server-side follow-up work.
          coverage: 0,
          // `presentation` is left absent on purpose: absent means "isolated",
          // which is the conservative path — scale the whole image in, never
          // crop — for an image whose backdrop was never sampled.
          //
          // Same convention manual-mode build uses (build/manual/page.tsx):
          // no quality-gate phash for an editor-added image, just a stable
          // per-asset placeholder.
          phash: `manual_${uploaded.id}`,
          score: 1,
          flags: [],
          data: { name: uploaded.name || undefined },
        });
      }
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  // The input is a PRECEDING SIBLING of its label, not a child: Tailwind's
  // `peer-*` variants compile to a sibling combinator, so a nested input can
  // never style its own label. `htmlFor`/`id` keeps click behaviour identical
  // either way. `sr-only` rather than `hidden` because display:none removes
  // the input from the tab order and the a11y tree both, which made the whole
  // image-customization path mouse-only with no error and no visible reason.
  return (
    <span className="inline-flex">
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept="image/*"
        aria-label={`Upload a new image for ${humanRoleLabel(roleId)}`}
        disabled={busy}
        aria-busy={busy}
        className="peer sr-only"
        onChange={handleChange}
      />
      <label
        htmlFor={inputId}
        className={`cursor-pointer rounded-md border border-dashed border-border px-2 py-1 text-xs font-medium text-primary hover:border-primary/40 ${PEER_FOCUS_RING_CLASS}`}
      >
        {busy ? "Uploading…" : "+ Upload new"}
      </label>
    </span>
  );
}

function LogoUploadButton({ onUploaded }: { onUploaded: (url: string) => void }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = (await res.json()) as { assets?: { url: string }[] };
      if (res.ok && data.assets?.[0]) onUploaded(data.assets[0].url);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <span className="inline-flex">
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept="image/*"
        aria-label="Upload a replacement logo"
        disabled={busy}
        aria-busy={busy}
        className="peer sr-only"
        onChange={handleChange}
      />
      <label
        htmlFor={inputId}
        className={`cursor-pointer rounded-md px-1 text-xs font-medium text-primary underline underline-offset-4 ${PEER_FOCUS_RING_CLASS}`}
      >
        {busy ? "Uploading…" : "Change logo"}
      </label>
    </span>
  );
}

function SwapButton({
  assetId,
  name,
  onUploaded,
}: {
  assetId: string;
  /** What the merchant sees this image called — "Swap" alone names nothing,
   * and several of these render in a column. */
  name: string;
  onUploaded: (url: string) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = (await res.json()) as { assets?: { url: string }[] };
      if (res.ok && data.assets?.[0]) onUploaded(data.assets[0].url);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <span className="inline-flex shrink-0">
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept="image/*"
        aria-label={`Replace image for ${name}`}
        // aria-busy rather than relying on the visible "…", which names
        // nothing to a screen reader.
        disabled={busy}
        aria-busy={busy}
        className="peer sr-only"
        onChange={handleChange}
        data-asset-id={assetId}
      />
      <label
        htmlFor={inputId}
        className={`cursor-pointer rounded-md px-1 text-xs font-medium text-primary underline underline-offset-4 ${PEER_FOCUS_RING_CLASS}`}
      >
        {busy ? "…" : "Swap"}
      </label>
    </span>
  );
}
