// lib/engine/palette.ts
//
// Colour extraction (capability schema §1 — RawAsset.colour /
// AssetInventory.brand.palette) and WCAG contrast enforcement (build spec
// §23: "Unreadable palettes → illegible copy → force WCAG contrast after
// extraction", and §5.1: "BrandKit.foreground: contrast-forced against
// background").
//
// Dominant colours use a simple quantized histogram over a downsized pixel
// buffer — no dependency, good enough for a brand palette and per-asset
// colour summary. Not a k-means / median-cut quality result, just a cheap
// and fast approximation.

import sharp from "sharp";

export interface ColourSummary {
  dominant: string[]; // hex, most frequent bucket first
  meanLuminance: number; // 0..1, WCAG relative luminance
  saturation: number; // 0..1, mean HSL saturation
}

const QUANTIZE_BUCKET = 32; // collapses 256^3 colour space into ~8x8x8 buckets
const SAMPLE_SIZE = 48; // resize to 48x48 before histogramming — cheap and stable

export async function extractColours(imageBuffer: Buffer, topN = 5): Promise<ColourSummary> {
  const { data, info } = await sharp(imageBuffer, { failOn: "none" })
    .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  let luminanceSum = 0;
  let saturationSum = 0;
  let pixelCount = 0;

  for (let i = 0; i + channels <= data.length; i += channels) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;

    const key = `${Math.floor(r / QUANTIZE_BUCKET)}-${Math.floor(g / QUANTIZE_BUCKET)}-${Math.floor(b / QUANTIZE_BUCKET)}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }

    luminanceSum += relativeLuminance(r, g, b);
    saturationSum += hslSaturation(r, g, b);
    pixelCount += 1;
  }

  const dominant = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
    .map((bucket) => rgbToHex(bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count));

  return {
    dominant,
    meanLuminance: pixelCount > 0 ? luminanceSum / pixelCount : 0.5,
    saturation: pixelCount > 0 ? saturationSum / pixelCount : 0,
  };
}

export function relativeLuminance(r: number, g: number, b: number): number {
  const channels = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const [rl, gl, bl] = channels as [number, number, number];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

export function saturationOfHex(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return hslSaturation(r, g, b);
}

function hslSaturation(r: number, g: number, b: number): number {
  const rN = r / 255;
  const gN = g / 255;
  const bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  if (max === min) return 0;
  const l = (max + min) / 2;
  const d = max - min;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// WCAG contrast enforcement
// ---------------------------------------------------------------------------

const MIN_CONTRAST_RATIO = 4.5; // WCAG AA, normal text

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "").trim();
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean.padEnd(6, "0").slice(0, 6);
  const num = Number.parseInt(full, 16) || 0;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

export function luminanceOfHex(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return relativeLuminance(r, g, b);
}

export function contrastRatioFromLuminance(luminanceA: number, luminanceB: number): number {
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

export function contrastRatio(hexA: string, hexB: string): number {
  return contrastRatioFromLuminance(luminanceOfHex(hexA), luminanceOfHex(hexB));
}

/**
 * Forces a foreground colour to meet WCAG AA contrast (4.5:1) against a
 * background. Returns the foreground unchanged if it already passes;
 * otherwise falls back to pure black or white, whichever contrasts more —
 * both always pass against any background. This is what makes
 * BrandKit.foreground "contrast-forced against background" (build spec §5.1).
 */
export function forceContrast(foreground: string, background: string): string {
  if (contrastRatio(foreground, background) >= MIN_CONTRAST_RATIO) return foreground;
  const blackContrast = contrastRatio("#000000", background);
  const whiteContrast = contrastRatio("#FFFFFF", background);
  return blackContrast >= whiteContrast ? "#000000" : "#FFFFFF";
}
