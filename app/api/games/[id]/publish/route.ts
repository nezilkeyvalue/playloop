// app/api/games/[id]/publish/route.ts
//
// POST { placement } -> { slug, embed }. Mints a slug (first publish only —
// re-publishing keeps the existing slug) and returns the literal two-line
// embed snippet from build spec §14.

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  findIncompleteRoles,
  getCapability,
  supportsPlacement,
} from "@/lib/capabilities";
import { publishGame, getGameById } from "@/lib/db/queries";
import { notFound, ownsRecord, requireAccount } from "@/lib/auth/server";
import { buildEmbedSnippet } from "@/lib/engine/embedSnippet";

const bodySchema = z.object({
  placement: z.enum(["section", "fullpage", "modal", "ad"]),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Publishing puts a game on a live storefront under a public slug. It is
  // the single most consequential write in the app, so it is owner-only.
  const auth = await requireAccount();
  if (!auth.ok) return auth.response;

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

  const game = await getGameById(id);
  if (!game || !ownsRecord(game, auth.accountId)) return notFound();

  const capability = getCapability(game.spec.template);
  if (capability && !supportsPlacement(capability, parsed.data.placement)) {
    return NextResponse.json(
      { error: "unsupported_placement", template: game.spec.template },
      { status: 400 },
    );
  }

  // Publishing is the last boundary in front of real players. The pipeline
  // never emits a spec with an unfilled `fallback: "none"` role (matcher.ts
  // marks the template ineligible instead) and the PATCH schema refuses to
  // write one, so this catches only a spec that got here some other way — but
  // an unplayable game on a live storefront is the one failure worth checking
  // twice.
  const gaps = findIncompleteRoles(game.spec);
  if (gaps.length > 0) {
    return NextResponse.json(
      { error: "incomplete_roles", gaps },
      { status: 400 },
    );
  }

  const updated = await publishGame(id, parsed.data.placement);
  const slug = updated.slug!;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://playloop.app";
  const embed = buildEmbedSnippet({
    slug,
    template: updated.spec.template,
    placement: parsed.data.placement,
    appUrl,
  });
  return NextResponse.json({ slug, embed });
}
