export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { analyticsRangeFromDays, parseAnalyticsDays } from "@/lib/analytics/types";
import { getGameAnalytics, getGameById } from "@/lib/db/queries";
import { notFound, ownsRecord, requireAccount } from "@/lib/auth/server";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const auth = await requireAccount();
  if (!auth.ok) return auth.response;

  const game = await getGameById(id);
  if (!game || !ownsRecord(game, auth.accountId)) return notFound();

  const days = parseAnalyticsDays(req.nextUrl.searchParams.get("days"));
  const range = analyticsRangeFromDays(days);
  const analytics = await getGameAnalytics(id, range);
  if (!analytics) return notFound();

  return NextResponse.json(analytics);
}
