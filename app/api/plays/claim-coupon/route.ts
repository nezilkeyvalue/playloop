// app/api/plays/claim-coupon/route.ts
//
// POST { sessionToken } -> { status, code?, terms? }
//
// The player-facing end of coupon pools. PUBLIC by necessity — it is called
// from the embed running on a third-party storefront, where there is no
// PlayLoop session — so the play's own session token is the only credential,
// exactly as with /api/plays/finish.
//
// What stops this being a way to drain a pool:
//   - the token is server-minted by /api/plays/start and unguessable;
//   - claiming requires the play to be FINISHED, so finishPlay's anti-forgery
//     checks (score ceiling, elapsed-time floor, single-use) have already run
//     and a forged score has already been zeroed to "no reward";
//   - one code per play, enforced by a unique index, so replaying the same
//     token cannot consume a second coupon.
//
// Deliberately separate from /api/plays/finish rather than folded into it:
// the build decision was that a coupon is consumed when the player COPIES it,
// not when the game ends, so that players who close the tab don't silently
// burn codes. Finish tells them what they won; this hands it over.

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { claimCouponForPlay } from "@/lib/db/queries";

const bodySchema = z.object({
  sessionToken: z.string().min(1),
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
    const outcome = await claimCouponForPlay(parsed.data.sessionToken);

    // Every non-ok outcome is a 200 with a status string, not an HTTP error.
    // "the pool ran out" and "this offer expired" are normal, expected
    // states of a live campaign that the reward screen renders as copy — not
    // failures the embed should treat as a network problem and retry.
    if (outcome.status !== "ok") {
      return NextResponse.json({ status: outcome.status, code: null });
    }

    return NextResponse.json({
      status: "ok",
      code: outcome.coupon.code,
      reused: outcome.coupon.reused,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "claim_failed";
    const status =
      message === "invalid_session" || message === "game_not_found"
        ? 404
        : message === "session_not_finished"
          ? 409
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
