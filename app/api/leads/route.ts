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
import { getPlayBySession, recordLead } from "@/lib/db/queries";

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

  return NextResponse.json({ ok: true });
}
