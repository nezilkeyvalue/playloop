export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { analyticsRangeFromDays, parseAnalyticsDays } from "@/lib/analytics/types";
import { getAccountAnalytics } from "@/lib/db/queries";
import { requireAccount } from "@/lib/auth/server";

export async function GET(req: NextRequest) {
  const auth = await requireAccount();
  if (!auth.ok) return auth.response;

  const days = parseAnalyticsDays(req.nextUrl.searchParams.get("days"));
  const range = analyticsRangeFromDays(days);
  const analytics = await getAccountAnalytics(auth.accountId, range);
  return NextResponse.json(analytics);
}
