// app/api/plays/start/route.ts
//
// POST { slug } -> { sessionToken }. Build spec §12, §14, §17.
//
// Looks the game up by slug (404 if not published) and enforces the
// domain allowlist: `games.allowed_hosts` checked against
// Sec-Fetch-Site / Referer, per §14. An empty allowlist is the default,
// unrestricted state for a freshly published game — every origin is
// allowed until the owner sets one.

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getGameBySlug, startPlay } from "@/lib/db/queries";

const bodySchema = z.object({
  slug: z.string().min(1),
  replayOfSessionToken: z.string().min(1).optional(),
});

function hostAllowed(hostname: string, allowedHosts: string[]): boolean {
  return allowedHosts.some(
    (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
  );
}

function detectDevice(userAgent: string | null): "mobile" | "desktop" {
  if (userAgent && /Mobi|Android|iPhone|iPad|iPod/i.test(userAgent)) return "mobile";
  return "desktop";
}

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

  const game = await getGameBySlug(parsed.data.slug);
  if (!game) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (game.allowedHosts.length > 0) {
    const referer = req.headers.get("referer");
    const origin = req.headers.get("origin");
    const candidate = referer ?? origin;
    let hostname: string | null = null;
    if (candidate) {
      try {
        hostname = new URL(candidate).hostname;
      } catch {
        hostname = null;
      }
    }
    if (!hostname || !hostAllowed(hostname, game.allowedHosts)) {
      return NextResponse.json({ error: "host_not_allowed" }, { status: 403 });
    }
  }

  const referrer = req.headers.get("referer");
  const device = detectDevice(req.headers.get("user-agent"));
  const { sessionToken } = await startPlay(game.id, {
    referrer,
    device,
    replayOfSessionToken: parsed.data.replayOfSessionToken,
  });

  return NextResponse.json({ sessionToken });
}
