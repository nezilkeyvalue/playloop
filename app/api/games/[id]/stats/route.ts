// app/api/games/[id]/stats/route.ts
//
// GET -> the getGameStats() aggregate (plays, completion rate, avg score,
// replay rate, rewards by tier, leads captured, device split, top
// referrers — spec §16). Not listed in the build spec's §12 API table, but
// this track owns "all API routes" per the build brief, and the dashboard
// page (app/(app)/games/[id]/stats/page.tsx) needs a client-safe way to
// reach the server-only getGameStats() query — a small, uncontested
// addition under app/api/**, which no other track touches.

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getGameById, getGameStats } from "@/lib/db/queries";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const game = await getGameById(id);
  if (!game) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const stats = await getGameStats(id);
  return NextResponse.json(stats);
}
