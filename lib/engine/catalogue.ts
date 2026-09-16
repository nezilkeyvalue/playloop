// lib/engine/catalogue.ts
//
// Shared signals for "this asset came from a product catalogue" — used by
// extraction (subjectType hints), sprites (classification fallback),
// quality (relaxed text-density for lifestyle thumbnails), and matcher
// (ranking bonuses).

import type { AssetOrigin, RawAsset } from "@/lib/engine/types";

/** URLs/context matching this pattern are treated as catalogue product images
 * (dom ladder, SPA storefronts like The Souled Store, etc.). */
export const CATALOGUE_PRODUCT_URL_PATTERN =
  /(product|item-card|grid-item|catalog\/product|collection|shop-item|uploads\/catalog)/i;

export function isCatalogueProductUrl(url: string): boolean {
  return CATALOGUE_PRODUCT_URL_PATTERN.test(url);
}

/** True when extraction structurally found a catalogue row, or DOM scraping
 * surfaced a named product thumbnail. */
export function isCatalogueProductAsset(asset: Pick<RawAsset, "origin" | "url" | "data">): boolean {
  if (asset.origin === "products_json" || asset.origin === "jsonld") return true;
  if (asset.origin === "dom") {
    if (isCatalogueProductUrl(asset.url)) return true;
    if (asset.data?.name) return true;
  }
  return false;
}
