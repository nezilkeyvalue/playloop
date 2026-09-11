// lib/engine/sprites.ts
//
// Sprite processing (build spec §8): for each candidate —
//   download → decode → cutout → trim to alpha bbox → pad square →
//   resize SPRITE_SIZE → optional soft shadow → upload → fill in
//   RawAsset.pixels/alpha/background/colour/processed.
//
// Sharp-dependent throughout — only ever reachable from a route declaring
// `export const runtime = "nodejs"` (Edge cannot run sharp).

import sharp from "sharp";
import { safeFetchImage } from "@/lib/engine/safeFetch";
import { uploadSprite } from "@/lib/storage";
import type { RawAsset, SubjectType } from "@/lib/engine/types";
import { cutout, computePhash } from "./cutout";
import { extractColours } from "./palette";

const SPRITE_SIZE = Number(process.env.SPRITE_SIZE) || 256;
const MAX_CANDIDATE_IMAGES = Number(process.env.MAX_CANDIDATE_IMAGES) || 12;
// Full-resolution packshots can be huge; cap what we feed the flood-fill
// cutout (which is O(width*height)) — comfortably above SPRITE_SIZE and any
// short-edge/aspect check, while keeping per-image cost bounded.
const MAX_CUTOUT_DIMENSION = 1600;

export interface ProcessSpritesResult {
  /** Assets we could download + decode, with every downstream field filled. */
  processed: RawAsset[];
  /** Assets we could not process at all (network/decode failure) — these
   * never reach the quality gate; the caller should still warn about them. */
  dropped: { assetId: string; url: string; reason: string }[];
}

export async function processSprites(assets: RawAsset[]): Promise<ProcessSpritesResult> {
  // Build spec §6: "downloading — parallel, cap 12". We cap *which* assets
  // we even attempt, not just how many requests run concurrently — MAX_CANDIDATE_IMAGES
  // is a hard ceiling on total work per generation.
  const candidates = assets.slice(0, MAX_CANDIDATE_IMAGES);

  const settled = await Promise.all(candidates.map((asset) => processOne(asset)));

  const processed: RawAsset[] = [];
  const dropped: { assetId: string; url: string; reason: string }[] = [];
  for (const result of settled) {
    if (result.ok) processed.push(result.asset);
    else dropped.push({ assetId: result.assetId, url: result.url, reason: result.reason });
  }
  return { processed, dropped };
}

type ProcessOneResult =
  | { ok: true; asset: RawAsset }
  | { ok: false; assetId: string; url: string; reason: string };

