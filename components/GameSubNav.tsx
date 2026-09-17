"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { suffix: "", label: "Edit" },
  { suffix: "/embed", label: "Embed" },
  { suffix: "/analytics", label: "Analytics" },
] as const;

export function GameSubNav({ gameId }: { gameId: string }) {
  const pathname = usePathname();
  const base = `/games/${gameId}`;

  return (
    <nav className="inline-flex flex-wrap gap-1 rounded-full border border-border bg-card2 p-1 text-sm shadow-card">
      {LINKS.map(({ suffix, label }) => {
        const href = `${base}${suffix}`;
        const active =
          suffix === ""
            ? pathname === base || pathname === `${base}/`
            : pathname?.startsWith(href);
        return (
          <Link
            key={suffix}
            href={href}
            className={`rounded-full px-4 py-1.5 font-medium transition-colors ${
              active
                ? "bg-foreground/[0.08] text-foreground"
                : "text-muted hover:bg-foreground/[0.04] hover:text-foreground"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
