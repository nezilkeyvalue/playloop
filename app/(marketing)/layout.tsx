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
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
            <Link href="/" className="flex items-center gap-2">
              <Logomark className="h-7 w-7" />
              <span className="font-display text-lg font-semibold tracking-tight">PlayLoop</span>
            </Link>
            <div className="flex items-center gap-1">
              <Link
                href="/games"
                className="rounded-full px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
              >
                My games
              </Link>
              <AuthButton />
            </div>
          </div>
        </header>
        {children}
      </div>
    </AuthProvider>
  );
}
