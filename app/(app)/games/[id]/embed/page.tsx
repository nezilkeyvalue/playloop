// app/(app)/games/[id]/embed/page.tsx
//
// Placement picker (only placements the template supports, via
// supportsPlacement) + size + trigger controls + publish button + a live
// preview of the real embed + copyable embed snippet + raw iframe fallback
// (spec §14, §15).
"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { AuthGate } from "@/components/AuthGate";
import { GameSubNav } from "@/components/GameSubNav";
import {
  ChevronIcon,
  CursorClickIcon,
  ExpandIcon,
  LayersIcon,
  PaletteIcon,
  ResizeIcon,
} from "@/components/EditorIcons";
import {
  findIncompleteRoles,
  getCapability,
  supportsPlacement,
} from "@/lib/capabilities";
import type { RoleGap } from "@/lib/capabilities";
import {
  DEFAULT_MODAL_TRIGGER_LABEL,
  DEFAULT_TRIGGER_BG_COLOR,
  DEFAULT_TRIGGER_TEXT_COLOR,
  buildEmbedSnippet,
  buildIframeFallback,
  type ModalTrigger,
  type TriggerAnimation,
  type TriggerButtonStyle,
  type TriggerPosition,
  type TriggerShadow,
  type TriggerStyle,
  type TriggerTextSize,
} from "@/lib/engine/embedSnippet";
import type { GameCapability, GameRecord, Placement } from "@/lib/engine/types";

const PLACEMENT_LABELS: Record<Placement, string> = {
  section: "In-page section",
  fullpage: "Full page",
  modal: "Modal",
  ad: "Ad unit",
};

const PLACEMENT_HINTS: Record<Placement, string> = {
  section: "Sits inline in the page, full width of its container.",
  fullpage: "Same as a section, but fills at least the visitor's screen height.",
  modal: "Hidden behind a trigger; opens the game in an overlay.",
  ad: "Fixed ad-unit dimensions.",
};

const PLACEMENT_ICONS: Record<Placement, ReactNode> = {
  section: <LayersIcon className="h-4 w-4" />,
  fullpage: <ExpandIcon className="h-4 w-4" />,
  modal: <CursorClickIcon className="h-4 w-4" />,
  ad: <ResizeIcon className="h-4 w-4" />,
};

const BUTTON_TEXT_SIZES: [TriggerTextSize, string][] = [
  ["sm", "Small"],
  ["md", "Medium"],
  ["lg", "Large"],
];

const BUTTON_SHADOWS: [TriggerShadow, string][] = [
  ["none", "None"],
  ["soft", "Soft"],
  ["medium", "Medium"],
  ["strong", "Strong"],
];

/** Emoji preview lives here purely as a swatch in the picker UI — the actual
 * glyph rendered on a merchant's page is embed.js's own choice
 * (mountModal's icon.textContent), kept in sync by hand since this list
 * only ever grows one predefined animation at a time. */
const BUTTON_ANIMATIONS: [TriggerAnimation, string, string | null][] = [
  ["none", "None", null],
  ["pulse", "Pulse", null],
  ["bounce", "Bounce", null],
  ["shake", "Shake", null],
  ["spin-football", "Spinning football", "⚽"],
  ["spin-star", "Spinning star", "⭐"],
];

const MIN_CUSTOM_WIDTH = 240;
const MAX_CUSTOM_WIDTH = 1200;
const MIN_CUSTOM_HEIGHT = 240;
const MAX_CUSTOM_HEIGHT = 1400;

/** Seeds the custom-size inputs from the template's own capability
 * constraint whenever a merchant turns "Custom size" on, or switches
 * placement while it's already on — a fresh, plausible starting point for
 * THIS template/placement rather than carrying over a number that made
 * sense for a different one (a modal's 460px default width is a bad seed
 * for a "fullpage" section). */
