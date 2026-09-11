// app/(app)/games/[id]/embed/page.tsx
//
// Placement picker (only placements the template supports, via
// supportsPlacement) + publish button + copyable embed snippet + raw
// iframe fallback (spec §14, §15).
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { getCapability, supportsPlacement } from "@/lib/capabilities";
import type { GameRecord, Placement } from "@/lib/engine/types";

const PLACEMENT_LABELS: Record<Placement, string> = {
  section: "In-page section",
  fullpage: "Full page",
  modal: "Modal",
  ad: "Ad unit",
};

export default function EmbedPage() {
  const { id } = useParams<{ id: string }>();
  const [game, setGame] = useState<GameRecord | null>(null);
  const [placement, setPlacement] = useState<Placement>("section");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ slug: string; embed: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/games/${id}?full=1`, { cache: "no-store" })
      .then((res) => res.json())
      .then((g: GameRecord) => {
        setGame(g);
        setPlacement(g.placement ?? "section");
        if (g.slug) {
          setResult({
            slug: g.slug,
            embed: buildEmbed(g.slug),
          });
        }
      });
  }, [id]);

  const capability = useMemo(
    () => (game ? getCapability(game.spec.template) : undefined),
    [game],
  );
  const supportedPlacements = useMemo(
    () =>
      capability
        ? (Object.keys(PLACEMENT_LABELS) as Placement[]).filter((p) =>
            supportsPlacement(capability, p),
          )
        : [],
    [capability],
  );

  function buildEmbed(slug: string): string {
    const appUrl =
      typeof window !== "undefined" ? window.location.origin : "https://playloop.app";
    return `<div data-playloop="${slug}"></div>\n<script src="${appUrl}/embed.js" async></script>`;
  }

  function buildIframeFallback(slug: string): string {
    const appUrl =
      typeof window !== "undefined" ? window.location.origin : "https://playloop.app";
    return `<iframe src="${appUrl}/play/${slug}" style="width:100%;border:0;min-height:600px" sandbox="allow-scripts allow-same-origin allow-popups" title="PlayLoop game"></iframe>`;
  }

  async function handlePublish() {
    setPublishing(true);
    setError(null);
    try {
      const res = await fetch(`/api/games/${id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ placement }),
      });
      if (!res.ok) throw new Error("Could not publish.");
      const data = (await res.json()) as { slug: string; embed: string };
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publish failed.");
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

  if (!game) return <p className="text-sm text-ink/50">Loading…</p>;

  return (
    <div className="mx-auto max-w-xl space-y-8">
      <h1 className="text-2xl font-semibold">Publish &amp; embed</h1>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/50">Placement</h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {supportedPlacements.map((p) => (
            <button
              key={p}
              onClick={() => setPlacement(p)}
              className={`rounded-md border px-4 py-3 text-left text-sm ${
                placement === p ? "border-ink bg-ink text-paper" : "border-ink/20"
              }`}
            >
              {PLACEMENT_LABELS[p]}
            </button>
          ))}
        </div>
        {supportedPlacements.length === 0 && (
          <p className="mt-2 text-sm text-ink/50">
            No placements available for this template yet.
          </p>
        )}
      </section>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        onClick={handlePublish}
        disabled={publishing || supportedPlacements.length === 0}
        className="w-full rounded-md bg-ink px-5 py-3 text-sm font-medium text-paper disabled:opacity-40"
      >
        {publishing ? "Publishing…" : result ? "Republish with this placement" : "Publish"}
      </button>

      {result && (
        <div className="space-y-6">
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/50">
              Embed code
            </h2>
            <pre className="mt-2 overflow-x-auto rounded-md border border-ink/10 bg-ink/5 p-4 text-xs">
              {result.embed}
            </pre>
            <button
              onClick={() => copy(result.embed, "embed")}
              className="mt-2 text-sm underline"
            >
              {copied === "embed" ? "Copied!" : "Copy embed code"}
            </button>
          </section>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/50">
              Raw iframe (fallback for locked-down CMSs)
            </h2>
            <pre className="mt-2 overflow-x-auto rounded-md border border-ink/10 bg-ink/5 p-4 text-xs">
              {buildIframeFallback(result.slug)}
            </pre>
            <button
              onClick={() => copy(buildIframeFallback(result.slug), "iframe")}
              className="mt-2 text-sm underline"
            >
              {copied === "iframe" ? "Copied!" : "Copy iframe"}
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
