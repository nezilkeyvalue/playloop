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
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <AuthProvider>
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-40 border-b border-border bg-background">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <Link href="/" className="flex items-center gap-2">
              <Logomark className="h-7 w-7" />
              <span className="font-display text-lg font-semibold tracking-tight">PlayLoop</span>
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              {NAV_LINKS.map((link) => {
                const active = pathname?.startsWith(link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`rounded-full px-4 py-2 font-medium transition-colors ${
                      active
                        ? "bg-foreground/[0.06] text-foreground"
                        : "text-muted hover:bg-foreground/[0.04] hover:text-foreground"
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
              <AuthButton className="ml-2" />
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
      </div>
    </AuthProvider>
  );
}
