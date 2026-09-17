// lib/storage.ts
//
// Blob upload abstraction (build spec §2 stack decisions, §12/§23 gotchas:
// "4.5MB payload cap — sprite responses fail; blob storage, return URLs").
//
// Backed by Supabase Storage when a project is configured, and by local disk
// otherwise — the same "configure it or run with zero external accounts"
// switch lib/db/client.ts#isDevMode applies to the database, so the two
// halves of persistence turn on together.
//
// NEVER treat the local-disk path as production-durable: on Vercel there is
// no persistent filesystem (build spec §2/§23 — /tmp, and any other on-disk
// path, is per-invocation). It exists purely so the pipeline runs end-to-end
// with nothing configured. Those files are served back out by the sibling
// route at app/dev-blob/[...path]/route.ts.
//
// Why Supabase Storage and not @vercel/blob: the database is already
// Supabase, the bucket is provisioned by the same migration that creates the
// tables (supabase/migrations/*_auth_and_storage.sql), and it needs no
// additional account, dependency or token beyond SUPABASE_SERVICE_ROLE_KEY,
// which the db layer already requires. @vercel/blob would add a second
// storage vendor and a second credential for no gain here.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getSupabaseServerClient, isDevMode } from "@/lib/db/client";

const DEV_BLOB_DIR = path.join(process.cwd(), "dev-data", "blob");

/**
 * Must match the bucket created in the storage migration. Overridable so a
 * staging deploy can point at its own bucket without a code change.
 */
export const SPRITE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "sprites";

export interface UploadResult {
  url: string;
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

/**
 * Content-addressed object name. Two identical buffers produce the same key,
 * so re-running generation on the same site re-uploads over the same object
 * instead of growing the bucket forever — the storage-side counterpart to
 * the phash dedup in lib/engine/sprites.ts.
 */
function objectName(buffer: Buffer, contentType: string): string {
  const ext = EXT_BY_CONTENT_TYPE[contentType] ?? "bin";
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 24);
  return `${hash}.${ext}`;
}

/**
 * Uploads a processed sprite buffer and returns a URL the runtime/preview
 * can point an <img>/canvas texture at. Never returns the buffer itself —
 * callers must not try to inline sprite bytes into any API response (that's
 * exactly the 4.5MB-payload trap this function exists to avoid).
 */
export async function uploadSprite(buffer: Buffer, contentType: string): Promise<UploadResult> {
  if (isDevMode()) {
    return uploadToLocalDisk(buffer, contentType);
  }
  return uploadToSupabaseStorage(buffer, contentType);
}

async function uploadToSupabaseStorage(
  buffer: Buffer,
  contentType: string,
): Promise<UploadResult> {
  const supabase = getSupabaseServerClient();
  const name = objectName(buffer, contentType);

  const { error } = await supabase.storage.from(SPRITE_BUCKET).upload(name, buffer, {
    contentType,
    // Content-addressed, so an existing object with this name is byte-identical
    // to what we're writing. Upserting is a no-op in effect and avoids a
    // spurious "resource already exists" failure on a re-run.
    upsert: true,
    // Sprites are immutable for the same reason: the name IS the hash, so the
    // bytes behind a given URL can never change. Cache them hard — an embed on
    // a busy storefront re-fetches these on every page view otherwise.
    //
    // NOT a full Cache-Control value: Supabase Storage emits
    // `public, max-age=<this>`, so passing the whole directive string here
    // yields the malformed `public, max-age=public, max-age=...`. Verified
    // against the live bucket: this produces exactly
    // `public, max-age=31536000, immutable`.
    cacheControl: "31536000, immutable",
  });

  if (error) {
    throw new Error(
      `Supabase Storage upload failed for bucket "${SPRITE_BUCKET}": ${error.message}. ` +
        "If this says the bucket does not exist, run `supabase db push` — the bucket " +
        "is created by supabase/migrations/*_auth_and_storage.sql.",
    );
  }

  // Absolute, public, CDN-served URL. It must be absolute: the embed script
  // renders these on third-party storefronts, where a relative path would
  // resolve against the customer's own domain.
  const { data } = supabase.storage.from(SPRITE_BUCKET).getPublicUrl(name);
  return { url: data.publicUrl };
}

async function uploadToLocalDisk(buffer: Buffer, contentType: string): Promise<UploadResult> {
  const filename = objectName(buffer, contentType);

  await mkdir(DEV_BLOB_DIR, { recursive: true });
  await writeFile(path.join(DEV_BLOB_DIR, filename), buffer);

  // Relative URL — resolves against whatever origin actually serves the app
  // (dev port, preview deploy, etc.) rather than trusting NEXT_PUBLIC_APP_URL
  // to be correct for every environment this pipeline runs in.
  return { url: `/dev-blob/${filename}` };
}
