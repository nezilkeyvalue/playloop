// lib/engine/extract/index.ts
//
// Orchestrates the source ladder (build spec §7): shopify → jsonld →
// opengraph → sitemap-lite → dom → render, stopping once we have enough
// candidates. Scraping raw pixels is always the fallback, never the plan.
// The last step (render.ts) only runs for markup that looks like an
// unrendered CSR shell — see its own doc comment. The logo ladder runs
// independently, once, regardless of how the product ladder went.
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
import { renderWithBrowser, needsBrowserRender } from "./render";
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
  // The root document fetch is the one thing every html-dependent step below
  // (jsonld/opengraph/dom/logo, via `tryStep` or directly) leans on — but
  // per this function's own stated design (see `tryStep`'s comment, build
  // spec §23: "sites blocking fetch → empty extraction, not a thrown
  // error"), a site that refuses this specific request should degrade the
  // exact same way every other independent ladder source already does, not
  // take the whole generation down. This one request used to be the sole
  // exception — thrown straight past `tryStep` — which meant a site with a
  // WAF/bot-detection layer that blocks non-browser User-Agents (confirmed
  // live against uniqlo.com: its edge silently drops any request
  // identifying itself as a bot, rather than returning a normal HTTP
  // response) surfaced as a raw "Timed out fetching…" job error instead of
  // reaching the already-built, friendlier "No template fit well — you can
  // still continue in manual mode" path a zero-asset inventory produces
  // further down this same pipeline. Steps 1 (Shopify) and 4 (sitemap)
  // below don't depend on `html` at all and still get their own independent
  // attempt via their own `tryStep` calls either way.
  let pageUrl = sourceUrl;
  let origin = new URL(sourceUrl).origin;
  let html = "";
  const pageRes = await tryStep(() => safeFetch(sourceUrl));
  if (pageRes?.ok) {
    pageUrl = pageRes.finalUrl;
    origin = new URL(pageUrl).origin;
    html = pageRes.text();
  }

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

  // 2 — JSON-LD schema.org Product markup. Needs `html` — absent when the
  // root fetch itself failed (see above), same as every step below that
  // reads `html` rather than hitting its own endpoint.
  if (html && assets.length < ENOUGH_ASSETS) {
    const jsonld = await tryStep(async () => extractJsonLd(html, pageUrl));
    if (jsonld) {
      assets = dedupeByUrl(assets.concat(jsonld.assets));
      currency = currency ?? jsonld.currency;
    }
  }

  // 3 — Open Graph / meta / manifest. Rarely a catalogue but always worth
  // the one extra fetch for a hero image and a brand colour signal.
  const og = html ? await tryStep(() => extractOpenGraph(html, pageUrl)) : null;
  if (og) {
    assets = dedupeByUrl(assets.concat(og.assets));
  }

  // 4 — sitemap-lite: only when the ladder above is still short. Bounded to
  // a handful of product pages — this is the slow, last-ditch structured
  // source (build spec §7 step 4), so it never runs unconditionally. Hits
  // its own endpoint (sitemap.xml), not `html` — still worth attempting
  // even when the root document fetch above failed.
  if (assets.length < ENOUGH_ASSETS) {
    const sitemapAssets = await tryStep(() => extractSitemapLite(origin));
    if (sitemapAssets) assets = dedupeByUrl(assets.concat(sitemapAssets));
  }

  // 5 — DOM heuristics. Noisiest source; last resort only.
  if (html && assets.length < ENOUGH_ASSETS) {
    const domAssets = extractDom(html, pageUrl);
    assets = dedupeByUrl(assets.concat(domAssets));
  }

  // 6 — Rendered-DOM fallback (render.ts). Only when the ladder above is
  // still short *and* the static HTML looks like a CSR shell (classic empty
  // mount, or a logo/nav wrapper with no server-rendered products — see
  // needsBrowserRender in render.ts). Spawns a real browser, so it's gated
  // behind both conditions, not just the asset count — this step alone can
  // cost several real seconds.
  const structuredAssetCount = assets.filter(
    (a) => a.origin === "products_json" || a.origin === "jsonld",
  ).length;
  if (html && assets.length < ENOUGH_ASSETS && needsBrowserRender(html, structuredAssetCount)) {
    const rendered = await tryStep(() => renderWithBrowser(pageUrl));
    if (rendered) {
      html = rendered.html;
      pageUrl = rendered.finalUrl;
      origin = new URL(pageUrl).origin;

      const renderedJsonld = await tryStep(async () => extractJsonLd(html, pageUrl));
      if (renderedJsonld) {
        assets = dedupeByUrl(assets.concat(renderedJsonld.assets));
        currency = currency ?? renderedJsonld.currency;
      }
      const renderedDom = extractDom(html, pageUrl);
      assets = dedupeByUrl(assets.concat(renderedDom));
    }
  }

  // Logo ladder runs independently of the product ladder above — also
  // needs `html`, so it benefits from step 6's rendered markup too when
  // that ran.
  const logo = html ? extractLogo(html, pageUrl, og?.manifest) : null;
  let logoRef: { assetId: string; confidence: number } | undefined;
  if (logo?.asset) {
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

  const allUrls = Array.from(sitemapXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi))
    .map((m) => m[1]?.trim())
    .filter((u): u is string => Boolean(u));

  const productUrls = allUrls.filter((u) => SITEMAP_PRODUCT_PATH.test(u));
  const catalogueUrls = allUrls.filter(
    (u) => !SITEMAP_PRODUCT_PATH.test(u) && SITEMAP_CATALOGUE_PATH.test(u),
  );

  const assets: RawAsset[] = [];

  for (const pageUrl of productUrls.slice(0, MAX_SITEMAP_PAGES)) {
    assets.push(...(await extractSitemapPage(pageUrl)));
    if (assets.length >= ENOUGH_ASSETS) return assets;
  }

  // Non-Shopify stores often list category URLs (/men/t-shirts, /explore/…)
  // rather than /products/slug — try a few with JSON-LD + DOM when the
  // product-url pass came up empty.
  if (assets.length < ENOUGH_ASSETS) {
    for (const pageUrl of catalogueUrls.slice(0, MAX_SITEMAP_PAGES)) {
      assets.push(...(await extractSitemapPage(pageUrl)));
      if (assets.length >= ENOUGH_ASSETS) break;
    }
  }

  return assets;
}

/** Product-detail paths across common commerce platforms (/product/slug,
 * /products/handle, …). */
const SITEMAP_PRODUCT_PATH = /\/products?\//i;

/** Category/listing paths worth a cheap fetch when product URLs are absent. */
const SITEMAP_CATALOGUE_PATH =
  /\/(men|women|kids|explore|collections|shop|catalog|category|categories)\//i;

async function extractSitemapPage(pageUrl: string): Promise<RawAsset[]> {
  try {
    const res = await safeFetch(pageUrl);
    if (!res.ok) return [];
    const html = res.text();
    const jsonld = extractJsonLd(html, res.finalUrl);
    const dom = extractDom(html, res.finalUrl);
    return [...jsonld.assets, ...dom];
  } catch {
    return [];
  }
}
