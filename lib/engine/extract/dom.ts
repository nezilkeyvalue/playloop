// lib/engine/extract/dom.ts
//
// Ladder step 5 (build spec §7): heuristic <img> scraping, filtered by
// whatever natural size/aspect/position hints the markup gives us for free
// (width/height attributes, surrounding class names, position in the DOM).
// This is the noisiest source and the main cause of bad output, so it is
// deliberately conservative — only images with a *positive* signal survive,
// and it only ever runs once every earlier, cleaner ladder step has fallen
// short (see extract/index.ts). No pixel decoding here; that's sprites.ts's
// job downstream, on the assets that make it this far.

import * as cheerio from "cheerio";
import type { RawAsset } from "@/lib/engine/types";
import { makeRawAsset, resolveUrl } from "./util";

const SKIP_PATTERN =
  /(sprite|icon|favicon|logo|pixel|tracking|badge|payment|visa|mastercard|paypal|swatch|thumb-?nav|banner|mobile-cms|cms-content|\/storage\/mobile)/i;
import { CATALOGUE_PRODUCT_URL_PATTERN } from "@/lib/engine/catalogue";

const PRODUCT_HINT_PATTERN = CATALOGUE_PRODUCT_URL_PATTERN;
const MAX_DOM_CANDIDATES = 30;
const MIN_MARKUP_DIMENSION = 150;

export function extractDom(html: string, pageUrl: string): RawAsset[] {
  const $ = cheerio.load(html);
  const candidates: { url: string; score: number; alt?: string; productUrl?: string }[] = [];

  $("img").each((_, el) => {
    const $el = $(el);
    const src = $el.attr("data-src") || $el.attr("src");
    if (!src || src.startsWith("data:")) return;
    if (SKIP_PATTERN.test(src)) return;

    const widthAttr = Number.parseInt($el.attr("width") ?? "", 10);
    const heightAttr = Number.parseInt($el.attr("height") ?? "", 10);
    // Explicit small dimensions in markup are the cheapest signal available
    // without downloading the image — reject known-tiny assets outright.
    if (Number.isFinite(widthAttr) && widthAttr > 0 && widthAttr < MIN_MARKUP_DIMENSION) return;
    if (Number.isFinite(heightAttr) && heightAttr > 0 && heightAttr < MIN_MARKUP_DIMENSION) return;

    const alt = $el.attr("alt") ?? "";
    const className = $el.attr("class") ?? "";
    const parentClass = $el.parent().attr("class") ?? "";
    const context = `${className} ${parentClass} ${src}`;

    let score = 0;
    if (PRODUCT_HINT_PATTERN.test(context)) score += 2;
    if ((Number.isFinite(widthAttr) && widthAttr >= 300) || (Number.isFinite(heightAttr) && heightAttr >= 300)) {
      score += 1;
    }
    if ($el.closest("nav, header, footer, aside").length > 0) score -= 3;
    if (SKIP_PATTERN.test(context)) score -= 3;

    // Conservative on purpose: no positive signal, no candidate. Build spec
    // §7/§23 — this is the source most likely to produce bad output.
    if (score <= 0) return;

    const resolved = resolveUrl(src, pageUrl) ?? src;
    // Best-effort, lower-confidence than jsonld.ts/shopify.ts's structural
    // sources: the nearest wrapping <a> isn't guaranteed to be the image's
    // own canonical product page (could be a "quick view" trigger, a filter
    // link, etc.) — but for typical catalogue-grid markup it usually is,
    // and it's essentially free to capture alongside a candidate we were
    // already going to keep.
    const anchorHref = $el.closest("a[href]").attr("href");
    const productUrl = anchorHref ? (resolveUrl(anchorHref, pageUrl) ?? undefined) : undefined;
    candidates.push({ url: resolved, score, alt: alt || undefined, productUrl });
  });

  candidates.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const assets: RawAsset[] = [];
  for (const c of candidates) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    assets.push(
      makeRawAsset({
        url: c.url,
        origin: "dom",
        name: c.alt,
        productUrl: c.productUrl,
        subjectTypeHint: "product",
      }),
    );
    if (assets.length >= MAX_DOM_CANDIDATES) break;
  }
  return assets;
}
