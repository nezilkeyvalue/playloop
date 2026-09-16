// app/(app)/games/[id]/embed/page.tsx
//
// Placement picker (only placements the template supports, via
// supportsPlacement) + publish button + copyable embed snippet + raw
// iframe fallback (spec §14, §15).
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  findIncompleteRoles,
  getCapability,
  supportsPlacement,
} from "@/lib/capabilities";
import type { RoleGap } from "@/lib/capabilities";
import type { GameRecord, Placement } from "@/lib/engine/types";

const PLACEMENT_LABELS: Record<Placement, string> = {
  section: "In-page section",
  fullpage: "Full page",
  modal: "Modal",
  ad: "Ad unit",
};

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
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => null)) as { error?: string; gaps?: RoleGap[] } | null;
        setError(publishErrorMessage(body));
        return;
      }
      const data = (await res.json()) as { slug: string; embed: string };
      setResult(data);
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
    <div className="mx-auto max-w-xl space-y-8">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Publish &amp; embed</h1>

      <section className="rounded-2xl border border-border bg-card p-5 shadow-card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Placement</h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {supportedPlacements.map((p) => (
            <button
              key={p}
              onClick={() => setPlacement(p)}
              className={`rounded-xl border px-4 py-3 text-left text-sm transition ${
                placement === p
                  ? "border-transparent bg-primary text-primary-foreground"
                  : "border-border hover:border-primary/30"
              }`}
            >
              {PLACEMENT_LABELS[p]}
            </button>
          ))}
        </div>
        {supportedPlacements.length === 0 && (
          <p className="mt-2 text-sm text-muted">
            No placements available for this template yet.
          </p>
        )}
      </section>

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
        {publishing ? "Publishing…" : result ? "Republish with this placement" : "Publish"}
      </button>

      {result && (
        <div className="space-y-6">
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
              Embed code
            </h2>
            <pre className="mt-2 overflow-x-auto rounded-xl border border-border bg-foreground/[0.04] p-4 text-xs">
              {result.embed}
            </pre>
            <button
              onClick={() => copy(result.embed, "embed")}
              className="mt-2 text-sm font-medium text-primary underline underline-offset-4"
            >
              {copied === "embed" ? "Copied!" : "Copy embed code"}
            </button>
          </section>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
              Raw iframe (fallback for locked-down CMSs)
            </h2>
            <pre className="mt-2 overflow-x-auto rounded-xl border border-border bg-foreground/[0.04] p-4 text-xs">
              {buildIframeFallback(result.slug)}
            </pre>
            <button
              onClick={() => copy(buildIframeFallback(result.slug), "iframe")}
              className="mt-2 text-sm font-medium text-primary underline underline-offset-4"
            >
              {copied === "iframe" ? "Copied!" : "Copy iframe"}
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
