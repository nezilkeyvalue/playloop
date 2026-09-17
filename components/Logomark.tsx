// components/Logomark.tsx — the full Playloop wordmark (icon + text baked
// into one image), shared by every header. A raster asset, not inline SVG —
// plain <img>, matching this codebase's existing convention for local/
// static images (see AuthButton.tsx) rather than next/image, which isn't
// used anywhere else here. Callers should NOT render adjacent "Playloop"
// text next to this — the wordmark already includes it.
//
// Dark mode here is pure CSS (globals.css's custom properties react to
// `prefers-color-scheme` directly) — there is no `.dark` class/data-theme
// toggle anywhere in the app, so Tailwind's `dark:` variant (configured
// off a class) never actually activates. The light wordmark's "layloop"
// text is a dark, near-black color that goes practically invisible
// against the dark-mode background, so a `<picture>` `media` swap —
// native, no JS — falls back to the dedicated dark-mode wordmark (a
// separate designed asset, not a programmatic recolor) for dark
// backgrounds. Both files are the same 1983x793 source dimensions
// deliberately: an earlier version fell back to a differently-cropped
// icon-only mark instead, and two images with different aspect ratios
// render at different widths for the same `h-*` className, which read as
// the logo randomly shrinking when the OS switched modes.
export function Logomark({ className = "h-20 w-auto" }: { className?: string }) {
  return (
    <picture>
      <source srcSet="/brand/playloop-wordmark-dark.png" media="(prefers-color-scheme: dark)" />
      <img src="/brand/playloop-wordmark.png" alt="Playloop" className={className} />
    </picture>
  );
}
