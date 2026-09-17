// app/api/upload/route.ts
//
// POST multipart -> { assets[] }. Manual-mode asset upload, build spec §12.
// Parsed with the native Request.formData() Web API (no form-data
// dependency needed). Storage is owned by a different track
// (lib/storage.ts, `uploadSprite(buffer, contentType) -> { url }`) — per-file
// upload failures are caught and reported in `errors` rather than crashing
// the whole request.

export const runtime = "nodejs";

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { uploadSprite } from "@/lib/storage";
import { requireAccount } from "@/lib/auth/server";

const MAX_FILES = 12;
const MAX_BYTES = 8 * 1024 * 1024; // 8MB/file — generous for source packshots

export async function POST(req: NextRequest) {
  // Uploads now land in a shared Supabase Storage bucket rather than a local
  // scratch directory, which makes this route a write to real infrastructure.
  // Sign-in is the cheapest bound on someone using it as free image hosting.
  const auth = await requireAccount();
  if (!auth.ok) return auth.response;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid_multipart" }, { status: 400 });
  }

  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "no_files" }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json({ error: "too_many_files", max: MAX_FILES }, { status: 400 });
  }

  const assets: { id: string; url: string; name: string }[] = [];
  const errors: { name: string; error: string }[] = [];

  for (const file of files) {
    if (file.size > MAX_BYTES) {
      errors.push({ name: file.name, error: "file_too_large" });
      continue;
    }
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const uploaded = await uploadSprite(buffer, file.type || "application/octet-stream");
      assets.push({ id: randomUUID(), url: uploaded.url, name: file.name });
    } catch (err) {
      errors.push({
        name: file.name,
        error: err instanceof Error ? err.message : "upload_failed",
      });
    }
  }

  return NextResponse.json({ assets, errors });
}
