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
