// app/play/[slug]/page.tsx
//
// The hosted runtime page (build spec §13/§14): what the embed iframe
// loads at /play/:slug. Server Component so the `lib/db/queries` import
// (a different, concurrently-building track — server-only, Supabase
// service role) never reaches the client bundle; PlayRuntime.tsx (a client
// component) is the only piece that touches the DOM / calls mount().
//
// TODO(integration): domain allowlist enforcement (games.allowed_hosts vs
// Sec-Fetch-Site/Referer — build spec §14/§17) is explicitly out of scope
// for this track; it belongs in the API/builder layer. This page's job is
// only to never render a broken frame.

import type { GameRecord, GameSpec, Placement } from "@/lib/engine/types";
import { fixtureGameSpecs } from "@/lib/runtime/fixtures/sampleGameSpec";
import { PlayRuntime } from "./PlayRuntime";

// Every request re-resolves the game — nothing here is safely cacheable
// per-slug once real (editable, unpublishable) games are in play.
export const dynamic = "force-dynamic";

interface ResolvedGame {
  spec: GameSpec;
  placement: Placement;
}

async function resolveGame(slug: string): Promise<ResolvedGame | null> {
  const fixture = fixtureGameSpecs[slug];
  if (fixture) {
    return { spec: fixture, placement: fixture.placements[0] ?? "section" };
  }

  // lib/db/queries.ts is owned by a different track and does not exist
  // yet at the time this file was written — this import will 404/throw
  // until that track lands `getGameBySlug`. Expected, and handled: any
  // failure here (module missing, throws, or a real "no such game")
  // degrades to the same clean "not found" state rather than a crash.
  try {
    const queries = (await import("@/lib/db/queries")) as {
      getGameBySlug?: (slug: string) => Promise<GameRecord | null>;
    };
    if (typeof queries.getGameBySlug !== "function") return null;
    const record = await queries.getGameBySlug(slug);
    if (!record) return null;
    return { spec: record.spec, placement: record.placement };
  } catch {
    return null;
  }
}

export default async function PlayPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const resolved = await resolveGame(slug);

  if (!resolved) {
    return <NotFoundState />;
  }

  // The builder/embed layer can request a specific placement (e.g. a modal
  // preview) via ?placement=; only honor it if the template actually
  // supports that placement (build spec §13 "the builder only offers
  // placements the chosen template supports" — applies just as much here).
  const requested = typeof sp.placement === "string" ? (sp.placement as Placement) : undefined;
  const placement =
    requested && resolved.spec.placements.includes(requested) ? requested : resolved.placement;

  return <PlayRuntime spec={resolved.spec} placement={placement} slug={slug} />;
}

function NotFoundState() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 160,
        fontFamily: "system-ui, sans-serif",
        color: "#8a8a8a",
        fontSize: 14,
        background: "transparent",
      }}
    >
      This game isn&apos;t available.
    </div>
  );
}
