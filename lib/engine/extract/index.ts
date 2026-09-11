// lib/engine/extract/index.ts
//
// Orchestrates the source ladder (build spec §7): shopify → jsonld →
// opengraph → sitemap-lite → dom, stopping once we have enough candidates.
// Scraping raw pixels is always the fallback, never the plan. The logo
// ladder runs independently, once, regardless of how the product ladder went.
//
// Returns a *partial* AssetInventory — assets here carry only what markup
// can tell us. pixels/alpha/background/colour/content/phash/quality stay at
// makeRawAsset's defaults; sprites.ts, cutout.ts and quality.ts fill them in
// once each candidate is actually downloaded and decoded.
//
// Runs safeFetch under the hood (see lib/engine/safeFetch.ts) — the calling
// route must declare `export const runtime = "nodejs"`.

import { safeFetch } from "@/lib/engine/safeFetch";
import type { AssetInventory, RawAsset } from "@/lib/engine/types";
import { extractShopify } from "./shopify";
import { extractJsonLd } from "./jsonld";
import { extractOpenGraph } from "./opengraph";
import { extractDom } from "./dom";
import { extractLogo } from "./logo";
import { dedupeByUrl } from "./util";

/** Once we have this many usable candidates, later (noisier / slower) ladder
 * steps are skipped. Comfortably above every capability's richest `ideal`
 * role count (8, catch's collectible role) so the matcher still has real
 * choice, without paying for a sitemap crawl or DOM scrape it doesn't need. */
const ENOUGH_ASSETS = 10;
const MAX_SITEMAP_PAGES = 5;

export interface ExtractResult {
  inventory: AssetInventory;
  /** The fetched document HTML — sprites.ts doesn't need it, but callers
   * that want to re-derive something from markup (or debug a bad run) can. */
  html: string;
  pageUrl: string;
  /** og:site_name / manifest name, when present — a better business-name
   * hint than deriving one from the domain (which compose.ts falls back to
   * for BrandKit.name, since it has no access to markup at all). */
  siteName?: string;
  /** og:description / <meta name="description"> — useful context for the
   * AI layer's copy generation; not stored on AssetInventory itself. */
  description?: string;
}

export async function extractFromUrl(sourceUrl: string): Promise<ExtractResult> {
  const pageRes = await safeFetch(sourceUrl);
  if (!pageRes.ok) {
    throw new Error(`Could not fetch ${sourceUrl}: HTTP ${pageRes.status}`);
  }
  const pageUrl = pageRes.finalUrl;
  const origin = new URL(pageUrl).origin;
  const html = pageRes.text();

  let assets: RawAsset[] = [];
  let platform: string | undefined;
  let currency: string | undefined;

  // 1 — Shopify /products.json fast path. Always tried first — for the
  // beachhead this single endpoint does most of the work with zero parsing.
  const shopify = await tryStep(() => extractShopify(origin));
  if (shopify) {
    assets = dedupeByUrl(assets.concat(shopify.assets));
    if (shopify.platformDetected) platform = "shopify";
  }

  // 2 — JSON-LD schema.org Product markup.
  if (assets.length < ENOUGH_ASSETS) {
    const jsonld = await tryStep(async () => extractJsonLd(html, pageUrl));
    if (jsonld) {
      assets = dedupeByUrl(assets.concat(jsonld.assets));
      currency = currency ?? jsonld.currency;
    }
  }

  // 3 — Open Graph / meta / manifest. Rarely a catalogue but always worth
  // the one extra fetch for a hero image and a brand colour signal.
  const og = await tryStep(() => extractOpenGraph(html, pageUrl));
  if (og) {
    assets = dedupeByUrl(assets.concat(og.assets));
  }

  // 4 — sitemap-lite: only when the ladder above is still short. Bounded to
  // a handful of product pages — this is the slow, last-ditch structured
  // source (build spec §7 step 4), so it never runs unconditionally.
  if (assets.length < ENOUGH_ASSETS) {
    const sitemapAssets = await tryStep(() => extractSitemapLite(origin));
    if (sitemapAssets) assets = dedupeByUrl(assets.concat(sitemapAssets));
  }

  // 5 — DOM heuristics. Noisiest source; last resort only.
  if (assets.length < ENOUGH_ASSETS) {
    const domAssets = extractDom(html, pageUrl);
    assets = dedupeByUrl(assets.concat(domAssets));
  }

  // Logo ladder runs independently of the product ladder above.
  const logo = extractLogo(html, pageUrl, og?.manifest);
  let logoRef: { assetId: string; confidence: number } | undefined;
  if (logo.asset) {
    assets = dedupeByUrl(assets.concat(logo.asset));
    logoRef = { assetId: logo.asset.id, confidence: logo.confidence };
  }

  const inventory: AssetInventory = {
    version: 1,
    source: { mode: "auto", url: sourceUrl, platform },
    currency: currency ?? "USD",
    assets,
    brand: {
      logo: logoRef,
      // Seeded from theme-color/manifest here; palette.ts refines this with
      // real dominant colours once sprites are downloaded and decoded.
      palette: og?.themeColor ? [og.themeColor] : [],
      // No reliable way to detect the site's actual font stack from static
      // markup alone (that needs computed CSS) — default to a safe, widely
      // available Google Font stack; compose.ts / the builder can override.
      fontStack: "Inter, system-ui, sans-serif",
    },
    dataCoverage: computeDataCoverage(assets),
  };

  return { inventory, html, pageUrl, siteName: og?.siteName, description: og?.description };
}

function computeDataCoverage(assets: RawAsset[]): AssetInventory["dataCoverage"] {
  return assets.reduce(
    (acc, a) => ({
      withName: acc.withName + (a.data?.name ? 1 : 0),
      withPrice: acc.withPrice + (a.data?.priceMinor !== undefined ? 1 : 0),
      withCategory: acc.withCategory + (a.data?.category ? 1 : 0),
    }),
    { withName: 0, withPrice: 0, withCategory: 0 },
  );
}

/** Every ladder step is independent and best-effort: a broken or blocked
 * source must never take the whole pipeline down with it (build spec §23:
 * "Sites blocking fetch → empty extraction", not a thrown error). */
async function tryStep<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function extractSitemapLite(origin: string): Promise<RawAsset[]> {
  let sitemapXml: string;
  try {
    const res = await safeFetch(`${origin}/sitemap.xml`);
    if (!res.ok) return [];
    sitemapXml = res.text();
  } catch {
    return [];
  }

  const urls = Array.from(sitemapXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi))
    .map((m) => m[1])
    .filter((u): u is string => Boolean(u))
    .filter((u) => /\/products?\//i.test(u));

  const assets: RawAsset[] = [];
  for (const productUrl of urls.slice(0, MAX_SITEMAP_PAGES)) {
    try {
      const res = await safeFetch(productUrl);
      if (!res.ok) continue;
      const { assets: pageAssets } = extractJsonLd(res.text(), res.finalUrl);
      assets.push(...pageAssets);
    } catch {
      // one bad product page must not abort the whole sitemap pass
    }
  }
  return assets;
}
