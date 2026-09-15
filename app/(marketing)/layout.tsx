// app/(marketing)/layout.tsx — thin shared header for the public pages
// (landing, gallery). The builder area has its own chrome in app/(app)/layout.tsx.
import Link from "next/link";
import { Logomark } from "@/components/Logomark";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="absolute inset-x-0 top-0 z-40">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link href="/" className="flex items-center gap-2">
            <Logomark className="h-7 w-7" />
            <span className="font-display text-lg font-semibold tracking-tight">PlayLoop</span>
          </Link>
          <Link
            href="/games"
            className="rounded-full px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
          >
            My games
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}
