// lib/engine/cutout.ts
//
// Flood-fill alpha cutout (build spec §8) + background uniformity +
// perceptual hash (build spec §9's duplicate check, capability schema §1's
// `phash` field). All hand-rolled against sharp's raw pixel buffers — no
// npm dependency for either the cutout or the aHash.
//
// Sharp-dependent — only ever reachable from a route declaring
// `export const runtime = "nodejs"` (Edge cannot run sharp).

import sharp from "sharp";

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface CutoutResult {
  /** width*height*4 RGBA buffer, alpha punched out where the flood fill reached. */
  rgba: Buffer;
  width: number;
  height: number;
  /** 0..1, corner-colour variance based — 1 = perfectly uniform corners. */
  uniformity: number;
  /** Hex of the sampled background colour. */
  dominant: string;
  /** True if a cheap flood-fill cutout worked (or the source already had real alpha). */
  isolatable: boolean;
  alreadyHadAlpha: boolean;
}

const FLOOD_TOLERANCE = 24; // per-channel Euclidean-ish distance tolerance (0-255 scale)
const NEAR_WHITE_THRESHOLD = 235; // build spec §8: "consistently near-white"
// transform catalogue §3: cutout:flood requires background.uniformity >= 0.80.
// Exported so sprites.ts can reuse the exact same bar for a related but
// distinct decision: whether a *non-isolated* background is nonetheless
// uniform enough that a flat colour fill (vs. a blurred self-extend) will
// look seamless — see ProcessedAsset.backgroundTreatment.
export const MIN_UNIFORMITY_FOR_ISOLATION = 0.8;

/**
 * Runs the flood-fill cutout described in build spec §8: sample the four
 * corners; if they're consistently near-white and low-variance, flood-fill
 * inward from every border pixel (not just the corners — an irregular
 * product silhouette still isolates cleanly this way) with a colour
 * tolerance. If the source already carries a real (non-uniform) alpha
 * channel, skip straight to returning it unchanged.
 */
export async function cutout(imageBuffer: Buffer): Promise<CutoutResult> {
  const image = sharp(imageBuffer, { failOn: "none" });
  const metadata = await image.metadata();
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const channels = info.channels; // 4, guaranteed by ensureAlpha()

  const alreadyHadAlpha = Boolean(metadata.hasAlpha);

  const corners: RGBA[] = [
    pixelAt(data, width, channels, 0, 0),
    pixelAt(data, width, channels, width - 1, 0),
    pixelAt(data, width, channels, 0, height - 1),
    pixelAt(data, width, channels, width - 1, height - 1),
  ];
  const uniformity = cornerUniformity(corners);
  const dominant = rgbToHex(averageRgb(corners));
  const isNearWhite = corners.every(
    (c) => c.r >= NEAR_WHITE_THRESHOLD && c.g >= NEAR_WHITE_THRESHOLD && c.b >= NEAR_WHITE_THRESHOLD,
  );

  if (alreadyHadAlpha && hasVaryingAlpha(data, width, height, channels)) {
    // Real alpha already present and meaningful — trust it, skip flood-fill.
    return {
      rgba: Buffer.from(data),
      width,
      height,
      uniformity,
      dominant,
      isolatable: true,
      alreadyHadAlpha: true,
    };
  }

  const isolatable = uniformity >= MIN_UNIFORMITY_FOR_ISOLATION && isNearWhite;
  if (!isolatable) {
    // Background too non-uniform for a cheap flood cutout. Return as-is
    // (fully opaque); quality.ts / the matcher's `requires.isolatable` gate
    // is what actually keeps this out of collectible-style roles.
    return { rgba: Buffer.from(data), width, height, uniformity, dominant, isolatable: false, alreadyHadAlpha };
  }

  const background = averageRgb(corners);
  const rgba = floodFillTransparent(data, width, height, channels, background);
  return { rgba, width, height, uniformity, dominant, isolatable: true, alreadyHadAlpha };
}

function pixelAt(data: Buffer | Uint8Array, width: number, channels: number, x: number, y: number): RGBA {
  const idx = (y * width + x) * channels;
  return {
    r: data[idx] ?? 0,
    g: data[idx + 1] ?? 0,
    b: data[idx + 2] ?? 0,
    a: channels >= 4 ? (data[idx + 3] ?? 255) : 255,
  };
}

function averageRgb(pixels: RGBA[]): RGBA {
  return {
    r: Math.round(mean(pixels.map((p) => p.r))),
    g: Math.round(mean(pixels.map((p) => p.g))),
    b: Math.round(mean(pixels.map((p) => p.b))),
    a: 255,
  };
}

