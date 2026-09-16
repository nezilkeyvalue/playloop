// app/(app)/build/manual/page.tsx
//
// Manual-mode upload wizard (spec §15): upload images, enter copy, set
// reward tiers, pick a template. Template choices are filtered to ones the
// uploaded assets could plausibly fill using listCapabilities() — a light
// client-side pre-check only; the server (POST /api/games, and the eligible
// list computed by the pipeline for auto mode) is the real gate. Submits a
// hand-assembled GameSpec to POST /api/games.
"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { listCapabilities } from "@/lib/capabilities";
import { GamePreviewModal } from "@/components/GamePreviewModal";
import type {
  GameCapability,
  GameSpec,
  Placement,
  ProcessedAsset,
  RewardTier,
  TemplateId,
} from "@/lib/engine/types";

interface UploadedAsset {
  id: string;
  url: string;
  name: string;
  priceMinor?: number;
}

const DEFAULT_ACCENT = "#5B4AFF";

function estimateEligible(
  capabilities: GameCapability[],
  assets: UploadedAsset[],
): GameCapability[] {
  const hasAnyPrice = assets.some((a) => typeof a.priceMinor === "number");
  return capabilities.filter((cap) => {
    const primaryRole = cap.roles.find((r) => r.fallback === "none") ?? cap.roles[0];
    if (primaryRole && assets.length < primaryRole.count.min) return false;
    if (cap.data.required.includes("priceMinor") && !hasAnyPrice) return false;
    return true;
  });
}

function buildRoles(
  capability: GameCapability,
  assetIds: string[],
): Record<string, string[] | { fallback: string }> {
  const roles: Record<string, string[] | { fallback: string }> = {};
  const primary = capability.roles.find((r) => r.fallback === "none") ?? capability.roles[0];
  for (const role of capability.roles) {
    if (primary && role.id === primary.id) {
      roles[role.id] = assetIds.slice(0, role.count.max);
    } else if (role.fallback !== "none") {
      roles[role.id] = { fallback: role.fallback };
    } else {
      roles[role.id] = assetIds.slice(0, role.count.max);
    }
  }
  return roles;
}

function defaultTuning(capability: GameCapability): Record<string, number> {
  return Object.fromEntries(Object.entries(capability.tuning).map(([k, v]) => [k, v.default]));
}

