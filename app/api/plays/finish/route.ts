// app/api/plays/finish/route.ts
//
// POST { sessionToken, score } -> { tier, code }. Build spec §12, §17.
//
// All anti-forgery validation (single-use token, 10-minute expiry, score vs
// scoring.maxRealistic, elapsed-time floor) lives in
// lib/db/queries.ts#finishPlay — this route only maps its outcomes to HTTP
// status codes.
//
// `tier` is returned as the tier's label (a string) rather than the whole
// RewardTier object — lib/runtime/telemetry.ts's endSession() types the
// response as `{ tier: string; code: string }` and only actually reads
// `code` (the runtime resolves its own display tier client-side from
// spec.rewards via lib/runtime/reward.ts); matching that shape here avoids
// a silent contract mismatch even though `tier` itself goes unused there.

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { finishPlay } from "@/lib/db/queries";

const bodySchema = z.object({
  sessionToken: z.string().min(1),
  score: z.number().finite(),
});

export async function POST(req: NextRequest) {
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

  try {
    const result = await finishPlay(parsed.data.sessionToken, parsed.data.score);
    return NextResponse.json({
      tier: result.tier?.label ?? null,
      tierIndex: result.tierIndex,
      code: result.code ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "finish_failed";
    const status =
      message === "invalid_session" || message === "game_not_found"
        ? 404
        : message === "session_already_used"
          ? 409
          : message === "session_expired"
            ? 410
            : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
