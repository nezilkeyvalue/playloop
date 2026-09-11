// lib/engine/extract/shopify.ts
//
// Ladder step 1 (build spec §7): most Shopify stores expose the full
// catalogue publicly via /products.json — titles, prices, variants, image
// URLs, already clean. For the beachhead this single endpoint does most of
// the work with zero parsing, so it is always tried first.

import { safeFetch } from "@/lib/engine/safeFetch";
import type { RawAsset } from "@/lib/engine/types";
import { makeRawAsset, resolveUrl } from "./util";

interface ShopifyImage {
  src: string;
  width?: number;
  height?: number;
}
interface ShopifyVariant {
  price?: string;
  sku?: string;
}
interface ShopifyProduct {
  title?: string;
  product_type?: string;
  images?: ShopifyImage[];
  image?: ShopifyImage | null;
  variants?: ShopifyVariant[];
}
interface ShopifyProductsResponse {
  products?: ShopifyProduct[];
}

export interface ShopifyExtractResult {
  assets: RawAsset[];
  /** True once we've seen a valid products.json payload — used to tag
   * AssetInventory.source.platform = "shopify". */
  platformDetected: boolean;
}

export async function extractShopify(origin: string): Promise<ShopifyExtractResult> {
  const url = `${origin.replace(/\/$/, "")}/products.json?limit=50`;

  let body: ShopifyProductsResponse;
  try {
    const res = await safeFetch(url);
    if (!res.ok) return { assets: [], platformDetected: false };
    const contentType = res.contentType ?? "";
    // Some stores 200 a themed 404/HTML page for unknown routes instead of
    // erroring — guard against parsing that as JSON.
    if (contentType && !contentType.includes("json") && !contentType.includes("text")) {
      return { assets: [], platformDetected: false };
    }
    body = res.json<ShopifyProductsResponse>();
  } catch {
    return { assets: [], platformDetected: false };
  }

  const products = Array.isArray(body?.products) ? body.products : [];
  if (products.length === 0) return { assets: [], platformDetected: false };

  const assets: RawAsset[] = [];
  for (const product of products) {
    const images =
      product.images && product.images.length > 0
        ? product.images
        : product.image
          ? [product.image]
          : [];
    const primary = images[0];
    if (!primary?.src) continue;

    const resolved = resolveUrl(primary.src, origin) ?? primary.src;
    const firstVariant = product.variants?.[0];

    assets.push(
      makeRawAsset({
        url: resolved,
        origin: "products_json",
        name: product.title,
        priceMinor: parsePriceMinor(firstVariant?.price),
        category: product.product_type || undefined,
        sku: firstVariant?.sku,
      }),
    );
  }

  return { assets, platformDetected: true };
}

function parsePriceMinor(price: string | undefined): number | undefined {
  if (!price) return undefined;
  const n = Number.parseFloat(price);
  if (Number.isNaN(n)) return undefined;
  return Math.round(n * 100); // priceMinor is integer minor units — never floats for money
}
