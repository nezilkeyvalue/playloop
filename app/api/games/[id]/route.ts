// app/api/games/[id]/route.ts
//
// GET    -> GameSpec (build spec §12). Pass ?full=1 to get the whole
//           GameRecord instead (name/status/slug/placement/allowedHosts) —
//           an additive, contract-compatible extension this track's own
//           preview/editor page (app/(app)/games/[id]/page.tsx) uses; the
//           bare contract call is unchanged.
// PATCH  { spec patch } -> GameSpec. The body is schema-validated by
//           lib/engine/specPatch.ts before it is persisted: unknown top-level
//           keys are refused, every nested object must arrive complete (the
//           store shallow-merges, so a partial one erases its siblings), and
//           values are judged against the STORED spec. A rejection is a 400
//           carrying { error, field, message } where `message` is written to
//           be shown to the merchant verbatim.
// DELETE -> { ok }

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { deleteGame, getGameById, updateGameSpec } from "@/lib/db/queries";
import { notFound, ownsRecord, requireAccount } from "@/lib/auth/server";
import { validateSpecPatch } from "@/lib/engine/specPatch";

/**
 * Every method here is an owner-only operation on one game. Resolving the
 * caller and the row together in one helper keeps the three handlers from
 * drifting — a GET that forgot the ownership check would happily hand a
 * competitor's whole GameSpec (including product imagery and reward copy) to
 * anyone who guessed a uuid.
 *
 * A row belonging to someone else reads as 404, not 403 — see the note on
 * ownsRecord() in lib/auth/server.ts.
 */
async function loadOwnedGame(id: string) {
  const auth = await requireAccount();
  if (!auth.ok) return { ok: false as const, response: auth.response };

  const game = await getGameById(id);
  if (!game || !ownsRecord(game, auth.accountId)) {
    return { ok: false as const, response: notFound() };
  }
  return { ok: true as const, game };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loaded = await loadOwnedGame(id);
  if (!loaded.ok) return loaded.response;

  const full = req.nextUrl.searchParams.get("full");
  return NextResponse.json(full ? loaded.game : loaded.game.spec);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // The stored spec has to be read before validating, not just before writing:
  // the score ceiling reward tiers are judged against, the tuning ranges, and
  // role completeness all come from the stored template — never from anything
  // the client could put in the body.
  const loaded = await loadOwnedGame(id);
  if (!loaded.ok) return loaded.response;

  const result = await validateSpecPatch(raw, loaded.game.spec);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, field: result.field, message: result.message },
      { status: 400 },
    );
  }

  try {
    // Persist the validated, normalized patch — never the raw body.
    const updated = await updateGameSpec(id, result.patch);
    return NextResponse.json(updated.spec);
  } catch (err) {
    // Still reachable despite the fetch above: the game can be deleted between
    // the read and the write.
    if (err instanceof Error && err.message === "game_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loaded = await loadOwnedGame(id);
  if (!loaded.ok) return loaded.response;

  await deleteGame(id);
  return NextResponse.json({ ok: true });
}
