// lib/engine/extract/opengraph.ts
//
// Ladder step 3 (build spec §7): og:image, og:site_name, og:description,
// theme-color, and manifest.json if linked. Reliable for a hero image and
// a brand colour signal; useless as a catalogue, which is why it never
// replaces the earlier steps — it only supplements them.

import * as cheerio from "cheerio";
import { safeFetch } from "@/lib/engine/safeFetch";
import type { RawAsset } from "@/lib/engine/types";
import { makeRawAsset, resolveUrl } from "./util";

export interface ManifestIcon {
  src: string;
  sizes?: string;
  type?: string;
}
export interface WebManifest {
  name?: string;
  short_name?: string;
  theme_color?: string;
  background_color?: string;
  icons?: ManifestIcon[];
}

export interface OpenGraphExtractResult {
  assets: RawAsset[];
  siteName?: string;
  description?: string;
  themeColor?: string;
  manifest?: WebManifest;
}

export async function extractOpenGraph(html: string, pageUrl: string): Promise<OpenGraphExtractResult> {
  const $ = cheerio.load(html);

  const ogImage =
    $('meta[property="og:image"]').attr("content") || $('meta[name="og:image"]').attr("content");
  const siteName = $('meta[property="og:site_name"]').attr("content");
  const description =
    $('meta[property="og:description"]').attr("content") ||
    $('meta[name="description"]').attr("content");
  const themeColor = $('meta[name="theme-color"]').attr("content");
  const manifestHref = $('link[rel="manifest"]').attr("href");

  const assets: RawAsset[] = [];
  if (ogImage) {
    const resolved = resolveUrl(ogImage, pageUrl) ?? ogImage;
    assets.push(makeRawAsset({ url: resolved, origin: "og", name: siteName || undefined }));
  }

  let manifest: WebManifest | undefined;
  if (manifestHref) {
    const manifestUrl = resolveUrl(manifestHref, pageUrl);
    if (manifestUrl) {
      try {
        const res = await safeFetch(manifestUrl);
        if (res.ok) manifest = res.json<WebManifest>();
      } catch {
        // manifest.json is optional and frequently missing or malformed — ignore.
      }
    }
  }

  return {
    assets,
    siteName: siteName || manifest?.name || manifest?.short_name || undefined,
    description: description || undefined,
    themeColor: themeColor || manifest?.theme_color || undefined,
    manifest,
  };
}
