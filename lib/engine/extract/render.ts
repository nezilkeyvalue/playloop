// lib/engine/extract/render.ts
//
// Ladder step 6 (build spec §7, extended): a last-resort fallback for sites
// whose product/asset markup only exists after client-side JS runs — a
// plain safeFetch() gets back an unrendered CSR shell (e.g. a bare
// `<div id="root">` with everything injected by a bundle afterward), so
// jsonld.ts/opengraph.ts/dom.ts have nothing to find, not because the site
// is blocking us, just because nothing is server-rendered. This launches a
// real, honestly-identified browser, waits for it to settle, and hands the
// *rendered* HTML back through the same downstream extractors.
//
// Deliberately does NOT try to look more human than it actually is: no
// navigator.webdriver masking, no fingerprint spoofing, no custom
// User-Agent override — Playwright's default is simply whatever the real
// browser binary honestly reports itself as. A site whose bot-detection
// also catches automated browsers (the same category as uniqlo.com's
// User-Agent block, just a different signal) degrades the exact same way:
// an empty/thin render, not a workaround. See CLAUDE.md's hazards list for
// why that line exists — it applies here unchanged.
//
// Only ever invoked from extract/index.ts when the cheap ladder already
// came up short AND the fetched HTML looks like an unrendered shell (see
// looksLikeUnrenderedShell below) — this is slow (a real page load + JS
// execution) and heavy (spawns a full Chromium process), never the default
// path for every site.

import type { Browser } from "playwright-core";
import { assertSafeUrl, isUrlAllowedByRobots } from "@/lib/engine/safeFetch";

const NAV_TIMEOUT_MS = 20_000;
/** After domcontentloaded, wait briefly for CSR bundles to paint product
 * grids. `networkidle` was the original choice but SPAs with analytics
 * websockets never go idle — confirmed live against thesouledstore.com,
 * where networkidle always timed out while domcontentloaded + a short settle
 * produced 90+ product images. */
const POST_LOAD_SETTLE_MS = 3_000;
// Guards against a runaway/infinite page (e.g. a live-updating feed) —
// page.content() returning something absurdly large isn't useful markup,
// it's a resource leak waiting to happen downstream in cheerio.
const MAX_RENDER_BYTES = 5 * 1024 * 1024;

export interface RenderResult {
  html: string;
  finalUrl: string;
}

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  if (isServerless) {
    // @sparticuz/chromium ships a Chromium binary built for AWS Lambda /
    // Vercel's serverless function environment — playwright-core's own
    // bundled browser download doesn't fit that environment at all.
    const sparticuzChromium = (await import("@sparticuz/chromium")).default;
    return chromium.launch({
      args: sparticuzChromium.args,
      executablePath: await sparticuzChromium.executablePath(),
      headless: true,
    });
  }
  // Local dev: prefer an installed Chrome when available; fall back to
  // playwright-core's bundled Chromium so extraction still works on machines
  // without the `chrome` channel (CI, minimal Linux installs, etc.).
  try {
    return await chromium.launch({ headless: true, channel: "chrome" });
  } catch {
    return chromium.launch({ headless: true });
  }
}

/** Renders `url` in a real browser and returns the settled HTML, or null on
 * any failure (timeout, blocked, browser unavailable) — this step must
 * degrade exactly like every other ladder step in extract/index.ts, never
 * throw the whole generation over. */
export async function renderWithBrowser(url: string): Promise<RenderResult | null> {
  try {
    await assertSafeUrl(url);
    if (!(await isUrlAllowedByRobots(url))) return null;
  } catch {
    return null;
  }

  let browser: Browser | undefined;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();

    // A real browser can be redirected, or told by its own JS, to load
    // absolutely anything — the single check above only covers the URL we
    // started with. Every request this page makes (the navigation itself,
    // any redirect hop, any sub-resource the page's JS fetches) gets the
    // same private/loopback/link-local IP check safeFetch() applies to
    // every hop of a plain fetch, so a rendered page can't be used to pivot
    // this server into hitting an internal address.
    await page.route("**/*", async (route) => {
      try {
        await assertSafeUrl(route.request().url());
        await route.continue();
      } catch {
        await route.abort();
      }
    });

    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    if (!response || !response.ok()) return null;

    // Give CSR product grids a moment to paint — don't wait for networkidle.
    await page
      .waitForFunction(
        () => document.querySelectorAll("img[src], img[data-src]").length >= 4,
        { timeout: POST_LOAD_SETTLE_MS },
      )
      .catch(() => page.waitForTimeout(POST_LOAD_SETTLE_MS));

    const html = await page.content();
    if (html.length > MAX_RENDER_BYTES) return null;
    return { html, finalUrl: page.url() };
  } catch {
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** Should extract/index.ts spawn the expensive browser step? True when the
 * cheap ladder came up short on *structured* catalogue data and the static
 * HTML still looks like a CSR shell (classic empty mount, or a logo/nav
 * wrapper with no server-rendered products — confirmed live against
 * thesouledstore.com/men: one logo img + nav copy, zero Product JSON-LD). */
export function needsBrowserRender(html: string, structuredAssetCount: number): boolean {
  if (structuredAssetCount >= 3) return false;
  return looksLikeUnrenderedShell(html) || lacksServerRenderedCatalogue(html);
}

/** Classic empty CSR mount: almost no text and zero images once scripts are
 * stripped. */
export function looksLikeUnrenderedShell(html: string): boolean {
  const body = stripBody(html);
  const text = visibleText(body);
  const imgCount = countBodyImages(body);
  return text.length < 200 && imgCount === 0;
}

/** SPA shells that ship nav copy + a logo but inject the product grid only
 * after JS — they fail the classic empty-shell test but still have no
 * Product JSON-LD and very few <img> tags in the raw HTML. */
function lacksServerRenderedCatalogue(html: string): boolean {
  if (hasProductJsonLd(html)) return false;
  return countBodyImages(stripBody(html)) <= 3;
}

function hasProductJsonLd(html: string): boolean {
  return (
    /"@type"\s*:\s*"Product"/i.test(html) ||
    /"@type"\s*:\s*\[[^\]]*"Product"/i.test(html) ||
    /"@type"\s*:\s*"ProductGroup"/i.test(html)
  );
}

function stripBody(html: string): string {
  const withoutScriptsAndStyles = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  const bodyMatch = withoutScriptsAndStyles.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return bodyMatch ? bodyMatch[1]! : withoutScriptsAndStyles;
}

function visibleText(body: string): string {
  return body
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countBodyImages(body: string): number {
  return (body.match(/<img\b/gi) ?? []).length;
}
