// lib/engine/extract/logo.ts
//
// The logo ladder (build spec §7 / §23): apple-touch-icon → manifest.json
// icons (largest) → <img> with "logo" in class/alt/src → og:logo → favicon
// last. Favicon is explicitly last — it's usually 32px and useless as a
// sprite, but still better than nothing.

import * as cheerio from "cheerio";
import type { RawAsset } from "@/lib/engine/types";
import { makeRawAsset, resolveUrl } from "./util";
import type { WebManifest } from "./opengraph";

export type LogoSource = "apple-touch-icon" | "manifest" | "img-logo" | "og-logo" | "favicon" | "none";

export interface LogoExtractResult {
  asset: RawAsset | null;
  confidence: number;
  via: LogoSource;
}

const LOGO_HINT_PATTERN = /logo/i;

export function extractLogo(html: string, pageUrl: string, manifest?: WebManifest): LogoExtractResult {
  const $ = cheerio.load(html);

  // 1 — apple-touch-icon: almost always a clean square brand mark.
  const appleTouchIcon = $(
    'link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]',
  )
    .first()
    .attr("href");
  if (appleTouchIcon) {
    return buildResult(appleTouchIcon, pageUrl, "apple-touch-icon", 0.85);
  }

  // 2 — manifest.json icons, largest first.
  if (manifest?.icons && manifest.icons.length > 0) {
    const largest = [...manifest.icons].sort((a, b) => iconArea(b) - iconArea(a))[0];
    if (largest?.src) {
      return buildResult(largest.src, pageUrl, "manifest", 0.8);
    }
  }

  // 3 — an <img> whose class/alt/src mentions "logo".
  let imgLogoSrc: string | undefined;
  $("img").each((_, el) => {
    if (imgLogoSrc) return;
    const $el = $(el);
    const src = $el.attr("data-src") || $el.attr("src");
    if (!src || src.startsWith("data:")) return;
    const haystack = `${$el.attr("class") ?? ""} ${$el.attr("alt") ?? ""} ${src}`;
    if (LOGO_HINT_PATTERN.test(haystack)) imgLogoSrc = src;
  });
  if (imgLogoSrc) {
    return buildResult(imgLogoSrc, pageUrl, "img-logo", 0.6);
  }

  // 4 — og:logo (non-standard but cheap to check, some CMSs emit it).
  const ogLogo = $('meta[property="og:logo"]').attr("content");
  if (ogLogo) {
    return buildResult(ogLogo, pageUrl, "og-logo", 0.55, "og");
  }

  // 5 — favicon, last resort.
  const favicon = $('link[rel="icon"], link[rel="shortcut icon"]').first().attr("href");
  if (favicon) {
    return buildResult(favicon, pageUrl, "favicon", 0.25);
  }

  return { asset: null, confidence: 0, via: "none" };
}

function buildResult(
  href: string,
  pageUrl: string,
  via: LogoSource,
  confidence: number,
  assetOrigin: "dom" | "og" = "dom",
): LogoExtractResult {
  const resolved = resolveUrl(href, pageUrl) ?? href;
  return {
    asset: makeRawAsset({ url: resolved, origin: assetOrigin, subjectTypeHint: "logo" }),
    confidence,
    via,
  };
}

function iconArea(icon: { sizes?: string }): number {
  const match = icon.sizes?.match(/(\d+)x(\d+)/i);
  if (!match) return 0;
  const w = Number(match[1]);
  const h = Number(match[2]);
  return Number.isFinite(w) && Number.isFinite(h) ? w * h : 0;
}
