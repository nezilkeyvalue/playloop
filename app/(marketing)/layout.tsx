// app/(marketing)/layout.tsx — thin shared header for the public pages
// (landing, gallery). The builder area has its own chrome in app/(app)/layout.tsx.
//
// AuthProvider is mounted per-area rather than in the root layout on purpose:
// app/play/[slug] and the embed are the highest-traffic, most
// weight-sensitive routes in the app and have no notion of a PlayLoop
// account, so they must not pull the Supabase auth client into their bundle.
import Link from "next/link";
import { Logomark } from "@/components/Logomark";
import { AuthProvider } from "@/components/AuthProvider";
import { AuthButton } from "@/components/AuthButton";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <div className="min-h-screen bg-background">
        <header className="absolute inset-x-0 top-0 z-40">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-1.5 sm:px-6 sm:py-0">
            <Link href="/" className="flex shrink-0 items-center">
              <Logomark className="h-12 w-auto sm:h-14 md:h-20" />
            </Link>
            <div className="flex items-center gap-1">
              <Link
                href="/games"
                className="hidden whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-foreground/[0.04] hover:text-foreground sm:inline-block"
              >
                My games
              </Link>
              <AuthButton className="shrink-0" />
            </div>
          </div>
        </header>
        {children}
      </div>
    </AuthProvider>
  );
}
