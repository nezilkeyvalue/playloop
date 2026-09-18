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

  // Only embed.js's own "fullpage" mounting sets this — the exact pixel
  // height of the visitor's real browser viewport, measured by the PARENT
  // page (the only place that can; see app/embed.js/route.ts's comment on
  // why a CSS vh unit inside this iframe can't answer the same question).
  const rawViewportHeight = typeof sp.viewportHeight === "string" ? Number(sp.viewportHeight) : NaN;
  const viewportHeight = Number.isFinite(rawViewportHeight) && rawViewportHeight > 0 ? rawViewportHeight : undefined;

  // A merchant's own custom size choice (embed/page.tsx's Size section),
  // forwarded by embed.js from data-width/data-height exactly like
  // data-placement is. Parsed here rather than trusted as-is: a malformed
  // or hostile query string must degrade to "no override" (the template's
  // own responsive default), never a broken/NaN stage size.
  const rawWidth = typeof sp.width === "string" ? Number(sp.width) : NaN;
  const rawHeight = typeof sp.height === "string" ? Number(sp.height) : NaN;
  const sizeOverride = {
    maxWidth: Number.isFinite(rawWidth) && rawWidth > 0 ? rawWidth : undefined,
    height: Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : undefined,
  };

  // A host embedding this iframe can pick one of the runtime's named brand
  // skins with ?theme= (lib/runtime/games/runnerTheme.ts). Validated against
  // the known keys in PlayRuntime rather than trusted — an unknown value
  // renders the game's own derived theme, which is also the no-param case.
  const themePreset = typeof sp.theme === "string" ? sp.theme : undefined;

  return (
    <PlayRuntime
      spec={resolved.spec}
      placement={placement}
      slug={slug}
      viewportHeight={viewportHeight}
      sizeOverride={sizeOverride}
      themePreset={themePreset}
    />
  );
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