function defaultSizeFor(
  capability: GameCapability | undefined,
  placement: Placement,
): { width: number; height: number } {
  const constraint = capability?.placements[placement];
  const width = Math.max(constraint?.minWidth ?? 420, MIN_CUSTOM_WIDTH);
  const aspect = constraint?.preferredAspect ?? 0.75;
  const height = Math.max(Math.round(width * aspect), MIN_CUSTOM_HEIGHT);
  return { width, height };
}

/** "3 more collectible images", joined when a template is short on two roles. */
function describeGaps(gaps: RoleGap[]): string {
  return gaps
    .map((gap) => {
      const missing = Math.max(0, gap.need - gap.have);
      return `${missing} more ${gap.label} image${missing === 1 ? "" : "s"}`;
    })
    .join(" and ");
}

function incompleteMessage(gaps: RoleGap[]): string {
  if (gaps.length === 0) return "This game isn't ready to publish.";
  return `This game isn't ready to publish. Add ${describeGaps(gaps)} in the editor first.`;
}

/** The publish route answers with a machine code the merchant can act on;
 * collapsing every non-OK response to "Could not publish." threw that away —
 * an incomplete game and a dead game read identically and neither told the
 * merchant what to do next. */
function publishErrorMessage(body: { error?: string; gaps?: RoleGap[] } | null): string {
  switch (body?.error) {
    case "incomplete_roles":
      return incompleteMessage(body.gaps ?? []);
    case "unsupported_placement":
      return "This template doesn't support that placement.";
    case "not_found":
      return "This game no longer exists — reload the page.";
    default:
      return "Could not publish.";
  }
}

export default function EmbedPage() {
  return (
    <AuthGate title="Sign in to get your embed code" description="These pages show one game's spec, stats and embed code. Sign in to the account that owns it.">
      <EmbedPanel />
    </AuthGate>
  );
}

