// app/api/games/route.ts
//
// POST { spec, name, placement } -> { id }  (manual creation, build spec §12)
// GET                            -> Game[]

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createGame, listGames } from "@/lib/db/queries";
import type { GameSpec } from "@/lib/engine/types";

const placementSchema = z.enum(["section", "fullpage", "modal", "ad"]);

// A pragmatic shape check rather than a full structural validation of
// GameSpec — this route is fed by our own manual-build wizard
// (app/(app)/build/manual/page.tsx), which already assembles a complete,
// well-formed spec client-side. We still gate on the fields that matter for
// downstream code (template id, at least one placement, positive duration).
const gameSpecSchema = z
  .object({
    id: z.string(),
    version: z.literal(1),
    // Every implemented template, not just the first two — this had gone
    // stale (chain_pop and shooter were both added elsewhere without this
    // enum being updated to match), which meant manual mode could not
    // actually create a game for either despite both being fully
    // implemented and selectable in auto mode. Keep this in sync with
    // TemplateId (lib/engine/types.ts) and the capabilities registry's own
    // enum (lib/capabilities/index.ts) — see docs/ADDING_A_TEMPLATE.md.
    template: z.enum(["catch", "guess_price", "chain_pop", "shooter", "sweet_spot", "match", "stack"]),
    placements: z.array(placementSchema).min(1),
    brand: z.record(z.any()),
    copy: z.record(z.any()),
    assets: z.array(z.record(z.any())),
    roles: z.record(z.any()),
    rewards: z.array(z.record(z.any())).min(1),
    durationSeconds: z.number().positive(),
    tuning: z.record(z.number()),
    meta: z.record(z.any()),
  })
  .passthrough();

const bodySchema = z.object({
  name: z.string().min(1),
  placement: placementSchema,
  spec: gameSpecSchema,
  // Same discipline as POST /api/generate's rightsConfirmed: the manual
  // build wizard (app/(app)/build/manual/page.tsx) already gates its own
  // submit button on this checkbox, but that's cosmetic without a server-
  // side check too — a direct API call could just omit it.
  rightsConfirmed: z.literal(true, {
    errorMap: () => ({ message: "You must confirm you have the rights to use these images." }),
  }),
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

  const game = await createGame({
    accountId: null, // MVP stub: single implicit dev account, see queries.ts
    name: parsed.data.name,
    spec: parsed.data.spec as unknown as GameSpec,
    placement: parsed.data.placement,
  });

  return NextResponse.json({ id: game.id });
}

export async function GET() {
  const games = await listGames(null);
  return NextResponse.json(games);
}
