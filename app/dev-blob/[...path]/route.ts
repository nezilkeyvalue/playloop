// app/dev-blob/[...path]/route.ts
//
// Static file server for lib/storage.ts's local-disk dev fallback (see the
// Vercel Blob decision documented there). Serves whatever uploadSprite()
// wrote under ./dev-data/blob back out over HTTP.
//
// Dev-only by construction: there is no persistent filesystem on Vercel
// (build spec §2/§23), so this route only ever does anything useful when
// lib/storage.ts is also using its local-disk branch. Once real Vercel Blob
// is wired up, this route stops being reachable in practice and can be
// deleted.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

const DEV_BLOB_DIR = path.join(process.cwd(), "dev-data", "blob");

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await context.params;
  if (!segments || segments.length === 0) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Resolve and confirm the result stays inside DEV_BLOB_DIR — reject any
  // ".." traversal attempt before touching the filesystem.
  const requested = path.normalize(path.join(DEV_BLOB_DIR, ...segments));
  const withinBlobDir =
    requested === DEV_BLOB_DIR || requested.startsWith(DEV_BLOB_DIR + path.sep);
  if (!withinBlobDir) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const stats = await stat(requested);
    if (!stats.isFile()) return new NextResponse("Not found", { status: 404 });

    const buffer = await readFile(requested);
    const ext = path.extname(requested).toLowerCase();
    const contentType = CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        // Uploaded filenames are content-hashed, so a given path's bytes
        // never change — safe to cache aggressively.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