function EmbedPanel() {
  const { id } = useParams<{ id: string }>();
  const [game, setGame] = useState<GameRecord | null>(null);
  const [placement, setPlacement] = useState<Placement>("section");
  const [triggerLabel, setTriggerLabel] = useState(DEFAULT_MODAL_TRIGGER_LABEL);
  const [triggerMode, setTriggerMode] = useState<ModalTrigger>("click");
  const [triggerStyle, setTriggerStyle] = useState<TriggerStyle>("inline");
  const [triggerPosition, setTriggerPosition] = useState<TriggerPosition>("bottom-right");
  const [btnTextSize, setBtnTextSize] = useState<TriggerTextSize>("md");
  const [btnTextColor, setBtnTextColor] = useState(DEFAULT_TRIGGER_TEXT_COLOR);
  const [btnBgColor, setBtnBgColor] = useState(DEFAULT_TRIGGER_BG_COLOR);
  const [btnShadow, setBtnShadow] = useState<TriggerShadow>("medium");
  const [btnGlow, setBtnGlow] = useState(false);
  const [btnAnimation, setBtnAnimation] = useState<TriggerAnimation>("none");
  const [sizeMode, setSizeMode] = useState<"auto" | "custom">("auto");
  const [customWidth, setCustomWidth] = useState(480);
  const [customHeight, setCustomHeight] = useState(600);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/games/${id}?full=1`, { cache: "no-store" })
      .then((res) => res.json())
      .then((g: GameRecord) => {
        setGame(g);
        setPlacement(g.placement ?? "section");
        if (g.slug) setSlug(g.slug);
      });
  }, [id]);

  const capability = useMemo(
    () => (game ? getCapability(game.spec.template) : undefined),
    [game],
  );
  // The editor is where images are assigned, so this page can only report the
  // shortfall — the publish route enforces it (publish/route.ts).
  const gaps = useMemo(() => (game ? findIncompleteRoles(game.spec) : []), [game]);
  const supportedPlacements = useMemo(
    () =>
      capability
        ? (Object.keys(PLACEMENT_LABELS) as Placement[]).filter((p) =>
            supportsPlacement(capability, p),
          )
        : [],
    [capability],
  );

  // Fresh, plausible defaults every time the placement changes — see
  // defaultSizeFor's doc comment. Only affects what "Custom size" SHOWS;
  // whether it's actually applied depends on sizeMode.
  useEffect(() => {
    const seed = defaultSizeFor(capability, placement);
    setCustomWidth(seed.width);
    setCustomHeight(seed.height);
  }, [capability, placement]);

  const heightApplies = placement !== "fullpage";
  const width = sizeMode === "custom" ? customWidth : undefined;
  const height = sizeMode === "custom" && heightApplies ? customHeight : undefined;

  // Memoized so EmbedPreview's rebuild effect (keyed on this object) only
  // fires when a button-style value actually changes, not on every render.
  const buttonStyle = useMemo<TriggerButtonStyle>(
    () => ({
      textSize: btnTextSize,
      textColor: btnTextColor,
      bgColor: btnBgColor,
      shadow: btnShadow,
      glow: btnGlow,
      animation: btnAnimation,
    }),
    [btnTextSize, btnTextColor, btnBgColor, btnShadow, btnGlow, btnAnimation],
  );

  // Recomputed from local state rather than pinned to whatever the last
  // publish response said: the snippet is self-describing (it carries its
  // own data-*), so a merchant previewing a different placement/size/trigger
  // sees the real code immediately, without needing to republish just to see
  // what it would look like. /play/[slug] honors data-placement's forwarded
  // ?placement= as long as the template supports it (see PlayPage in
  // app/play/[slug]/page.tsx) — republishing only changes the DB's OWN
  // default/fallback placement.
  const appUrl = typeof window !== "undefined" ? window.location.origin : "https://playloop.app";
  const embedSnippet =
    game && slug
      ? buildEmbedSnippet({
          slug,
          template: game.spec.template,
          placement,
          appUrl,
          triggerLabel,
          trigger: triggerMode,
          triggerStyle,
          triggerPosition,
          buttonStyle,
          width,
          height,
        })
      : null;

  async function handlePublish() {
    setPublishing(true);
    setError(null);
    try {
      const res = await fetch(`/api/games/${id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ placement }),
      });
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => null)) as { error?: string; gaps?: RoleGap[] } | null;
        setError(publishErrorMessage(body));
        return;
      }
      const data = (await res.json()) as { slug: string; embed: string };
      setSlug(data.slug);
      setGame((prev) => (prev ? { ...prev, placement, status: "published", slug: data.slug } : prev));
    } catch {
      setError("Could not publish.");
    } finally {
      setPublishing(false);
    }
  }

  function copy(text: string, key: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  if (!game) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <GameSubNav gameId={id} />
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Publish &amp; embed</h1>
        <p className="mt-1 text-sm text-muted">
          Choose how this game sits on your site, then copy the snippet onto the page.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
        {/* --- settings column ------------------------------------------- */}
        <div className="space-y-4">
          <EditorSection
            icon={<LayersIcon className="h-4 w-4" />}
            title="Placement"
            description="Where and how the game appears on your page"
            defaultOpen
          >
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {supportedPlacements.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPlacement(p)}
                  aria-pressed={placement === p}
                  className={`flex flex-col items-start gap-1.5 rounded-xl border px-3.5 py-3 text-left text-sm transition ${
                    placement === p
                      ? "border-transparent bg-primary text-primary-foreground shadow-elevated"
                      : "border-border hover:border-primary/30"
                  }`}
                >
                  <span
                    className={`flex h-7 w-7 items-center justify-center rounded-full ${
                      placement === p ? "bg-white/15" : "bg-foreground/[0.06]"
                    }`}
                  >
                    {PLACEMENT_ICONS[p]}
                  </span>
                  <span className="font-medium">{PLACEMENT_LABELS[p]}</span>
                </button>
              ))}
            </div>
            {supportedPlacements.length === 0 && (
              <p className="mt-2 text-sm text-muted">
                No placements available for this template yet.
              </p>
            )}
            {supportedPlacements.includes(placement) && (
              <p className="mt-3 text-xs text-muted">{PLACEMENT_HINTS[placement]}</p>
            )}
          </EditorSection>

          <EditorSection
            icon={<ResizeIcon className="h-4 w-4" />}
            title="Size"
            description={
              sizeMode === "auto" ? "Responsive — fills its container" : `${customWidth}×${customHeight}px`
            }
          >
            <div className="flex gap-2">
              <SizeModeButton active={sizeMode === "auto"} onClick={() => setSizeMode("auto")}>
                Responsive
                <span className="block text-xs font-normal opacity-80">Recommended</span>
              </SizeModeButton>
              <SizeModeButton
                active={sizeMode === "custom"}
                onClick={() => {
                  setCustomWidth(defaultSizeFor(capability, placement).width);
                  setCustomHeight(defaultSizeFor(capability, placement).height);
                  setSizeMode("custom");
                }}
              >
                Custom size
                <span className="block text-xs font-normal opacity-80">Fixed box</span>
              </SizeModeButton>
            </div>

            {sizeMode === "custom" && (
              <div className="mt-4 grid grid-cols-2 gap-3">
                <Field label="Max width" htmlFor="embed-width">
                  <NumberField
                    id="embed-width"
                    value={customWidth}
                    min={MIN_CUSTOM_WIDTH}
                    max={MAX_CUSTOM_WIDTH}
                    suffix="px"
                    onChange={(v) => setCustomWidth(v)}
                  />
                </Field>
                {heightApplies ? (
                  <Field label="Height" htmlFor="embed-height">
                    <NumberField
                      id="embed-height"
                      value={customHeight}
                      min={MIN_CUSTOM_HEIGHT}
                      max={MAX_CUSTOM_HEIGHT}
                      suffix="px"
                      onChange={(v) => setCustomHeight(v)}
                    />
                  </Field>
                ) : (
                  <div className="text-xs text-muted">
                    Height isn&apos;t set here — Full page always fills the visitor&apos;s screen
                    height instead.
                  </div>
                )}
              </div>
            )}
            <p className="mt-3 text-xs text-muted">
              {sizeMode === "auto"
                ? "The game fills its container's width and sizes its height to match — the same on every screen."
                : "A fixed box. It never shrinks below what this template needs to be playable, even if you set it smaller."}
            </p>
          </EditorSection>

          {placement === "modal" && (
            <EditorSection
              icon={<CursorClickIcon className="h-4 w-4" />}
              title="Trigger"
              description={triggerMode === "load" ? "Opens automatically, then reopens on click" : "Opens on click"}
            >
              <Field label="Trigger button text" htmlFor="trigger-label">
                <input
                  id="trigger-label"
                  type="text"
                  value={triggerLabel}
                  onChange={(e) => setTriggerLabel(e.target.value)}
                  placeholder={DEFAULT_MODAL_TRIGGER_LABEL}
                  maxLength={60}
                  className={FIELD_CONTROL_CLASS}
                />
              </Field>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <TriggerModeButton active={triggerMode === "click"} onClick={() => setTriggerMode("click")}>
                  <span className="font-medium">On button click</span>
                  <span className="block text-xs font-normal opacity-80">
                    Visitor opens it themselves
                  </span>
                </TriggerModeButton>
                <TriggerModeButton active={triggerMode === "load"} onClick={() => setTriggerMode("load")}>
                  <span className="font-medium">On page load</span>
                  <span className="block text-xs font-normal opacity-80">Opens once, automatically</span>
                </TriggerModeButton>
              </div>
              {triggerMode === "load" && (
                <p className="mt-3 text-xs text-muted">
                  Opens shortly after the page loads. The button still renders, so a visitor who
                  closes it can open it again.
                </p>
              )}

              <div className="mt-4 border-t border-border pt-4">
                <span className="mb-1.5 block text-xs text-muted">Trigger style</span>
                <div className="grid grid-cols-2 gap-2">
                  <TriggerModeButton active={triggerStyle === "inline"} onClick={() => setTriggerStyle("inline")}>
                    <span className="font-medium">Inline button</span>
                    <span className="block text-xs font-normal opacity-80">
                      Sits where you place the embed
                    </span>
                  </TriggerModeButton>
                  <TriggerModeButton
                    active={triggerStyle === "floating"}
                    onClick={() => setTriggerStyle("floating")}
                  >
                    <span className="font-medium">Floating button</span>
                    <span className="block text-xs font-normal opacity-80">
                      Pinned to a screen corner
                    </span>
                  </TriggerModeButton>
                </div>
                {triggerStyle === "floating" && (
                  <div className="mt-3">
                    <span className="mb-1.5 block text-xs text-muted">Corner</span>
                    <div className="grid grid-cols-2 gap-2">
                      {(
                        [
                          ["bottom-right", "Bottom right"],
                          ["bottom-left", "Bottom left"],
                          ["top-right", "Top right"],
                          ["top-left", "Top left"],
                        ] as [TriggerPosition, string][]
                      ).map(([value, label]) => (
                        <TriggerModeButton
                          key={value}
                          active={triggerPosition === value}
                          onClick={() => setTriggerPosition(value)}
                        >
                          <span className="font-medium">{label}</span>
                        </TriggerModeButton>
                      ))}
                    </div>
                    <p className="mt-3 text-xs text-muted">
                      Stays visible in that corner no matter where on the page a visitor has
                      scrolled to — like a chat widget bubble.
                    </p>
                  </div>
                )}
              </div>
            </EditorSection>
          )}

          {placement === "modal" && (
            <EditorSection
              icon={<PaletteIcon className="h-4 w-4" />}
              title="Button style"
              description="Text size, colors, shadow, glow and animation"
            >
              <div className="space-y-4">
                <div>
                  <span className="mb-1.5 block text-xs text-muted">Text size</span>
                  <div className="grid grid-cols-3 gap-2">
                    {BUTTON_TEXT_SIZES.map(([value, label]) => (
                      <TriggerModeButton
                        key={value}
                        active={btnTextSize === value}
                        onClick={() => setBtnTextSize(value)}
                      >
                        <span className="font-medium">{label}</span>
                      </TriggerModeButton>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <ColorField label="Text color" value={btnTextColor} onChange={setBtnTextColor} />
                  <ColorField label="Button color" value={btnBgColor} onChange={setBtnBgColor} />
                </div>

                <div>
                  <span className="mb-1.5 block text-xs text-muted">Shadow</span>
                  <div className="grid grid-cols-4 gap-2">
                    {BUTTON_SHADOWS.map(([value, label]) => (
                      <TriggerModeButton
                        key={value}
                        active={btnShadow === value}
                        onClick={() => setBtnShadow(value)}
                      >
                        <span className="text-xs font-medium">{label}</span>
                      </TriggerModeButton>
                    ))}
                  </div>
                </div>

                <label className="flex items-center justify-between rounded-xl border border-border px-3.5 py-2.5 text-sm">
                  <span>
                    <span className="font-medium">Glow</span>
                    <span className="block text-xs font-normal text-muted">
                      A soft pulsing halo in the button&apos;s own color
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={btnGlow}
                    onChange={(e) => setBtnGlow(e.target.checked)}
                    className="h-4 w-4 accent-primary"
                  />
                </label>

                <div>
                  <span className="mb-1.5 block text-xs text-muted">Animation</span>
                  <div className="grid grid-cols-3 gap-2">
                    {BUTTON_ANIMATIONS.map(([value, label, glyph]) => (
                      <TriggerModeButton
                        key={value}
                        active={btnAnimation === value}
                        onClick={() => setBtnAnimation(value)}
                      >
                        <span className="font-medium">
                          {glyph ? `${glyph} ` : ""}
                          {label}
                        </span>
                      </TriggerModeButton>
                    ))}
                  </div>
                </div>
              </div>
            </EditorSection>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          {gaps.length > 0 && (
            <p className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
              <strong className="font-semibold">This game isn&apos;t ready to publish.</strong>{" "}
              Add {describeGaps(gaps)} in the editor first.
            </p>
          )}

          <button
            onClick={handlePublish}
            disabled={publishing || supportedPlacements.length === 0 || gaps.length > 0}
            className="w-full rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition active:scale-[0.98] disabled:opacity-40"
          >
            {publishing ? "Publishing…" : slug ? "Republish with this placement" : "Publish"}
          </button>
        </div>

        {/* --- preview + code column --------------------------------------- */}
        <div className="space-y-4 lg:sticky lg:top-6">
          <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Live preview</h2>
              {placement === "fullpage" && (
                <span className="text-xs text-muted">shown as a section here</span>
              )}
            </div>
            <div className="flex min-h-[220px] items-center justify-center bg-foreground/[0.02] p-4">
              {slug ? (
                <EmbedPreview
                  slug={slug}
                  placement={placement}
                  triggerLabel={triggerLabel}
                  trigger={triggerMode}
                  triggerStyle={triggerStyle}
                  triggerPosition={triggerPosition}
                  buttonStyle={buttonStyle}
                  width={width}
                  height={height}
                />
              ) : (
                <p className="max-w-[26ch] text-center text-sm text-muted">
                  Publish once to see the real, interactive embed here.
                </p>
              )}
            </div>
            {placement === "modal" && triggerStyle === "floating" && slug && (
              <p className="border-t border-border px-4 py-2 text-xs text-muted">
                Pinned to this page&apos;s own {triggerPosition.replace("-", " ")} corner, not
                inside this card — that&apos;s how it&apos;ll behave on your site too. Scroll to
                see it stay in place.
              </p>
            )}
          </section>

          {embedSnippet && slug && (
            <>
              <section className="rounded-2xl border border-border bg-card p-4 shadow-card">
                <h2 className="text-sm font-semibold">Embed code</h2>
                <pre className="mt-2 overflow-x-auto rounded-xl border border-border bg-foreground/[0.04] p-4 text-xs">
                  {embedSnippet}
                </pre>
                <button
                  onClick={() => copy(embedSnippet, "embed")}
                  className="mt-2 text-sm font-medium text-primary underline underline-offset-4"
                >
                  {copied === "embed" ? "Copied!" : "Copy embed code"}
                </button>
              </section>

              {placement === "modal" ? (
                <p className="text-xs text-muted">
                  No raw-iframe fallback for Modal — a modal needs the loader script to build the
                  trigger and open the overlay. Locked-down CMSs that can&apos;t run the script
                  should use In-page section instead.
                </p>
              ) : (
                <section className="rounded-2xl border border-border bg-card p-4 shadow-card">
                  <h2 className="text-sm font-semibold">Raw iframe (fallback for locked-down CMSs)</h2>
                  <pre className="mt-2 overflow-x-auto rounded-xl border border-border bg-foreground/[0.04] p-4 text-xs">
                    {buildIframeFallback(slug, appUrl)}
                  </pre>
                  <button
                    onClick={() => copy(buildIframeFallback(slug, appUrl), "iframe")}
                    className="mt-2 text-sm font-medium text-primary underline underline-offset-4"
                  >
                    {copied === "iframe" ? "Copied!" : "Copy iframe"}
                  </button>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live preview: mounts the REAL embed.js against the real, published slug,
// reacting to every setting change — a merchant sees exactly what they're
// about to paste, not a mock-up of it.
// ---------------------------------------------------------------------------

function EmbedPreview({
  slug,
  placement,
  triggerLabel,
  trigger,
  triggerStyle,
  triggerPosition,
  buttonStyle,
  width,
  height,
}: {
  slug: string;
  placement: Placement;
  triggerLabel: string;
  trigger: ModalTrigger;
  triggerStyle: TriggerStyle;
  triggerPosition: TriggerPosition;
  buttonStyle: TriggerButtonStyle;
  width?: number;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Loads the loader script once, exactly as a merchant's page would. Never
  // torn down — embed.js is designed to sit on a page forever, and a second
  // preview render just needs one script instance already present.
  useEffect(() => {
    if (document.querySelector("script[data-playloop-loader]")) return;
    const script = document.createElement("script");
    script.src = "/embed.js";
    script.async = true;
    script.setAttribute("data-playloop-loader", "1");
    document.body.appendChild(script);
  }, []);

  // Debounced: a merchant dragging a width/height number input shouldn't
  // tear down and reload the game's iframe on every keystroke. The actual
  // rebuild is a plain DOM mutation (never React-rendered — see below), so
  // embed.js's own MutationObserver rescan (app/embed.js/route.ts) is what
  // notices the fresh host and mounts it, the same self-healing path that
  // recovers a host from a framework's hydration reconciliation.
  useEffect(() => {
    const timer = setTimeout(() => {
      const container = containerRef.current;
      if (!container) return;
      container.innerHTML = "";
      // A "floating" trigger is appended to document.body, not inside
      // `container` — clearing container.innerHTML above never touches it.
      // embed.js has no unmount API (by design: it's meant to sit on a real
      // page forever), so this preview is the one place that has to clean
      // up after itself between settings changes, or a floating button
      // from every previous combination of settings would keep piling up
      // in the corner of this very editor page.
      document.querySelectorAll(".playloop-trigger-floating").forEach((el) => el.remove());

      // "fullpage" is defined by filling the VISITOR's real screen — forcing
      // that inside this settings panel would just break the panel's own
      // layout, so it's previewed as a section. The copied snippet still
      // says data-placement="fullpage" and behaves correctly on the
      // merchant's own site.
      const previewPlacement = placement === "fullpage" ? "section" : placement;

      const host = document.createElement("div");
      host.setAttribute("data-playloop", slug);
      host.setAttribute("data-placement", previewPlacement);
      if (width) host.setAttribute("data-width", String(Math.round(width)));
      // The caller only ever passes `height` for a placement where it
      // applies (see heightApplies in EmbedPanel) — fullpage's own height
      // comes from the visitor's real viewport, never from here.
      if (height) host.setAttribute("data-height", String(Math.round(height)));
      if (previewPlacement === "modal") {
        host.setAttribute("data-trigger-label", triggerLabel.trim() || DEFAULT_MODAL_TRIGGER_LABEL);
        if (trigger === "load") host.setAttribute("data-trigger", "load");
        if (triggerStyle === "floating") {
          host.setAttribute("data-trigger-style", "floating");
          host.setAttribute("data-trigger-position", triggerPosition);
        }
        if (buttonStyle.textSize && buttonStyle.textSize !== "md") {
          host.setAttribute("data-btn-text-size", buttonStyle.textSize);
        }
        if (buttonStyle.textColor && buttonStyle.textColor.toLowerCase() !== DEFAULT_TRIGGER_TEXT_COLOR) {
          host.setAttribute("data-btn-text-color", buttonStyle.textColor);
        }
        if (buttonStyle.bgColor && buttonStyle.bgColor.toLowerCase() !== DEFAULT_TRIGGER_BG_COLOR.toLowerCase()) {
          host.setAttribute("data-btn-bg", buttonStyle.bgColor);
        }
        if (buttonStyle.shadow && buttonStyle.shadow !== "medium") {
          host.setAttribute("data-btn-shadow", buttonStyle.shadow);
        }
        if (buttonStyle.glow) host.setAttribute("data-btn-glow", "1");
        if (buttonStyle.animation && buttonStyle.animation !== "none") {
          host.setAttribute("data-btn-animation", buttonStyle.animation);
        }
      }
      container.appendChild(host);
    }, 400);
    return () => clearTimeout(timer);
  }, [slug, placement, triggerLabel, trigger, triggerStyle, triggerPosition, buttonStyle, width, height]);

  // Same cleanup as above, but for when this preview unmounts entirely
  // (navigating away from the page) rather than just re-settling on a new
  // combination of settings.
  useEffect(() => {
    return () => {
      document.querySelectorAll(".playloop-trigger-floating").forEach((el) => el.remove());
    };
  }, []);

  // The wrapper React actually renders is permanently empty in its own vdom
  // — the host div above is created imperatively, entirely outside React's
  // reconciliation, so there's nothing for a server/client render mismatch
  // to catch here at all.
  return <div ref={containerRef} className="w-full" />;
}

// ---------------------------------------------------------------------------
// Shared section/field chrome (local to this page — see
// app/(app)/games/[id]/page.tsx for the original of this pattern).
// ---------------------------------------------------------------------------

function EditorSection({
  icon,
  title,
  description,
  defaultOpen = true,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
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
        <ChevronIcon
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div
        id={panelId}
        className={`grid transition-[grid-template-rows,visibility] duration-200 ease-out ${
          open ? "grid-rows-[1fr] visible" : "grid-rows-[0fr] invisible"
        }`}
      >
        <div className="overflow-hidden" inert={!open}>
          <div className="border-t border-border p-4 pt-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

const FIELD_CONTROL_CLASS =
  "mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-primary/50";

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <label className="block text-xs" htmlFor={htmlFor}>
      <span className="block text-muted">{label}</span>
      {children}
    </label>
  );
}

/** Clamping on every keystroke (rather than on blur) would snap a value like
 * "300" back to a higher min after typing just its first digit — a
 * mid-typing "3" is briefly below a min of 240, and a controlled input that
 * corrects itself immediately makes it impossible to ever get to "300" by
 * typing. So the input keeps its own draft string, unclamped, while
 * focused, and only commits a clamped number on blur. */
function NumberField({
  id,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  function commit() {
    const next = Number(draft);
    const clamped = Number.isFinite(next) ? Math.min(max, Math.max(min, Math.round(next))) : value;
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  }

  return (
    <div className="relative">
      <input
        id={id}
        type="number"
        inputMode="numeric"
        value={draft}
        min={min}
        max={max}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className={`${FIELD_CONTROL_CLASS} ${suffix ? "pr-8" : ""}`}
      />
      {suffix && (
        <span className="pointer-events-none absolute right-2 top-1/2 mt-0.5 -translate-y-1/2 text-xs text-muted">
          {suffix}
        </span>
      )}
    </div>
  );
}

/** A native color swatch plus a synced hex text field — the swatch is the
 * easy path, the text field is there for a merchant pasting an exact brand
 * hex. Both write through the same onChange, so either one is a source of
 * truth for the other. */
function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="text-xs">
      <span className="mb-1.5 block text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          className="h-8 w-8 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className={`${FIELD_CONTROL_CLASS} mt-0 uppercase`}
        />
      </div>
    </div>
  );
}

function SizeModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 rounded-xl border px-3.5 py-2.5 text-left text-sm font-medium transition ${
        active
          ? "border-transparent bg-primary text-primary-foreground shadow-elevated"
          : "border-border hover:border-primary/30"
      }`}
    >
      {children}
    </button>
  );
}

function TriggerModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-xl border px-3.5 py-2.5 text-left text-sm transition ${
        active
          ? "border-transparent bg-primary text-primary-foreground shadow-elevated"
          : "border-border hover:border-primary/30"
      }`}
    >
      {children}
    </button>
  );
}
