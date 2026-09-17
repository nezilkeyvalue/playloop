// app/api/games/[id]/coupons/route.ts
//
// Owner-only coupon pool management for one game.
//
//   GET                      -> { tiers: CouponTierStats[], sample }
//   POST (json)              -> generate N codes, or accept a pasted list
//   POST (multipart)         -> import a .csv / .xlsx file
//   DELETE ?tierIndex=n      -> drop UNCLAIMED codes from that tier
//
// The codes themselves are never exposed to a player through this route —
// that is POST /api/plays/claim-coupon, which hands out exactly one. Anything
// here is behind requireAccount() + ownsRecord(), because a leaked pool is a
// leaked pile of money.

export const runtime = "nodejs"; // exceljs is a Node library; never Edge.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { notFound, ownsRecord, requireAccount } from "@/lib/auth/server";
import {
  addCoupons,
  deleteUnclaimedCoupons,
  getCouponStats,
  getGameById,
  listCoupons,
} from "@/lib/db/queries";
import {
  MAX_CODES_PER_REQUEST,
  MAX_GENERATE_COUNT,
  CODE_MAX_LENGTH,
  CODE_MIN_LENGTH,
  generateCodes,
  normalizeCodeBatch,
} from "@/lib/coupons/codes";
import { parseCouponFile } from "@/lib/coupons/parse";

