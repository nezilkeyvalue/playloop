// app/api/games/[id]/template/route.ts
//
// POST { template } -> GameSpec. Switches an existing game onto a different
// template. Deliberately its own route rather than a PATCH /api/games/[id]
// field: specPatch.ts's schema refuses `template` on purpose (see its
// comment — "the template the whole spec is shaped around" is not a plain
// editor field, because a client-submitted `roles`/`tuning` for a template
// it didn't generate can't be trusted). This route re-derives roles/tuning
// itself, server-side, via lib/engine/retemplate.ts, the same way the
// generation pipeline would for a brand new game.

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { RUNTIME_TEMPLATES, supportsPlacement, getCapability } from "@/lib/capabilities";
import { getGameById, getJobByGameId, updateGameSpec } from "@/lib/db/queries";
import { notFound, ownsRecord, requireAccount } from "@/lib/auth/server";
import { retemplateSpec } from "@/lib/engine/retemplate";

const bodySchema = z.object({
  template: z.enum(RUNTIME_TEMPLATES as [string, ...string[]]),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const auth = await requireAccount();
  if (!auth.ok) return auth.response;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", message: "Pick a template from the list." }, { status: 400 });
  }
  const template = parsed.data.template as (typeof RUNTIME_TEMPLATES)[number];

  const game = await getGameById(id);
  if (!game || !ownsRecord(game, auth.accountId)) return notFound();

  if (game.spec.template === template) {
    // Nothing to do — idempotent rather than an error, so a double-click
    // (or re-selecting the current template) isn't a failure state.
    return NextResponse.json(game.spec);
  }

  // A published game's embed placement is locked in on the merchant's own
  // storefront; switching to a template that can't render in that placement
  // would silently break a live embed the next time it loads.
  if (game.status === "published") {
    const newCap = getCapability(template);
    if (newCap && !supportsPlacement(newCap, game.placement)) {
      return NextResponse.json(
        {
          error: "unsupported_placement",
          message: `${newCap.name} doesn't support this game's "${game.placement}" placement. Unpublish or switch placement before changing templates.`,
        },
        { status: 400 },
      );
    }
  }

  const job = await getJobByGameId(id);
  if (!job || !job.inventory) {
    return NextResponse.json(
      {
        error: "no_inventory",
        message:
          "This game's original images aren't available for re-matching, so its template can't be changed here. (This happens for games built in manual mode.)",
      },
      { status: 400 },
    );
  }

  const result = retemplateSpec(game.spec, job.inventory, template);
  if (!result.ok) {
    return NextResponse.json({ error: "ineligible", message: result.message }, { status: 400 });
  }

  try {
    const updated = await updateGameSpec(id, result.patch);
    return NextResponse.json(updated.spec);
  } catch (err) {
    if (err instanceof Error && err.message === "game_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }
}
