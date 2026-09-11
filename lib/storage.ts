// lib/storage.ts
//
// Blob upload abstraction (build spec §2 stack decisions, §12/§23 gotchas:
// "4.5MB payload cap — sprite responses fail; blob storage, return URLs").
//
// DEPENDENCY DECISION (call this out to whoever integrates next): the spec
// offered a choice between wiring up @vercel/blob with a graceful fallback,
// or skipping it entirely for now. @vercel/blob is NOT in package.json and
// this sandbox has no npm registry access to install or even type-check it
// against, so shipping an `await import("@vercel/blob")` here would be an
// untested guess dressed up as a real integration. We took the simpler,
// recommended path: always use the local-disk fallback below, and leave a
// concrete TODO for wiring up real Vercel Blob once this runs somewhere
// with registry access. If BLOB_READ_WRITE_TOKEN is set anyway, we log a
// loud warning and still use local disk, rather than silently ignoring the
// env var or crashing on a missing module.
//
// NEVER treat this local-disk path as production-durable: on Vercel there
// is no persistent filesystem (build spec §2/§23 — /tmp, and any other
// on-disk path, is per-invocation). This exists purely so the pipeline
// runs end-to-end in dev/this sandbox. Sprites are served back out by the
// sibling route at app/dev-blob/[...path]/route.ts.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEV_BLOB_DIR = path.join(process.cwd(), "dev-data", "blob");

export interface UploadResult {
  url: string;
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
};

let warnedAboutMissingBlobPackage = false;

/**
 * Uploads a processed sprite buffer and returns a URL the runtime/preview
 * can point an <img>/canvas texture at. Never returns the buffer itself —
 * callers must not try to inline sprite bytes into any API response (that's
 * exactly the 4.5MB-payload trap this function exists to avoid).
 */
export async function uploadSprite(buffer: Buffer, contentType: string): Promise<UploadResult> {
  if (process.env.BLOB_READ_WRITE_TOKEN && !warnedAboutMissingBlobPackage) {
    warnedAboutMissingBlobPackage = true;
    // TODO(follow-up, once deployed somewhere with npm registry access):
    // add "@vercel/blob" to package.json's dependencies and replace this
    // branch with something like:
    //
    //   const { put } = await import("@vercel/blob");
    //   const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 24);
    //   const ext = EXT_BY_CONTENT_TYPE[contentType] ?? "bin";
    //   const blob = await put(`sprites/${hash}.${ext}`, buffer, {
    //     access: "public",
    //     contentType,
    //     token: process.env.BLOB_READ_WRITE_TOKEN,
    //   });
    //   return { url: blob.url };
    //
    // Deliberately not implemented here: @vercel/blob cannot be installed
    // or verified in this sandbox, and shipping an unverified dynamic
    // import would be worse than a clearly-flagged local fallback.
    console.warn(
      "[lib/storage] BLOB_READ_WRITE_TOKEN is set, but @vercel/blob is not " +
        "installed — falling back to local-disk storage (dev only, not " +
        "durable on Vercel). See the TODO in lib/storage.ts.",
    );
  }
  return uploadToLocalDisk(buffer, contentType);
}

async function uploadToLocalDisk(buffer: Buffer, contentType: string): Promise<UploadResult> {
  const ext = EXT_BY_CONTENT_TYPE[contentType] ?? "bin";
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 24);
  const filename = `${hash}.${ext}`;

  await mkdir(DEV_BLOB_DIR, { recursive: true });
  await writeFile(path.join(DEV_BLOB_DIR, filename), buffer);

  // Relative URL — resolves against whatever origin actually serves the app
  // (dev port, preview deploy, etc.) rather than trusting NEXT_PUBLIC_APP_URL
  // to be correct for every environment this pipeline runs in.
  return { url: `/dev-blob/${filename}` };
}