function mean(nums: number[]): number {
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const h = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function colourDistance(a: RGBA, b: RGBA): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/** Corner-colour variance mapped to a 0..1 uniformity score (1 = identical
 * corners). Purely a cheap proxy for "is the background flat" — a real
 * segmentation model would do better, which is exactly why it's deferred
 * (build spec §8: ML cutout is Python-ecosystem, post-hackathon). */
function cornerUniformity(corners: RGBA[]): number {
  const meanR = mean(corners.map((c) => c.r));
  const meanG = mean(corners.map((c) => c.g));
  const meanB = mean(corners.map((c) => c.b));
  const variance =
    mean(corners.map((c) => (c.r - meanR) ** 2)) +
    mean(corners.map((c) => (c.g - meanG) ** 2)) +
    mean(corners.map((c) => (c.b - meanB) ** 2));
  const MAX_VARIANCE = 3 * 65025; // 3 channels x 255^2 (max variance if corners split black/white)
  return clamp(1 - variance / MAX_VARIANCE, 0, 1);
}

/** Cheap approximation of "does this image already have a meaningful alpha
 * channel" — samples a grid rather than every pixel, which is enough to
 * distinguish a real cutout from an alpha channel sharp added uniformly. */
function hasVaryingAlpha(data: Buffer | Uint8Array, width: number, height: number, channels: number): boolean {
  if (channels < 4) return false;
  let minA = 255;
  let maxA = 0;
  const stepX = Math.max(1, Math.floor(width / 32));
  const stepY = Math.max(1, Math.floor(height / 32));
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const idx = (y * width + x) * channels;
      const a = data[idx + 3] ?? 255;
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
    }
  }
  return maxA - minA > 10;
}

function floodFillTransparent(
  data: Buffer | Uint8Array,
  width: number,
  height: number,
  channels: number,
  background: RGBA,
): Buffer {
  const out = Buffer.from(data); // mutate a copy, keep the decoded source intact
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];

  const isBackgroundColour = (x: number, y: number): boolean => {
    const idx = (y * width + x) * channels;
    const px: RGBA = { r: data[idx] ?? 0, g: data[idx + 1] ?? 0, b: data[idx + 2] ?? 0, a: 255 };
    return colourDistance(px, background) <= FLOOD_TOLERANCE;
  };

  const pushIfBackground = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const pos = y * width + x;
    if (visited[pos]) return;
    if (!isBackgroundColour(x, y)) return;
    visited[pos] = 1;
    stack.push(pos);
  };

  // Seed from every border pixel, not just the four corners.
  for (let x = 0; x < width; x++) {
    pushIfBackground(x, 0);
    pushIfBackground(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    pushIfBackground(0, y);
    pushIfBackground(width - 1, y);
  }

  while (stack.length > 0) {
    const pos = stack.pop();
    if (pos === undefined) break;
    const x = pos % width;
    const y = Math.floor(pos / width);
    const idx = pos * channels;
    out[idx + 3] = 0; // transparent
    pushIfBackground(x + 1, y);
    pushIfBackground(x - 1, y);
    pushIfBackground(x, y + 1);
    pushIfBackground(x, y - 1);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Perceptual hash (aHash) — capability schema §1: "phash drives
// de-duplication". Hand-rolled: resize to 8x8 greyscale, compare each pixel
// to the mean, one bit per pixel, packed into 16 hex chars (64 bits).
// ---------------------------------------------------------------------------

const PHASH_SIZE = 8;

export async function computePhash(imageBuffer: Buffer): Promise<string> {
  const { data } = await sharp(imageBuffer, { failOn: "none" })
    .flatten({ background: { r: 255, g: 255, b: 255 } }) // drop alpha before greyscale so transparent areas read as background, not black
    .resize(PHASH_SIZE, PHASH_SIZE, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels: number[] = [];
  for (let i = 0; i < PHASH_SIZE * PHASH_SIZE; i++) pixels.push(data[i] ?? 0);
  const avg = mean(pixels);

  let bits = "";
  for (const p of pixels) bits += p >= avg ? "1" : "0";

  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += Number.parseInt(bits.slice(i, i + 4).padEnd(4, "0"), 2).toString(16);
  }
  return hex;
}

/** Hamming distance between two aHash hex strings, via per-nibble popcount. */
export function hammingDistance(hashA: string, hashB: string): number {
  const len = Math.max(hashA.length, hashB.length);
  let distance = 0;
  for (let i = 0; i < len; i++) {
    const a = Number.parseInt(hashA[i] ?? "0", 16) || 0;
    const b = Number.parseInt(hashB[i] ?? "0", 16) || 0;
    let xor = a ^ b;
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}
