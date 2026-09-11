// app/(app)/games/[id]/page.tsx
//
// Preview + the capped editor (spec §15: four properties, no more — swap
// or remove an image, accent colour, copy, reward thresholds). Renders the
// REAL runtime by dynamically importing lib/runtime/mount and mounting it
// directly against the fetched GameSpec, so this page has zero coupling to
// the other track's /play/:slug route (which an unpublished draft doesn't
// have a slug for anyway).
"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useParams } from "next/navigation";
import type { GameRecord, GameSpec, RewardTier } from "@/lib/engine/types";

type Device = "desktop" | "mobile";

export default function GamePreviewEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [game, setGame] = useState<GameRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [saving, setSaving] = useState(false);
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
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const warnings = useMemo(() => spec?.meta.warnings ?? [], [spec]);

  if (loadError) return <p className="text-sm text-red-600">{loadError}</p>;
  if (!game || !spec) return <p className="text-sm text-ink/50">Loading…</p>;

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_360px]">
      <div>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{game.name}</h1>
          <div className="flex gap-1 rounded-md border border-ink/15 p-1 text-sm">
            <button
              className={`rounded px-3 py-1 ${device === "desktop" ? "bg-ink text-paper" : ""}`}
              onClick={() => setDevice("desktop")}
            >
              Desktop
            </button>
            <button
              className={`rounded px-3 py-1 ${device === "mobile" ? "bg-ink text-paper" : ""}`}
              onClick={() => setDevice("mobile")}
            >
              Mobile
            </button>
          </div>
        </div>

        {warnings.length > 0 && (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <p className="font-medium">What we inferred</p>
            <ul className="mt-1 list-disc pl-5">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <div
          className={`mt-6 overflow-hidden rounded-lg border border-ink/10 bg-white ${
            device === "mobile" ? "mx-auto max-w-sm" : "w-full"
          }`}
          style={{ minHeight: 480 }}
        >
          <div ref={containerRef} className="h-full w-full" style={{ minHeight: 480 }} />
          {mountError && (
            <div className="p-6 text-center text-sm text-ink/50">{mountError}</div>
          )}
        </div>
      </div>

      <aside className="space-y-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/50">Edit</h2>
        {saveError && <p className="text-sm text-red-600">{saveError}</p>}

        {/* 1. Images */}
        <section>
          <h3 className="text-sm font-medium">Images</h3>
          <ul className="mt-2 space-y-2">
            {spec.assets.map((asset) => (
              <li key={asset.id} className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={asset.spriteUrl}
                  alt={asset.data?.name ?? asset.id}
                  className="h-10 w-10 rounded border border-ink/10 object-contain"
                />
                <span className="flex-1 truncate text-sm">{asset.data?.name ?? asset.id}</span>
                <SwapButton assetId={asset.id} onUploaded={(url) => {
                  patchSpec({
                    assets: spec.assets.map((a) =>
                      a.id === asset.id ? { ...a, spriteUrl: url } : a,
                    ),
                  });
                }} />
                <button
                  className="text-xs text-red-600 underline"
                  onClick={() =>
                    patchSpec({ assets: spec.assets.filter((a) => a.id !== asset.id) })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* 2. Accent colour */}
        <section>
          <h3 className="text-sm font-medium">Accent colour</h3>
          <input
            type="color"
            value={spec.brand.accent}
            onChange={(e) => patchSpec({ brand: { ...spec.brand, accent: e.target.value } })}
            className="mt-2 h-9 w-16 cursor-pointer rounded border border-ink/20"
          />
        </section>

        {/* 3. Copy */}
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Copy</h3>
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
        </section>

        {/* 4. Reward thresholds */}
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Reward tiers</h3>
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
            />
          ))}
        </section>

        {saving && <p className="text-xs text-ink/40">Saving…</p>}

        <a
          href={`/games/${id}/embed`}
          className="block rounded-md bg-ink px-4 py-2 text-center text-sm font-medium text-paper"
        >
          Continue to embed &amp; publish
        </a>
      </aside>
    </div>
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
      <span className="text-ink/50">{label}</span>
      <input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => local !== value && onCommit(local)}
        className="mt-1 w-full rounded border border-ink/20 px-2 py-1.5 text-sm"
      />
    </label>
  );
}

function RewardRow({
  reward,
  onCommit,
}: {
  reward: RewardTier;
  onCommit: (patch: Partial<RewardTier>) => void;
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
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={minScore}
        onChange={(e) => setMinScore(Number(e.target.value))}
        onBlur={commit}
        className="w-20 rounded border border-ink/20 px-2 py-1 text-sm"
      />
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={commit}
        className="flex-1 rounded border border-ink/20 px-2 py-1 text-sm"
      />
      <input
        type="number"
        value={percentOff}
        onChange={(e) => setPercentOff(Number(e.target.value))}
        onBlur={commit}
        className="w-16 rounded border border-ink/20 px-2 py-1 text-sm"
      />
    </div>
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
    <label className="cursor-pointer text-xs underline">
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
