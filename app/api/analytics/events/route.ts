// POST /api/analytics/events — public lifecycle markers (build spec §16).

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getGameBySlug, getPlayBySession, recordAnalyticsEvent } from "@/lib/db/queries";
import { checkAnalyticsEventRateLimit } from "@/lib/rateLimit";

const eventSchema = z.enum([
  "impression",
  "start",
  "complete",
  "replay",
  "reward_revealed",
  "lead_captured",
]);

const bodySchema = z.object({
  slug: z.string().min(1),
  event: eventSchema,
  sessionToken: z.string().min(1).optional(),
  detail: z.record(z.unknown()).optional(),
});

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const limited = checkAnalyticsEventRateLimit(ip);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const game = await getGameBySlug(parsed.data.slug);
  if (!game || game.status !== "published") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let playId: string | null = null;
  if (parsed.data.sessionToken) {
    const play = await getPlayBySession(parsed.data.sessionToken);
    if (!play || play.gameId !== game.id) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    playId = play.id;
  }

  await recordAnalyticsEvent({
    gameId: game.id,
    playId,
    event: parsed.data.event,
    detail: parsed.data.detail ?? null,
  });

  return NextResponse.json({ ok: true });
}