/** 8MB, same ceiling as the sprite upload route. A 5k-code CSV is ~60KB. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

async function loadOwnedGame(id: string) {
  const auth = await requireAccount();
  if (!auth.ok) return { ok: false as const, response: auth.response };
  const game = await getGameById(id);
  if (!game || !ownsRecord(game, auth.accountId)) {
    return { ok: false as const, response: notFound() };
  }
  return { ok: true as const, game };
}

/** Rejects a tier index that isn't a real tier in this game's spec. */
function tierExists(rewardsLength: number, tierIndex: number): boolean {
  return Number.isInteger(tierIndex) && tierIndex >= 0 && tierIndex < rewardsLength;
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loaded = await loadOwnedGame(id);
  if (!loaded.ok) return loaded.response;

  const tiers = await getCouponStats(id);

  // A small sample only, and only when explicitly asked for. The editor shows
  // counts by default: rendering thousands of live codes into a page that
  // might be screen-shared is a needless way to leak them.
  const wantSample = req.nextUrl.searchParams.get("sample") === "1";
  const rawTier = req.nextUrl.searchParams.get("tierIndex");
  const tierIndex = rawTier === null ? undefined : Number(rawTier);

  let sample: { code: string; claimed: boolean }[] = [];
  if (wantSample) {
    const rows = await listCoupons({
      gameId: id,
      ...(tierIndex !== undefined && Number.isInteger(tierIndex) ? { tierIndex } : {}),
      limit: 20,
    });
    sample = rows.map((r) => ({ code: r.code, claimed: r.claimedAt !== null }));
  }

  return NextResponse.json({ tiers, sample });
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

const generateSchema = z.object({
  mode: z.literal("generate"),
  tierIndex: z.number().int().min(0),
  count: z.number().int().min(1).max(MAX_GENERATE_COUNT),
  length: z.number().int().min(CODE_MIN_LENGTH).max(CODE_MAX_LENGTH).optional(),
  prefix: z.string().max(CODE_MAX_LENGTH).optional(),
});

const listSchema = z.object({
  mode: z.literal("list"),
  tierIndex: z.number().int().min(0),
  /** Pasted codes — newline, comma or space separated. */
  codes: z.array(z.string()).max(MAX_CODES_PER_REQUEST),
});

const bodySchema = z.discriminatedUnion("mode", [generateSchema, listSchema]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loaded = await loadOwnedGame(id);
  if (!loaded.ok) return loaded.response;
  const rewardsLength = loaded.game.spec.rewards.length;

  const contentType = req.headers.get("content-type") ?? "";

  // ---- multipart: a .csv / .xlsx upload ----------------------------------
  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: "invalid_multipart" }, { status: 400 });
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "no_file" }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: "file_too_large", maxBytes: MAX_UPLOAD_BYTES },
        { status: 400 },
      );
    }

    const tierIndex = Number(form.get("tierIndex"));
    if (!tierExists(rewardsLength, tierIndex)) {
      return NextResponse.json({ error: "unknown_tier", tierIndex }, { status: 400 });
    }

    let parsed;
    try {
      parsed = await parseCouponFile(
        Buffer.from(await file.arrayBuffer()),
        file.name,
        file.type,
      );
    } catch (err) {
      // The thrown message here is merchant-facing copy (see parse.ts), so it
      // is passed through rather than replaced with a machine code.
      return NextResponse.json(
        { error: "unsupported_file", message: err instanceof Error ? err.message : undefined },
        { status: 400 },
      );
    }

    if (parsed.raw.length > MAX_CODES_PER_REQUEST) {
      return NextResponse.json(
        { error: "too_many_codes", max: MAX_CODES_PER_REQUEST, found: parsed.raw.length },
        { status: 400 },
      );
    }

    const cleaned = normalizeCodeBatch(parsed.raw);
    const result = await addCoupons({ gameId: id, tierIndex, codes: cleaned.codes });

    return NextResponse.json({
      ...result,
      // Echoed so the merchant can confirm we read the column they meant —
      // the single most likely way a spreadsheet import goes silently wrong.
      source: {
        format: parsed.format,
        columnHeader: parsed.columnHeader ?? null,
        columnIndex: parsed.columnIndex,
        rowsScanned: parsed.rowsScanned,
      },
      skipped: {
        blank: cleaned.blank,
        duplicatesInFile: cleaned.duplicates,
        invalid: cleaned.invalid.slice(0, 10),
        invalidCount: cleaned.invalid.length,
      },
      tiers: await getCouponStats(id),
    });
  }

  // ---- json: generate, or a pasted list ----------------------------------
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsedBody = bodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsedBody.data;

  if (!tierExists(rewardsLength, body.tierIndex)) {
    return NextResponse.json({ error: "unknown_tier", tierIndex: body.tierIndex }, { status: 400 });
  }

  if (body.mode === "generate") {
    let generated;
    try {
      generated = generateCodes({
        count: body.count,
        ...(body.length !== undefined ? { length: body.length } : {}),
        ...(body.prefix !== undefined ? { prefix: body.prefix } : {}),
      });
    } catch (err) {
      return NextResponse.json(
        { error: "invalid_generate", message: err instanceof Error ? err.message : undefined },
        { status: 400 },
      );
    }

    const result = await addCoupons({
      gameId: id,
      tierIndex: body.tierIndex,
      codes: generated.codes,
    });
    return NextResponse.json({
      ...result,
      requested: body.count,
      // Non-zero means the keyspace is tight for the chosen length; the UI
      // turns this into "ask for longer codes" rather than leaving the
      // merchant wondering why they got fewer than they asked for.
      collisions: generated.collisions,
      tiers: await getCouponStats(id),
    });
  }

  const cleaned = normalizeCodeBatch(body.codes);
  const result = await addCoupons({
    gameId: id,
    tierIndex: body.tierIndex,
    codes: cleaned.codes,
  });
  return NextResponse.json({
    ...result,
    skipped: {
      blank: cleaned.blank,
      duplicatesInFile: cleaned.duplicates,
      invalid: cleaned.invalid.slice(0, 10),
      invalidCount: cleaned.invalid.length,
    },
    tiers: await getCouponStats(id),
  });
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loaded = await loadOwnedGame(id);
  if (!loaded.ok) return loaded.response;

  const rawTier = req.nextUrl.searchParams.get("tierIndex");
  const tierIndex = rawTier === null ? undefined : Number(rawTier);
  if (rawTier !== null && !tierExists(loaded.game.spec.rewards.length, Number(rawTier))) {
    return NextResponse.json({ error: "unknown_tier", tierIndex }, { status: 400 });
  }

  const removed = await deleteUnclaimedCoupons({
    gameId: id,
    ...(tierIndex !== undefined ? { tierIndex } : {}),
  });

  return NextResponse.json({ removed, tiers: await getCouponStats(id) });
}
