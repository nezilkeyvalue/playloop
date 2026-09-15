// app/(app)/games/[id]/page.tsx
//
// Preview + the capped editor (spec §15: four properties, no more — swap
// or remove an image, accent colour, copy, reward thresholds). Renders the
// REAL runtime by dynamically importing lib/runtime/mount and mounting it
// directly against the fetched GameSpec, so this page has zero coupling to
// the other track's /play/:slug route (which an unpublished draft doesn't
// have a slug for anyway).
"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { getCapability } from "@/lib/capabilities";
import { CheckIcon, ChevronIcon, GiftIcon, ImageIcon, PaletteIcon, TextIcon } from "@/components/EditorIcons";
import type { GameRecord, GameSpec, ProcessedAsset, RewardTier } from "@/lib/engine/types";

type Device = "desktop" | "mobile";

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

export default function GamePreviewEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [game, setGame] = useState<GameRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [mountError, setMountError] = useState<string | null>(null);

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

  // Mount the real runtime against the current spec. Re-runs whenever the
  // spec changes (an edit saved) or the device toggle changes (so the
  // canvas re-fits its container).
  useEffect(() => {
    let cancelled = false;
    let handle: { teardown(): void } | undefined;

    async function run() {
      if (!containerRef.current || !spec || !game) return;
      containerRef.current.innerHTML = "";
      setMountError(null);
      try {
        const { mount } = await import("@/lib/runtime/mount");
        if (cancelled) return;
        // Pass the game's real slug (once published) so telemetry
        // (POST /api/plays/start|finish) ties back to this game instead of
        // the synthetic spec.id fallback mount() uses when no slug is given.
        handle = mount(spec, containerRef.current, game.placement, {
          slug: game.slug ?? undefined,
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
  }, [spec, device]);

  async function patchSpec(patch: Partial<GameSpec>) {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/games/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Could not save changes.");
      const updatedSpec: GameSpec = await res.json();
      setGame((prev) => (prev ? { ...prev, spec: updatedSpec } : prev));
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1800);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const warnings = useMemo(() => spec?.meta.warnings ?? [], [spec]);

  if (loadError) return <p className="text-sm text-destructive">{loadError}</p>;
  if (!game || !spec) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_360px] lg:items-start">
      <div className="animate-fade-up lg:sticky lg:top-24">
        <div className="flex items-center justify-between">
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
          <div className="flex gap-1 rounded-full border border-border bg-card p-1 text-sm shadow-card">
            <button
              className={`rounded-full px-3 py-1 transition ${
                device === "desktop" ? "bg-primary text-white" : "text-muted hover:text-foreground"
              }`}
              onClick={() => setDevice("desktop")}
            >
              Desktop
            </button>
            <button
              className={`rounded-full px-3 py-1 transition ${
                device === "mobile" ? "bg-primary text-white" : "text-muted hover:text-foreground"
              }`}
              onClick={() => setDevice("mobile")}
            >
              Mobile
            </button>
          </div>
        </div>

        <div
          className={`mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-card ${
            device === "mobile" ? "mx-auto max-w-sm" : "w-full"
          }`}
          style={{ minHeight: 480 }}
        >
          <div ref={containerRef} className="h-full w-full" style={{ minHeight: 480 }} />
          {mountError && (
            <div className="p-6 text-center text-sm text-muted">{mountError}</div>
          )}
        </div>
      </div>

      <aside className="animate-fade-up" style={{ animationDelay: "60ms" }}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Customize your game</h2>
            <p className="text-xs text-muted">Changes save automatically.</p>
          </div>
          <SaveStatus saving={saving} justSaved={justSaved} />
        </div>
        {saveError && <p className="mt-2 text-sm text-destructive">{saveError}</p>}

        {/* Lives here, not beside the preview: the preview column is sticky
            (position: sticky doesn't create its own scroll container), so a
            variable-length list here could push the canvas below the fold
            with no way to scroll to it. The aside already scrolls normally
            with the page, so this is always reachable no matter how long. */}
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
          {/* 1. Branding — identity first: colours, font and logo set the
              tone everything else (images, copy) gets judged against. */}
          <EditorSection
            icon={<PaletteIcon className="h-4 w-4" />}
            title="Branding"
            description="Logo, colours and font"
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
                    onUploaded={(url) => patchSpec({ brand: { ...spec.brand, logoUrl: url } })}
                  />
                  {spec.brand.logoUrl && (
                    <button
                      type="button"
                      onClick={() => patchSpec({ brand: { ...spec.brand, logoUrl: undefined } })}
                      className="text-xs text-destructive/80 underline hover:text-destructive"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs">
                  <span className="block text-muted">Primary colour</span>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      type="color"
                      value={spec.brand.accent}
                      onChange={(e) => patchSpec({ brand: { ...spec.brand, accent: e.target.value } })}
                      className="h-9 w-12 cursor-pointer rounded-md border border-border"
                    />
                    <span className="font-mono uppercase text-muted">{spec.brand.accent}</span>
                  </div>
                </label>
                <label className="text-xs">
                  <span className="block text-muted">Secondary colour</span>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      type="color"
                      value={spec.brand.secondaryAccent ?? spec.brand.foreground}
                      onChange={(e) =>
                        patchSpec({ brand: { ...spec.brand, secondaryAccent: e.target.value } })
                      }
                      className="h-9 w-12 cursor-pointer rounded-md border border-border"
                    />
                    <span className="font-mono uppercase text-muted">
                      {spec.brand.secondaryAccent ?? spec.brand.foreground}
                    </span>
                  </div>
                </label>
              </div>

              <label className="block text-xs">
                <span className="text-muted">Font</span>
                <select
                  value={FONT_OPTIONS.includes(spec.brand.fontFamily) ? spec.brand.fontFamily : FONT_OPTIONS[0]}
                  onChange={(e) => patchSpec({ brand: { ...spec.brand, fontFamily: e.target.value } })}
                  className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-primary/50"
                >
                  {FONT_OPTIONS.map((font) => (
                    <option key={font} value={font}>
                      {font}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </EditorSection>

          {/* 2. Images, grouped by the role each one plays in the game */}
          <EditorSection
            icon={<ImageIcon className="h-4 w-4" />}
            title="Images"
            description="Assign photos to each role in the game"
            badge={<RoleCompletenessBadge spec={spec} />}
          >
            <RoleImagesEditor spec={spec} patchSpec={patchSpec} />
          </EditorSection>

          {/* 3. Copy */}
          <EditorSection
            icon={<TextIcon className="h-4 w-4" />}
            title="Copy"
            description="Headline, subhead and button text"
          >
            <div className="space-y-3">
              <EditableField
                label="Headline"
                value={spec.copy.headline}
                onCommit={(v) => patchSpec({ copy: { ...spec.copy, headline: v } })}
              />
              <EditableField
                label="Subhead"
                value={spec.copy.subhead}
                onCommit={(v) => patchSpec({ copy: { ...spec.copy, subhead: v } })}
              />
              <EditableField
                label="Start button"
                value={spec.copy.ctaStart}
                onCommit={(v) => patchSpec({ copy: { ...spec.copy, ctaStart: v } })}
              />
              <EditableField
                label="Replay button"
                value={spec.copy.ctaReplay}
                onCommit={(v) => patchSpec({ copy: { ...spec.copy, ctaReplay: v } })}
              />
            </div>
          </EditorSection>

          {/* 4. Reward thresholds — fully optional; a game with zero tiers
              just shows a "thanks for playing" screen (lib/runtime/reward.ts
              already handles an empty rewards array). */}
          <EditorSection
            icon={<GiftIcon className="h-4 w-4" />}
            title="Rewards"
            description="Optional — discount tiers unlocked by score"
            badge={
              <span className="shrink-0 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-xs text-muted">
                {spec.rewards.length === 0 ? "Off" : spec.rewards.length}
              </span>
            }
          >
            <div className="space-y-3">
              {spec.rewards.length === 0 && (
                <p className="text-xs text-muted">
                  No reward tiers yet — players just see a &ldquo;thanks for playing&rdquo; screen.
                  Add a tier to offer a discount instead.
                </p>
              )}
              {spec.rewards.map((r, i) => (
                <RewardRow
                  key={i}
                  reward={r}
                  onCommit={(patch) => {
                    const next = spec.rewards.map((existing, idx) =>
                      idx === i ? { ...existing, ...patch } : existing,
                    );
                    patchSpec({ rewards: next });
                  }}
                  onRemove={() => patchSpec({ rewards: spec.rewards.filter((_, idx) => idx !== i) })}
                />
              ))}
              <button
                type="button"
                onClick={() =>
                  patchSpec({
                    rewards: [...spec.rewards, { minScore: 0, label: "New tier", percentOff: 10 }],
                  })
                }
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2 text-xs font-medium text-primary hover:border-primary/40"
              >
                + Add {spec.rewards.length === 0 ? "a reward tier" : "another tier"}
              </button>
            </div>
          </EditorSection>
        </div>

        <a
          href={`/games/${id}/embed`}
          className="mt-4 block rounded-xl bg-primary px-4 py-3 text-center text-sm font-semibold text-white shadow-elevated transition active:scale-[0.98]"
        >
          Continue to embed &amp; publish
        </a>
      </aside>
    </div>
  );
}

function SaveStatus({ saving, justSaved }: { saving: boolean; justSaved: boolean }) {
  if (saving) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        Saving…
      </span>
    );
  }
  if (justSaved) {
    return (
      <span className="flex items-center gap-1 text-xs font-medium text-success">
        <CheckIcon className="h-3.5 w-3.5" />
        Saved
      </span>
    );
  }
  return null;
}

function RoleCompletenessBadge({ spec }: { spec: GameSpec }) {
  const capability = getCapability(spec.template);
  if (!capability) return null;
  const required = capability.roles.filter((r) => !r.optional);
  if (required.length === 0) return null;
  const filled = required.filter((r) => {
    const entry = spec.roles[r.id];
    return Array.isArray(entry) && entry.length >= r.count.min;
  }).length;
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
        filled === required.length ? "bg-success/10 text-success" : "bg-warning/10 text-warning"
      }`}
    >
      {filled}/{required.length}
    </span>
  );
}

/** Collapsible panel — icon + title (+ optional status badge), expands to
 * reveal its controls. Every section starts closed (defaultOpen is there
 * for a future caller, not used today) so the panel reads as a short,
 * scannable list on first load instead of a wall of fields; the status
 * badges (e.g. RoleCompletenessBadge) still surface anything that needs
 * attention without requiring a section to be open. */
function EditorSection({
  icon,
  title,
  description,
  badge,
  defaultOpen = false,
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
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
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
          className={`h-4 w-4 shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="border-t border-border p-4 pt-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

function EditableField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <label className="block text-sm">
      <span className="text-muted">{label}</span>
      <input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => local !== value && onCommit(local)}
        className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-primary/50"
      />
    </label>
  );
}

function RewardRow({
  reward,
  onCommit,
  onRemove,
}: {
  reward: RewardTier;
  onCommit: (patch: Partial<RewardTier>) => void;
  onRemove: () => void;
}) {
  const [minScore, setMinScore] = useState(reward.minScore);
  const [label, setLabel] = useState(reward.label);
  const [percentOff, setPercentOff] = useState(reward.percentOff ?? 0);

  useEffect(() => {
    setMinScore(reward.minScore);
    setLabel(reward.label);
    setPercentOff(reward.percentOff ?? 0);
  }, [reward]);

  function commit() {
    if (minScore !== reward.minScore || label !== reward.label || percentOff !== reward.percentOff) {
      onCommit({ minScore, label, percentOff });
    }
  }

  return (
    <div className="rounded-lg border border-border p-2.5">
      <div className="flex gap-2">
        <label className="w-20 text-xs">
          <span className="block text-muted">Min score</span>
          <input
            type="number"
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            onBlur={commit}
            className="mt-0.5 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none focus:border-primary/50"
          />
        </label>
        <label className="flex-1 text-xs">
          <span className="block text-muted">Label</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={commit}
            className="mt-0.5 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none focus:border-primary/50"
          />
        </label>
        <label className="w-16 text-xs">
          <span className="block text-muted">% off</span>
          <input
            type="number"
            value={percentOff}
            onChange={(e) => setPercentOff(Number(e.target.value))}
            onBlur={commit}
            className="mt-0.5 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none focus:border-primary/50"
          />
        </label>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="mt-1.5 text-xs text-destructive/80 underline hover:text-destructive"
      >
        Remove tier
      </button>
    </div>
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
  spec: GameSpec;
  patchSpec: (patch: Partial<GameSpec>) => void;
}) {
  const capability = getCapability(spec.template);

  function assignedIdsFor(roleId: string): string[] {
    const entry = spec.roles[roleId];
    return Array.isArray(entry) ? entry : [];
  }

  function setRoleIds(roleId: string, ids: string[]) {
    patchSpec({ roles: { ...spec.roles, [roleId]: ids } });
  }

  function unassignFromRole(roleId: string, assetId: string) {
    setRoleIds(roleId, assignedIdsFor(roleId).filter((id) => id !== assetId));
  }

  function assignExistingToRole(roleId: string, assetId: string) {
    const current = assignedIdsFor(roleId);
    if (current.includes(assetId)) return;
    setRoleIds(roleId, [...current, assetId]);
  }

  function addNewAssetToRole(roleId: string, asset: ProcessedAsset) {
    patchSpec({
      assets: [...spec.assets, asset],
      roles: { ...spec.roles, [roleId]: [...assignedIdsFor(roleId), asset.id] },
    });
  }

  function swapAsset(assetId: string, url: string) {
    patchSpec({ assets: spec.assets.map((a) => (a.id === assetId ? { ...a, spriteUrl: url } : a)) });
  }

  // Strips the asset from every role's assignment list too, not just
  // spec.assets — the old flat "Remove" left a dangling id in spec.roles,
  // which mount.ts's resolveRoles() silently drops (loadAsset never finds
  // it) rather than erroring, so the bug was invisible but real.
  function deleteAssetEverywhere(assetId: string) {
    const nextRoles = Object.fromEntries(
      Object.entries(spec.roles).map(([roleId, entry]) => [
        roleId,
        Array.isArray(entry) ? entry.filter((id) => id !== assetId) : entry,
      ]),
    );
    patchSpec({ assets: spec.assets.filter((a) => a.id !== assetId), roles: nextRoles });
  }

  if (!capability) {
    // Reserved/unimplemented template — degrade to a flat list rather than
    // crash; there's no role schema to group by.
    return (
      <ul className="space-y-2">
        {spec.assets.map((asset) => (
          <li key={asset.id} className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={asset.spriteUrl}
              alt={asset.data?.name ?? asset.id}
              className="h-10 w-10 rounded-lg border border-border object-contain"
            />
            <span className="flex-1 truncate text-sm">{asset.data?.name ?? asset.id}</span>
            <SwapButton assetId={asset.id} onUploaded={(url) => swapAsset(asset.id, url)} />
            <button
              className="text-xs text-destructive/80 underline hover:text-destructive"
              onClick={() => deleteAssetEverywhere(asset.id)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    );
  }

  const allAssignedIds = new Set(
    Object.values(spec.roles).flatMap((entry) => (Array.isArray(entry) ? entry : [])),
  );
  const unassigned = spec.assets.filter((a) => !allAssignedIds.has(a.id));

  return (
    <div className="space-y-4">
      {capability.roles.map((role, i) => {
        const assignedIds = assignedIdsFor(role.id);
        const assigned = assignedIds
          .map((id) => spec.assets.find((a) => a.id === id))
          .filter((a): a is ProcessedAsset => Boolean(a));
        const atMax = assigned.length >= role.count.max;
        const needsAttention = !role.optional && assigned.length < role.count.min;

        return (
          <div key={role.id} className={i > 0 ? "border-t border-border pt-4" : ""}>
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-medium capitalize">
                {role.id.replace(/([a-z])([A-Z])/g, "$1 $2")}
              </h3>
              <span
                className={`text-xs ${needsAttention ? "font-medium text-warning" : "text-muted"}`}
              >
                {assigned.length}/{role.count.max}
                {role.optional ? " · optional" : ""}
              </span>
            </div>
            <p className="text-xs text-muted">{role.purpose}</p>

            {assigned.length > 0 && (
              <ul className="mt-2 space-y-2">
                {assigned.map((asset) => (
                  <li key={asset.id} className="flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={asset.spriteUrl}
                      alt={asset.data?.name ?? asset.id}
                      className="h-10 w-10 rounded-lg border border-border object-contain"
                    />
                    <span className="flex-1 truncate text-sm">{asset.data?.name ?? asset.id}</span>
                    <SwapButton assetId={asset.id} onUploaded={(url) => swapAsset(asset.id, url)} />
                    <button
                      className="text-xs text-muted underline hover:text-foreground"
                      onClick={() => unassignFromRole(role.id, asset.id)}
                    >
                      Unassign
                    </button>
                  </li>
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
                    onChange={(e) => {
                      if (e.target.value) assignExistingToRole(role.id, e.target.value);
                      e.target.value = "";
                    }}
                    className="w-full min-w-0 max-w-full rounded-md border border-border bg-transparent px-2 py-1 text-xs"
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
                <AddImageButton onUploaded={(asset) => addNewAssetToRole(role.id, asset)} />
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
              <li key={asset.id} className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={asset.spriteUrl}
                  alt={asset.data?.name ?? asset.id}
                  className="h-10 w-10 rounded-lg border border-border object-contain opacity-60"
                />
                <span className="flex-1 truncate text-sm text-muted">{asset.data?.name ?? asset.id}</span>
                <button
                  className="text-xs text-destructive/80 underline hover:text-destructive"
                  onClick={() => deleteAssetEverywhere(asset.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function AddImageButton({ onUploaded }: { onUploaded: (asset: ProcessedAsset) => void }) {
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
          coverage: 0.6,
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

  return (
    <label className="cursor-pointer rounded-md border border-dashed border-border px-2 py-1 text-xs font-medium text-primary hover:border-primary/40">
      {busy ? "Uploading…" : "+ Upload new"}
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleChange} />
    </label>
  );
}

function LogoUploadButton({ onUploaded }: { onUploaded: (url: string) => void }) {
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
    <label className="cursor-pointer text-xs font-medium text-primary underline underline-offset-4">
      {busy ? "Uploading…" : "Change logo"}
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleChange} />
    </label>
  );
}

function SwapButton({
  assetId,
  onUploaded,
}: {
  assetId: string;
  onUploaded: (url: string) => void;
}) {
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
    <label className="cursor-pointer text-xs font-medium text-primary underline underline-offset-4">
      {busy ? "…" : "Swap"}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleChange}
        data-asset-id={assetId}
      />
    </label>
  );
}
