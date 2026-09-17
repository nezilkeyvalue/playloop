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
// off a class) never actually activates. The wordmark's "layloop" text is
// a dark, near-black color that goes practically invisible against the
// dark-mode background, so a `<picture>` `media` swap — native, no JS —
// falls back to a same-dimension variant with just the text recoloured
// light for dark backgrounds (the icon itself is untouched — already
// vivid enough against either). Deliberately NOT a different crop/asset
// (e.g. an icon-only mark): two images with different aspect ratios
// render at different widths for the same `h-*` className, which reads
// as the logo randomly shrinking when the OS switches modes.
export function Logomark({ className = "h-20 w-auto" }: { className?: string }) {
  return (
    <picture>
      <source srcSet="/brand/playloop-wordmark-dark.png" media="(prefers-color-scheme: dark)" />
      <img src="/brand/playloop-wordmark.png" alt="Playloop" className={className} />
    </picture>
  );
}
