// app/(app)/layout.tsx — shared chrome for the "authenticated-feeling"
// builder area. No real auth in the MVP (spec §19); this is just nav.

import Link from "next/link";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-ink/10">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            PlayLoop
          </Link>
          <nav className="flex gap-6 text-sm text-ink/60">
            <Link href="/build" className="hover:text-ink">
              New game
            </Link>
            <Link href="/games" className="hover:text-ink">
              My games
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}
