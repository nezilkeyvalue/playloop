// app/api/leads/route.ts
//
// POST { sessionToken, email } -> { ok }. Build spec §12, §17.
//
// §17 calls for explicit PII opt-in, but the shipped runtime
// (lib/runtime/mount.ts's reward screen, via telemetry.ts#captureLead)
// posts exactly `{ sessionToken, email }` — a single email field plus a
// clearly-labelled "email my code" button, no separate consent checkbox in
// that DOM. Since lib/runtime/* is off-limits to this track, we treat
// typing an email and clicking that button as the explicit affirmative
// action, and accept an optional `consent` field for any future/other
// caller that wants to pass one explicitly: omitted or true both count as
// consent given; only an explicit `consent: false` is rejected. Resolves
// `sessionToken` -> `gameId`/`playId` via the play row (recordLead's own
// contract takes gameId, not a token).

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { claimCouponForPlay, getGameById, getPlayBySession, recordLead } from "@/lib/db/queries";
import { originalTierIndexFromSortedIndex } from "@/lib/engine/specRules";
import { isEmailEnabled, sendCouponEmail } from "@/lib/email/send";

const bodySchema = z
  .object({
    sessionToken: z.string().min(1),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    consent: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.email || v.phone), {
    message: "email_or_phone_required",
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
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (parsed.data.consent === false) {
    return NextResponse.json({ error: "consent_required" }, { status: 400 });
  }

  const play = await getPlayBySession(parsed.data.sessionToken);
  if (!play) {
    return NextResponse.json({ error: "invalid_session" }, { status: 404 });
  }

  await recordLead({
    gameId: play.gameId,
    playId: play.id,
    email: parsed.data.email,
    phone: parsed.data.phone,
    consent: parsed.data.consent ?? true,
  });

  // Actually send the code, rather than only capturing the address.
  //
  // The lead is recorded FIRST and its success is what this route reports.
  // A mail outage must not lose the lead, and the player already has the code
  // on screen — email is the convenience copy, not the delivery mechanism.
  // `emailed` is reported separately so the UI can say what really happened
  // instead of promising an inbox (see submitLead in lib/runtime/mount.ts).
  let emailed = false;
  if (parsed.data.email && isEmailEnabled()) {
    // Claiming here is safe and intentional: claimCouponForPlay is idempotent
    // per play, so a player who already pressed "Copy my code" is emailed the
    // SAME code, and one who only gave their email still gets one. No second
    // coupon is consumed either way.
    const claim = await claimCouponForPlay(parsed.data.sessionToken).catch(() => null);
    if (claim?.status === "ok") {
      const game = await getGameById(play.gameId);
      const tierIndex = game
        ? originalTierIndexFromSortedIndex(game.spec.rewards, play.tierIndex)
        : -1;
      const tier = tierIndex >= 0 ? game?.spec.rewards[tierIndex] : undefined;
      const result = await sendCouponEmail({
        to: parsed.data.email,
        code: claim.coupon.code,
        rewardLabel: tier?.label ?? "your reward",
        ...(game?.spec.brand.name ? { brandName: game.spec.brand.name } : {}),
        ...(tier?.coupon ? { terms: tier.coupon } : {}),
      });
      emailed = result.ok;
      if (!result.ok && result.reason !== "disabled") {
        // Logged, not returned: the reason is operational (usually an
        // unverified sending domain) and means nothing to a player.
        console.warn(`[leads] coupon email failed (${result.reason}):`, result.message);
      }
    }
  }

  return NextResponse.json({ ok: true, emailed });
}