export default function ManualBuildPage() {
  const router = useRouter();
  const allCapabilities = useMemo(() => listCapabilities(), []);

  const [assets, setAssets] = useState<UploadedAsset[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const eligible = useMemo(() => estimateEligible(allCapabilities, assets), [allCapabilities, assets]);
  const [template, setTemplate] = useState<TemplateId | null>(null);

  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [headline, setHeadline] = useState("Play and save");
  const [subhead, setSubhead] = useState("Play for a chance at a discount.");
  const [ctaStart, setCtaStart] = useState("Start");
  const [ctaReplay, setCtaReplay] = useState("Play again");
  const [rewardIntro, setRewardIntro] = useState("You earned");
  const [emailPrompt, setEmailPrompt] = useState("Email my code");

  const [rewards, setRewards] = useState<RewardTier[]>([
    { minScore: 0, label: "10% off", percentOff: 10 },
    { minScore: 700, label: "20% off", percentOff: 20 },
  ]);

  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [previewSpec, setPreviewSpec] = useState<{ spec: GameSpec; placement: Placement } | null>(
    null,
  );

  const activeCapability = eligible.find((c) => c.id === template) ?? eligible[0] ?? null;

  function buildSpec(capability: GameCapability): { spec: GameSpec; placement: Placement } {
    const processedAssets: ProcessedAsset[] = assets.map((a) => ({
      id: a.id,
      spriteUrl: a.url,
      width: 256,
      height: 256,
      coverage: 0.6,
      // Manual-mode assets skip the quality gate's perceptual hash — there
      // is no dedupe concern with a small hand-picked set, so this is a
      // stable per-asset placeholder rather than a real phash.
      phash: `manual_${a.id}`,
      score: 1,
      flags: [],
      data: { name: a.name || undefined, priceMinor: a.priceMinor },
    }));

    const placements = Object.keys(capability.placements) as Placement[];
    const spec: GameSpec = {
      id: crypto.randomUUID(),
      version: 1,
      template: capability.id,
      placements,
      brand: {
        accent,
        background: "#FFFFFF",
        foreground: "#0B0B0F",
        fontFamily: "Inter, system-ui, sans-serif",
        palette: [accent],
      },
      copy: { headline, subhead, ctaStart, ctaReplay, rewardIntro, emailPrompt },
      assets: processedAssets,
      roles: buildRoles(
        capability,
        processedAssets.map((a) => a.id),
      ),
      rewards,
      durationSeconds: capability.tuning.durationSec?.default ?? 40,
      tuning: defaultTuning(capability),
      meta: {
        mode: "manual",
        generatedAt: new Date().toISOString(),
        warnings: [],
      },
    };
    return { spec, placement: placements[0] ?? "section" };
  }

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      Array.from(fileList).forEach((file) => form.append("file", file));
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = (await res.json()) as {
        assets?: { id: string; url: string; name: string }[];
        errors?: { name: string; error: string }[];
      };
      if (!res.ok) throw new Error("Upload failed.");
      if (data.assets?.length) {
        setAssets((prev) => [...prev, ...data.assets!.map((a) => ({ ...a }))]);
      }
      if (data.errors?.length) {
        setUploadError(`${data.errors.length} file(s) failed to upload.`);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  function removeAsset(id: string) {
    setAssets((prev) => prev.filter((a) => a.id !== id));
  }

  function updateAssetField(id: string, patch: Partial<UploadedAsset>) {
    setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  function updateReward(index: number, patch: Partial<RewardTier>) {
    setRewards((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function addReward() {
    setRewards((prev) => [
      ...prev,
      { minScore: 0, label: "New tier", percentOff: 10 },
    ]);
  }

  function removeReward(index: number) {
    setRewards((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  function handlePreview() {
    if (!activeCapability) return;
    setPreviewSpec(buildSpec(activeCapability));
  }

  async function handleSubmit() {
    if (!activeCapability) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { spec, placement } = buildSpec(activeCapability);

      const res = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: headline || "Untitled game",
          placement,
          spec,
          rightsConfirmed,
        }),
      });
      if (!res.ok) throw new Error("Could not create the game.");
      const { id } = (await res.json()) as { id: string };
      router.push(`/games/${id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    activeCapability !== null && assets.length > 0 && rightsConfirmed && !submitting;

  return (
    <div className="mx-auto max-w-2xl space-y-10">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Build manually</h1>
        <p className="mt-2 text-muted">
          Upload images, add copy, set your reward tiers, and pick a template.
        </p>
      </div>

      {/* 1. Upload */}
      <section className="rounded-2xl border border-border bg-card p-5 shadow-card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          1. Upload images
        </h2>
        <label className="mt-3 flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted transition hover:border-primary/40 hover:bg-primary/[0.03]">
          <span>{uploading ? "Uploading…" : "Click to choose product images"}</span>
          <input
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </label>
        {uploadError && <p className="mt-2 text-sm text-destructive">{uploadError}</p>}

        {assets.length > 0 && (
          <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {assets.map((a) => (
              <li key={a.id} className="rounded-xl border border-border bg-background p-2 text-xs">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.url} alt={a.name} className="h-20 w-full rounded-lg object-contain" />
                <input
                  value={a.name}
                  onChange={(e) => updateAssetField(a.id, { name: e.target.value })}
                  className="mt-2 w-full rounded-md border border-border bg-transparent px-1 py-1 outline-none focus:border-primary/50"
                  placeholder="Product name"
                />
                <input
                  type="number"
                  value={a.priceMinor ?? ""}
                  onChange={(e) =>
                    updateAssetField(a.id, {
                      priceMinor: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                  className="mt-1 w-full rounded-md border border-border bg-transparent px-1 py-1 outline-none focus:border-primary/50"
                  placeholder="Price (minor units)"
                />
                <button
                  type="button"
                  onClick={() => removeAsset(a.id)}
                  className="mt-1 text-destructive/80 underline hover:text-destructive"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 2. Template */}
      <section className="rounded-2xl border border-border bg-card p-5 shadow-card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          2. Pick a template
        </h2>
        {eligible.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            Upload at least a few images to see which templates fit.
          </p>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {eligible.map((cap) => (
              <button
                key={cap.id}
                type="button"
                onClick={() => setTemplate(cap.id)}
                className={`rounded-xl border p-4 text-left text-sm transition ${
                  (template ?? eligible[0]?.id) === cap.id
                    ? "border-transparent bg-primary text-primary-foreground"
                    : "border-border hover:border-primary/30 hover:bg-primary/[0.03]"
                }`}
              >
                <div className="font-medium">{cap.name}</div>
                <div className="mt-1 opacity-80">{cap.summary}</div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 3. Copy */}
      <section className="rounded-2xl border border-border bg-card p-5 shadow-card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">3. Copy</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Headline" value={headline} onChange={setHeadline} />
          <Field label="Subhead" value={subhead} onChange={setSubhead} />
          <Field label="Start button" value={ctaStart} onChange={setCtaStart} />
          <Field label="Replay button" value={ctaReplay} onChange={setCtaReplay} />
          <Field label="Reward intro" value={rewardIntro} onChange={setRewardIntro} />
          <Field label="Email prompt" value={emailPrompt} onChange={setEmailPrompt} />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <label className="text-sm text-muted">Accent colour</label>
          <input
            type="color"
            value={accent}
            onChange={(e) => setAccent(e.target.value)}
            className="h-8 w-14 cursor-pointer rounded-md border border-border"
          />
        </div>
      </section>

      {/* 4. Rewards */}
      <section className="rounded-2xl border border-border bg-card p-5 shadow-card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          4. Reward tiers
        </h2>
        <p className="mt-1 text-xs text-muted">
          Score gates the discount — higher scores unlock better tiers.
        </p>
        <div className="mt-3 space-y-2">
          {rewards.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                value={r.minScore}
                onChange={(e) => updateReward(i, { minScore: Number(e.target.value) })}
                className="w-28 rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none focus:border-primary/50"
                placeholder="Min score"
              />
              <input
                value={r.label}
                onChange={(e) => updateReward(i, { label: e.target.value })}
                className="w-32 rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none focus:border-primary/50"
                placeholder="Label"
              />
              <input
                type="number"
                value={r.percentOff ?? ""}
                onChange={(e) => updateReward(i, { percentOff: Number(e.target.value) })}
                className="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none focus:border-primary/50"
                placeholder="% off"
              />
              <button
                type="button"
                onClick={() => removeReward(i)}
                className="text-xs text-destructive/80 underline hover:text-destructive"
              >
                Remove
              </button>
            </div>
          ))}
          <button type="button" onClick={addReward} className="text-xs font-medium text-primary underline underline-offset-4">
            + Add tier
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-4 text-sm text-foreground/80 shadow-card">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={rightsConfirmed}
            onChange={(e) => setRightsConfirmed(e.target.checked)}
            className="mt-0.5 accent-primary"
          />
          <span>
            I own these images, or have permission to use them, and give PlayLoop permission
            to use them to build this game.
          </span>
        </label>
      </section>

      {submitError && <p className="text-sm text-destructive">{submitError}</p>}

      <div className="flex gap-3">
        <button
          type="button"
          disabled={!activeCapability || assets.length === 0}
          onClick={handlePreview}
          className="flex-1 rounded-xl border border-border bg-card px-5 py-3 text-sm font-medium shadow-card transition hover:border-primary/40 disabled:opacity-40"
        >
          Preview
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={handleSubmit}
          className="flex-1 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition active:scale-[0.98] disabled:opacity-40"
        >
          {submitting ? "Creating…" : "Create game"}
        </button>
      </div>

      {previewSpec && (
        <GamePreviewModal
          spec={previewSpec.spec}
          placement={previewSpec.placement}
          onClose={() => setPreviewSpec(null)}
        />
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="text-muted">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 outline-none focus:border-primary/50"
      />
    </label>
  );
}
