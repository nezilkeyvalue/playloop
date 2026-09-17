// app/(app)/build/page.tsx — mode chooser: paste URL | upload (spec §15).
"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AuthGate } from "@/components/AuthGate";
import { useAuth } from "@/components/AuthProvider";
import { HeroDoodle } from "@/components/HeroDoodle";
import { Reveal } from "@/components/Reveal";
import { ShowcaseSlideshow } from "@/components/ShowcaseSlideshow";
import { ImageIcon } from "@/components/EditorIcons";

export default function BuildPage() {
  return (
    <AuthGate
      title="Sign in to build a game"
      description="We save every game to your account so you can edit, publish and embed it later."
    >
      <BuildForm />
    </AuthGate>
  );
}

function BuildForm() {
  const router = useRouter();
  const { requireLogin } = useAuth();
  const [url, setUrl] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!rightsConfirmed) return;
    if (!requireLogin()) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, rightsConfirmed }),
      });
      if (res.status === 401) {
        setLoading(false);
        requireLogin("Your session expired. Sign in again to build your game.");
        return;
      }
      if (!res.ok) throw new Error("Could not start generation. Try again.");
      const { jobId } = (await res.json()) as { jobId: string };
      router.push(`/build/auto/${jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      {/* --- hero -------------------------------------------------------- */}
      <div className="relative flex min-h-[220px] flex-col items-center justify-center px-4 pb-2 pt-6 text-center">
        <HeroDoodle />
        <div className="relative animate-fade-up">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            Live in 60 seconds, no code
          </span>
          <h1 className="mt-5 font-display text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Build a game
          </h1>
          <p className="mx-auto mt-3 max-w-lg text-muted">
            Paste a website URL and we&apos;ll grab the logo, colours and products, pick a
            game that fits, and build it.
          </p>
        </div>
      </div>

      {/* --- form ---------------------------------------------------------- */}
      <form
        onSubmit={handleSubmit}
        className="mx-auto mt-2 flex w-full max-w-xl flex-col gap-2 rounded-2xl border border-border bg-card p-2 shadow-card animate-fade-up sm:flex-row"
        style={{ animationDelay: "80ms" }}
      >
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-store.com"
          className="flex-1 rounded-xl bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted"
        />
        <button
          type="submit"
          disabled={loading || !rightsConfirmed}
          className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-elevated transition hover:opacity-90 active:scale-[0.98] disabled:opacity-50 disabled:shadow-none"
        >
          {loading ? "Starting…" : "Generate"}
        </button>
      </form>

      <label
        className="mx-auto mt-4 flex max-w-xl items-start gap-2 text-left text-sm text-muted animate-fade-up"
        style={{ animationDelay: "100ms" }}
      >
        <input
          type="checkbox"
          checked={rightsConfirmed}
          onChange={(e) => setRightsConfirmed(e.target.checked)}
          className="mt-0.5 accent-primary"
        />
        <span>
          I own this website, or have permission from its owner, to use its content and
          images to build this game.
        </span>
      </label>

      {error && <p className="mx-auto mt-3 max-w-xl text-center text-sm text-destructive">{error}</p>}

      <div
        className="mx-auto mt-8 flex w-full max-w-xl items-center gap-4 text-xs uppercase tracking-wide text-muted animate-fade-up"
        style={{ animationDelay: "120ms" }}
      >
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <Link
        href="/build/manual"
        className="mx-auto mt-4 flex w-full max-w-xl items-center gap-3 rounded-2xl border border-border bg-card p-4 text-left shadow-card transition hover:border-primary/30 hover:shadow-elevated animate-fade-up"
        style={{ animationDelay: "140ms" }}
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
          <ImageIcon className="h-5 w-5" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium">Upload your own images instead</span>
          <span className="block text-xs text-muted">
            No website to pull from? Build it by hand from your own product photos.
          </span>
        </span>
      </Link>

      {/* --- how it works -------------------------------------------------- */}
      <div className="mt-24 grid w-full grid-cols-1 gap-4 text-sm sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <Reveal key={s.n} delay={i * 80}>
            <Step n={s.n} text={s.text} />
          </Reveal>
        ))}
      </div>

      {/* --- showcase -------------------------------------------------------- */}
      <Reveal delay={0} className="mt-24 w-full text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-muted">See it in action</p>
        <h2 className="mx-auto mt-2 max-w-md font-display text-2xl font-semibold tracking-tight">
          Real builds, running live
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">
          Not screenshots — the actual runtime. Click through a few examples below.
        </p>
        <div className="mx-auto mt-8 max-w-2xl text-left">
          <ShowcaseSlideshow />
        </div>
      </Reveal>
    </div>
  );
}

const STEPS = [
  { n: 1, text: "Paste your URL — we read your site and products." },
  { n: 2, text: "Preview the game, tweak colours, copy and rewards." },
  { n: 3, text: "Publish and copy one line of embed code." },
];

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 text-left shadow-card transition-shadow hover:shadow-elevated">
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-xs font-bold text-secondary-foreground">
        {n}
      </div>
      <p className="mt-3 text-foreground/90">{text}</p>
    </div>
  );
}
