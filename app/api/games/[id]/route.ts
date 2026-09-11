// app/api/games/[id]/route.ts
//
// GET    -> GameSpec (build spec §12). Pass ?full=1 to get the whole
//           GameRecord instead (name/status/slug/placement/allowedHosts) —
//           an additive, contract-compatible extension this track's own
//           preview/editor page (app/(app)/games/[id]/page.tsx) uses; the
//           bare contract call is unchanged.
// PATCH  { spec patch } -> GameSpec
// DELETE -> { ok }

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { deleteGame, getGameById, updateGameSpec } from "@/lib/db/queries";
import type { GameSpec } from "@/lib/engine/types";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const game = await getGameById(id);
  if (!game) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const full = req.nextUrl.searchParams.get("full");
  return NextResponse.json(full ? game : game.spec);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let patch: unknown;
  try {
    patch = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    const updated = await updateGameSpec(id, patch as Partial<GameSpec>);
    return NextResponse.json(updated.spec);
  } catch (err) {
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
  await deleteGame(id);
  return NextResponse.json({ ok: true });
}