async function processOne(asset: RawAsset): Promise<ProcessOneResult> {
  let downloadBuffer: Buffer;
  try {
    const res = await safeFetchImage(asset.url);
    if (!res.ok) {
      return { ok: false, assetId: asset.id, url: asset.url, reason: `download failed: HTTP ${res.status}` };
    }
    downloadBuffer = res.buffer;
  } catch (err) {
    return {
      ok: false,
      assetId: asset.id,
      url: asset.url,
      reason: `download failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let originalWidth: number;
  let originalHeight: number;
  let workingBuffer: Buffer;
  try {
    const image = sharp(downloadBuffer, { failOn: "none" });
    const meta = await image.metadata();
    if (!meta.width || !meta.height) {
      return { ok: false, assetId: asset.id, url: asset.url, reason: "could not decode image (no dimensions)" };
    }
    originalWidth = meta.width;
    originalHeight = meta.height;
    workingBuffer = await image
      .resize(MAX_CUTOUT_DIMENSION, MAX_CUTOUT_DIMENSION, { fit: "inside", withoutEnlargement: true })
      .toBuffer();
  } catch (err) {
    return {
      ok: false,
      assetId: asset.id,
      url: asset.url,
      reason: `decode failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const [cutoutResult, phash, colourSummary] = await Promise.all([
      cutout(workingBuffer),
      computePhash(workingBuffer),
      extractColours(workingBuffer),
    ]);

    const transformFlags: string[] = [];
    transformFlags.push(cutoutResult.alreadyHadAlpha ? "transform:alpha_passthrough" : "transform:cutout:flood");
    if (!cutoutResult.isolatable) transformFlags.push("transform:cutout:failed");

    const { buffer: spriteBuffer, coverage } = await buildSprite(cutoutResult.rgba, cutoutResult.width, cutoutResult.height);

    let finalSprite = spriteBuffer;
    if (cutoutResult.isolatable) {
      try {
        finalSprite = await addSoftShadow(spriteBuffer, SPRITE_SIZE);
        transformFlags.push("transform:shadow");
      } catch {
        // Shadow compositing is a nice-to-have (+0.05 qualityDelta in the
        // transform catalogue) — never let a compositing hiccup break
        // sprite processing for this asset.
      }
    }

    const uploadResult = await uploadSprite(finalSprite, "image/png");
    const aspect = originalHeight > 0 ? originalWidth / originalHeight : 1;

    const subjectType: SubjectType =
      asset.content.subjectType !== "unknown"
        ? asset.content.subjectType // e.g. "logo", set structurally by the logo ladder — trust it
        : guessSubjectType({ isolatable: cutoutResult.isolatable, coverage, aspect });

    const updated: RawAsset = {
      ...asset,
      pixels: { width: originalWidth, height: originalHeight, aspect },
      alpha: { has: true, coverage },
      background: {
        uniformity: cutoutResult.uniformity,
        dominant: cutoutResult.dominant,
        isolatable: cutoutResult.isolatable,
      },
      colour: colourSummary,
      content: { ...asset.content, subjectType },
      phash,
      // Placeholder score/flags here — quality.ts computes the real
      // confidence score once every gate check has run; transformFlags
      // record what sprites.ts actually did, for matcher.ts to read back.
      quality: { score: 0, flags: transformFlags },
      processed: {
        id: asset.id,
        spriteUrl: uploadResult.url,
        width: SPRITE_SIZE,
        height: SPRITE_SIZE,
        coverage,
        phash,
        score: 0,
        flags: transformFlags,
        data: asset.data,
      },
    };

    return { ok: true, asset: updated };
  } catch (err) {
    return {
      ok: false,
      assetId: asset.id,
      url: asset.url,
      reason: `processing failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Trim to alpha bbox → pad square → resize SPRITE_SIZE. Returns the final
 * PNG buffer and its alpha coverage (non-transparent fraction, 0..1). */
async function buildSprite(
  rgba: Buffer,
  width: number,
  height: number,
): Promise<{ buffer: Buffer; coverage: number }> {
  const rawPng = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();

  let trimmedBuffer: Buffer;
  let trimmedWidth: number;
  let trimmedHeight: number;
  try {
    // IMPORTANT: `.metadata()` on a pipeline with a pending `.trim()`
    // reports the *input's* dimensions, not the trimmed output — verified
    // empirically against the actual sharp/libvips build (metadata() does
    // not execute the operation pipeline). `.toBuffer({resolveWithObject:
    // true})` actually runs the trim and returns the real output size in
    // `info`, which is the only reliable way to get it.
    const { data, info } = await sharp(rawPng).trim({ threshold: 10 }).toBuffer({ resolveWithObject: true });
    trimmedBuffer = data;
    trimmedWidth = info.width;
    trimmedHeight = info.height;
  } catch {
    // A fully-transparent or fully-opaque image can make trim() throw
    // ("Input image contains no data") — fall back to the untrimmed image.
    trimmedBuffer = rawPng;
    trimmedWidth = width;
    trimmedHeight = height;
  }

  const side = Math.max(trimmedWidth, trimmedHeight, 1);
  const squared = await sharp(trimmedBuffer)
    .resize(side, side, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      position: "centre",
    })
    .png()
    .toBuffer();

  const finalSprite = await sharp(squared)
    .resize(SPRITE_SIZE, SPRITE_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const coverage = await computeAlphaCoverage(finalSprite);
  return { buffer: finalSprite, coverage };
}

async function computeAlphaCoverage(pngBuffer: Buffer): Promise<number> {
  const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const total = info.width * info.height;
  if (total === 0) return 0;
  let opaque = 0;
  for (let i = 3; i < data.length; i += info.channels) {
    if ((data[i] ?? 0) > 16) opaque += 1;
  }
  return opaque / total;
}

/** One extra soft-shadow composite — "the difference between sprites that
 * float convincingly and sprites that look pasted on" (build spec §8).
 * Built from the sprite's own alpha silhouette: blur it, dim it to black,
 * offset it down slightly, and composite the original sprite on top. */
async function addSoftShadow(spritePng: Buffer, size: number): Promise<Buffer> {
  const offsetY = Math.max(2, Math.round(size * 0.03));
  const blurSigma = Math.max(1.2, size * 0.02);

  const alphaChannel = await sharp(spritePng).ensureAlpha().extractChannel(3).toBuffer();
  const blurredAlpha = await sharp(alphaChannel)
    .blur(blurSigma)
    .linear(0.4, 0) // dim — the shadow should never be fully opaque black
    .toBuffer();

  const blackRgb = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();

  const shadowLayer = await sharp(blackRgb).joinChannel(blurredAlpha).png().toBuffer();

  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: shadowLayer, top: offsetY, left: 0 },
      { input: spritePng, top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
}

/**
 * Heuristic subject-type guess (build spec §24 / capability schema §7 open
 * decision: "heuristics first, vision only on the ambiguous middle band" —
 * this pipeline has no vision call, so heuristics are the whole story).
 * Approximate and documented as such: an isolatable, roughly-square cutout
 * with moderate fill is almost certainly a product packshot; a wide,
 * non-isolatable image reads more like a banner/lifestyle shot. Anything
 * else is left "unknown" rather than guessed with false confidence.
 */
function guessSubjectType(input: { isolatable: boolean; coverage: number; aspect: number }): SubjectType {
  const { isolatable, coverage, aspect } = input;
  if (isolatable && coverage > 0.05 && coverage < 0.95 && aspect >= 0.4 && aspect <= 2.5) {
    return "product";
  }
  if (!isolatable && (aspect >= 2.2 || aspect <= 1 / 2.2)) {
    return "lifestyle";
  }
  return "unknown";
}
