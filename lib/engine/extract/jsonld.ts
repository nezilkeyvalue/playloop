// lib/engine/extract/jsonld.ts
//
// Ladder step 2 (build spec §7): nearly every e-commerce site ships
// schema.org Product markup for SEO inside <script type="application/ld+json">.
// Gives name, image, offers.price, brand — already typed. Handles @graph
// arrays and nested ItemList per the spec.

import * as cheerio from "cheerio";
import type { RawAsset } from "@/lib/engine/types";
import { makeRawAsset, resolveUrl } from "./util";

interface JsonLdOffer {
  price?: string | number;
  priceCurrency?: string;
}
interface JsonLdProduct {
  "@type"?: string | string[];
  name?: string;
  image?: string | string[] | { url?: string };
  offers?: JsonLdOffer | JsonLdOffer[];
  sku?: string;
  category?: string;
}

export interface JsonLdExtractResult {
  assets: RawAsset[];
  currency?: string;
}

export function extractJsonLd(html: string, pageUrl: string): JsonLdExtractResult {
  const $ = cheerio.load(html);
  const products: JsonLdProduct[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw?.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // malformed JSON-LD is common in the wild — skip, don't throw
    }
    collectProducts(parsed, products);
  });

  const assets: RawAsset[] = [];
  let currency: string | undefined;

  for (const product of products) {
    const imageUrl = firstImageUrl(product.image);
    if (!imageUrl) continue;
    const resolved = resolveUrl(imageUrl, pageUrl) ?? imageUrl;

    const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    if (offer?.priceCurrency && !currency) currency = offer.priceCurrency;

    assets.push(
      makeRawAsset({
        url: resolved,
        origin: "jsonld",
        name: product.name,
        priceMinor: parsePriceMinor(offer?.price),
        category: product.category,
        sku: product.sku,
      }),
    );
  }

  return { assets, currency };
}

function firstImageUrl(image: JsonLdProduct["image"]): string | undefined {
  if (!image) return undefined;
  if (typeof image === "string") return image;
  if (Array.isArray(image)) {
    const first = image[0];
    return typeof first === "string" ? first : undefined;
  }
  return image.url;
}

function parsePriceMinor(price: string | number | undefined): number | undefined {
  if (price === undefined) return undefined;
  const n = typeof price === "number" ? price : Number.parseFloat(price);
  if (Number.isNaN(n)) return undefined;
  return Math.round(n * 100);
}

function isProductType(type: string | string[] | undefined): boolean {
  if (!type) return false;
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === "string" && t.toLowerCase().includes("product"));
}

/** Recursively walks a parsed JSON-LD document, handling @graph arrays and
 * ItemList (whose entries are often ListItem wrappers around the real
 * node) — build spec §7: "Handle @graph arrays and nested ItemList." */
function collectProducts(node: unknown, out: JsonLdProduct[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectProducts(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  if ("@graph" in obj) {
    collectProducts(obj["@graph"], out);
  }

  const type = obj["@type"] as string | string[] | undefined;
  if (isProductType(type)) {
    out.push(obj as JsonLdProduct);
  }

  const types = Array.isArray(type) ? type : type ? [type] : [];
  const isItemList = types.some((t) => typeof t === "string" && t.toLowerCase().includes("itemlist"));
  if (isItemList) {
    const items = obj["itemListElement"];
    if (Array.isArray(items)) {
      for (const entry of items) {
        const listItem = entry as Record<string, unknown> | null;
        const inner = listItem && typeof listItem === "object" && "item" in listItem
          ? listItem["item"]
          : listItem;
        collectProducts(inner, out);
      }
    }
  }
}
