// lib/engine/embedSnippet.ts
//
// The ONE place that turns (slug, template, placement, ...) into the
// snippet a merchant pastes onto their own site. Used from both a server
// route (app/api/games/[id]/publish/route.ts) and a client component
// (app/(app)/games/[id]/embed/page.tsx) — it used to be two separately
// hand-written template strings that had already drifted (neither ever set
// `data-placement`, so the placement a merchant picked in the UI was
// invisible in the code they copied). Pure string templating only: no
// fetch, no Node/DOM APIs, safe to import from either side.
//
// The min-width data attribute exists so app/embed.js can give the embedded
// game a sane floor on the HOST page's box before the iframe's own
// postMessage handshake ever runs — without it, a host page with a
// too-narrow container silently squishes the game with no warning, since
// embed.js has no other way to know what "too narrow" means for a given
// template's placement.

import { getCapability } from "@/lib/capabilities";
import type { Placement, TemplateId } from "@/lib/engine/types";

export const DEFAULT_MODAL_TRIGGER_LABEL = "Play & win";

export type ModalTrigger = "click" | "load";

export interface EmbedSnippetOptions {
  slug: string;
  template: TemplateId;
  placement: Placement;
  /** Origin the script tag points at, e.g. "https://playloop.app" or the
   * current window.location.origin in the editor's live preview. */
  appUrl: string;
  /** Only rendered for "modal" — the label on the button a visitor clicks
   * to open the game. Free text from the merchant, so it's escaped before
   * landing inside an HTML attribute. */
  triggerLabel?: string;
  /** "click" (default, omitted from the snippet) opens the modal only when
   * a visitor clicks the trigger. "load" ALSO opens it once automatically
   * shortly after the page loads — the trigger button still renders, so a
   * visitor who closes it can reopen it. Ignored outside "modal". */
  trigger?: ModalTrigger;
  /** A merchant-chosen box size for this embed (embed/page.tsx's Size
   * section). Omitted -> the template's own responsive default (full
   * width, aspect-ratio-derived height). `width` caps the box's max-width;
   * `height` is a literal target and is ignored for "fullpage" (which is
   * defined by filling the visitor's viewport, not a fixed height). Both
   * are still floored at the template's own placement minimums inside the
   * runtime (lib/runtime/stage.ts) — a merchant can't configure a size the
   * game can't actually render in, this just can't make it any smaller. */
  width?: number;
  height?: number;
}

/** Minimal escaping for a value that lands inside a double-quoted HTML
 * attribute — this text both round-trips through a `<pre>` (as visible
 * source) and gets pasted verbatim onto a real page, so it has to be safe
 * as actual markup, not just as a display string. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildEmbedSnippet(opts: EmbedSnippetOptions): string {
  const constraint = getCapability(opts.template)?.placements[opts.placement];

  const attrs = [`data-playloop="${opts.slug}"`, `data-placement="${opts.placement}"`];
  if (constraint?.minWidth) attrs.push(`data-min-width="${constraint.minWidth}"`);
  if (opts.width && opts.width > 0) attrs.push(`data-width="${Math.round(opts.width)}"`);
  if (opts.height && opts.height > 0 && opts.placement !== "fullpage") {
    attrs.push(`data-height="${Math.round(opts.height)}"`);
  }
  if (opts.placement === "modal") {
    const label = opts.triggerLabel?.trim() || DEFAULT_MODAL_TRIGGER_LABEL;
    attrs.push(`data-trigger-label="${escapeAttr(label)}"`);
    if (opts.trigger === "load") attrs.push(`data-trigger="load"`);
  }

  const appUrl = opts.appUrl.replace(/\/+$/, "");
  return `<div ${attrs.join(" ")}></div>\n<script src="${appUrl}/embed.js" async></script>`;
}

export function buildIframeFallback(slug: string, appUrl: string): string {
  const base = appUrl.replace(/\/+$/, "");
  return `<iframe src="${base}/play/${slug}" style="width:100%;border:0;min-height:600px" sandbox="allow-scripts allow-same-origin allow-popups" title="Playloop game"></iframe>`;
}
