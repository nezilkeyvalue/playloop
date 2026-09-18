// app/(app)/layout.tsx — shared chrome for the builder area.
//
// Auth is real now (lib/auth/*), but it is still OPTIONAL: with no Supabase
// project configured, AuthButton renders nothing and every page here works
// against the single implicit dev account, exactly as it did before.
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logomark } from "@/components/Logomark";
import { AuthProvider } from "@/components/AuthProvider";
import { AuthButton } from "@/components/AuthButton";

const NAV_LINKS = [
  { href: "/build", label: "New game" },
  { href: "/games", label: "My games" },
  { href: "/analytics", label: "Analytics" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <AuthProvider>
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-40 border-b border-border bg-background">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-1.5 sm:px-6 sm:py-0">
            <Link href="/" className="flex shrink-0 items-center">
              <Logomark className="h-12 w-auto sm:h-14 md:h-20" />
            </Link>
            <nav
              className="flex min-w-0 items-center gap-0.5 overflow-x-auto text-sm [&::-webkit-scrollbar]:hidden sm:gap-1"
              style={{ scrollbarWidth: "none" }}
            >
              {NAV_LINKS.map((link) => {
                const active = pathname?.startsWith(link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`shrink-0 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-medium transition-colors sm:px-4 sm:py-2 sm:text-sm ${
                      active
                        ? "bg-foreground/[0.06] text-foreground"
                        : "text-muted hover:bg-foreground/[0.04] hover:text-foreground"
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
              <AuthButton className="ml-1 shrink-0 sm:ml-2" />
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">{children}</main>
      </div>
    </AuthProvider>
  );
}
