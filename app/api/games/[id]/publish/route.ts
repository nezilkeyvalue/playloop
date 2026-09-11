// app/api/games/[id]/publish/route.ts
//
// POST { placement } -> { slug, embed }. Mints a slug (first publish only —
// re-publishing keeps the existing slug) and returns the literal two-line
// embed snippet from build spec §14.

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCapability, supportsPlacement } from "@/lib/capabilities";
import { publishGame, getGameById } from "@/lib/db/queries";

const bodySchema = z.object({
  placement: z.enum(["section", "fullpage", "modal", "ad"]),
});

function buildEmbedSnippet(slug: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://playloop.app";
  return `<div data-playloop="${slug}"></div>\n<script src="${appUrl}/embed.js" async></script>`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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
  if (!game) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const capability = getCapability(game.spec.template);
  if (capability && !supportsPlacement(capability, parsed.data.placement)) {
    return NextResponse.json(
      { error: "unsupported_placement", template: game.spec.template },
      { status: 400 },
    );
  }

  const updated = await publishGame(id, parsed.data.placement);
  const slug = updated.slug!;
  return NextResponse.json({ slug, embed: buildEmbedSnippet(slug) });
}
