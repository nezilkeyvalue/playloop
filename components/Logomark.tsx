// components/Logomark.tsx — small brand glyph, shared by every header.
// Flat, single-color, no gradient/border — quiet like Figma's own mark.
export function Logomark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="rgb(var(--primary))" />
      <path d="M13 10.5v11l9-5.5-9-5.5z" fill="white" />
    </svg>
  );
}
