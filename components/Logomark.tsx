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
// falls back to just the icon crop (which stays legible against either
// background) whenever the OS prefers dark.
export function Logomark({ className = "h-20 w-auto" }: { className?: string }) {
  return (
    <picture>
      <source srcSet="/brand/playloop-icon.png" media="(prefers-color-scheme: dark)" />
      <img src="/brand/playloop-wordmark.png" alt="Playloop" className={className} />
    </picture>
  );
}
