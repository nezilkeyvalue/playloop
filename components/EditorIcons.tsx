// components/EditorIcons.tsx — small line icons for the game editor's
// section headers. Hand-drawn (no icon library dependency) at a shared
// 20x20 viewBox, stroke="currentColor" so they inherit text colour/theme.
import type { SVGProps } from "react";

export function ImageIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <circle cx="7" cy="8" r="1.3" />
      <path d="M3 14.5l4.2-4 3 2.3L15 8l2 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PaletteIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path
        d="M10 2.5c-4.14 0-7.5 3.13-7.5 7 0 2.13 1.4 2.7 2.6 2.7.62 0 1.1.5 1.1 1.1 0 .34-.1.6-.2.95-.1.3-.2.6-.2.95 0 1 .9 1.8 2 1.8 4.14 0 7.7-3.36 7.7-7.5 0-4.42-2.86-7-5.5-7z"
        strokeLinejoin="round"
      />
      <circle cx="6.8" cy="7.6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10.3" cy="5.9" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="13.2" cy="8.3" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function TextIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...props}>
      <path d="M4 5.5h12M4 10h12M4 14.5h7" />
    </svg>
  );
}

export function GiftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" {...props}>
      <rect x="3" y="8.5" width="14" height="8" rx="1" />
      <path d="M3 11.5h14M10 8.5v8" strokeLinecap="round" />
      <path d="M10 8.5c-1.4 0-2.8-.9-2.8-2.3a1.9 1.9 0 013.8-.4c.15-1.35 1.4-2.1 2.5-1.45.9.55.9 2 0 2.6-1 .65-2.1 1.55-3.5 1.55z" />
    </svg>
  );
}

export function ChevronIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M6 8l4 4 4-4" />
    </svg>
  );
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 10.5l3.5 3.5L16 5.5" />
    </svg>
  );
}

/** "Whole game" screen tab — stacked layers, since branding applies across
 * every other screen rather than to one moment in the flow. */
export function LayersIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M10 3l7 3.7-7 3.7-7-3.7L10 3z" />
      <path d="M3 10.3l7 3.7 7-3.7" />
      <path d="M3 13.7l7 3.7 7-3.7" />
    </svg>
  );
}

/** "Start screen" screen tab. */
export function FlagIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 17V3" />
      <path d="M5 4h9.5l-2.3 3 2.3 3H5" />
    </svg>
  );
}

/** "Game screen" screen tab. */
export function ControllerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2.5" y="6.5" width="15" height="8" rx="4" />
      <path d="M6.5 8.5v4M4.5 10.5h4" />
      <circle cx="14" cy="9" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="11.5" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** "End summary" screen tab. */
export function TrophyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M6.5 3.5h7v3.5a3.5 3.5 0 01-7 0V3.5z" />
      <path d="M6.5 4.5H4a2 2 0 002 3.6M13.5 4.5H16a2 2 0 01-2 3.6" />
      <path d="M10 10.5v2.5M7.5 16.5h5M8.3 16.5c0-1.4.5-2.5 1.7-3M11.7 16.5c0-1.4-.5-2.5-1.7-3" />
    </svg>
  );
}

/** Embed page's "Size" section — a box with a resize handle. */
export function ResizeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2.5" y="2.5" width="15" height="15" rx="2.5" />
      <path d="M7.2 12.8l5.6-5.6M12.8 9.6V7.2h-2.4" />
    </svg>
  );
}

/** Embed page's "Trigger" section — a click/tap cursor. */
export function CursorClickIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 3.2l1.3 12.4 2.9-3.3 2.6 4.7 1.9-1.05-2.6-4.7 4.3-.65z" />
    </svg>
  );
}

/** "Full page" placement card — four corners expanding outward. */
export function ExpandIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M7 3H3v4M13 3h4v4M7 17H3v-4M13 17h4v-4" />
    </svg>
  );
}
