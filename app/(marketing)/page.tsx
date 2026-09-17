// app/(marketing)/page.tsx
//
// Replaces the placeholder landing page (spec §1, §15 flow diagram): URL
// input that posts to /api/generate and routes to /build/auto/:jobId, plus
// a manual-mode link.
"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Reveal } from "@/components/Reveal";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { HeroDoodle } from "@/components/HeroDoodle";
import { ShowcaseSlideshow } from "@/components/ShowcaseSlideshow";
import { useAuth } from "@/components/AuthProvider";

export default function LandingPage() {
  const router = useRouter();
  const { requireLogin, authEnabled, user } = useAuth();
  const [url, setUrl] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // app/auth/callback/route.ts bounces failed Google consent back here with
  // the reason on the query string, rather than dropping the user on a blank
  // page with no idea why they aren't signed in.
  //
  // Read straight off window.location rather than via useSearchParams(): that
  // hook opts the whole route out of static rendering unless it sits inside a
  // Suspense boundary, and this landing page is not worth wrapping for a query
  // param that is absent on every normal visit.
  useEffect(() => {
    const authError = new URLSearchParams(window.location.search).get("auth_error");
    if (authError) {
      setError(`Sign-in failed: ${authError}`);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!rightsConfirmed) return;

    // The login gate for the primary CTA. requireLogin() opens the modal and
    // returns false when there's no session; the generation request is not
    // sent at all in that case, because POST /api/generate now 401s without
    // one and a half-started job the user can't see is worse than no job.
    if (!requireLogin("Sign in to build your game — we'll save it to My games so you can edit, publish and embed it.")) {
      return;
    }

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

  const ctaLabel = loading
    ? "Starting…"
    : authEnabled && !user
      ? "Log in to build"
      : "Make it playable";

  return (
    <main className="flex flex-col items-center px-6 pb-32 pt-32 text-center">
      <div className="relative flex min-h-[380px] w-full flex-col items-center justify-center">
        <HeroDoodle />
        <div className="animate-fade-up">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            Live in 60 seconds, no code
          </span>

          <h1 className="mt-6 font-display text-5xl font-semibold tracking-tight text-foreground sm:text-6xl">
            Make your brand playable
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-muted">
            Paste a website URL — we&apos;ll grab the logo, colours and products,
            pick a game that fits, and build it.
          </p>
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className="mt-10 flex w-full max-w-xl flex-col gap-2 rounded-2xl border border-border bg-card p-2 shadow-card animate-fade-up sm:flex-row"
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
          className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
        >
          {ctaLabel}
        </button>
      </form>

      <label className="mt-3 flex max-w-xl items-start gap-2 text-left text-sm text-muted animate-fade-up" style={{ animationDelay: "100ms" }}>
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

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      <p className="mt-5 text-sm text-muted">
        Prefer to build it yourself?{" "}
        <Link href="/build/manual" className="font-medium text-foreground underline underline-offset-4">
          Upload images instead
        </Link>
      </p>

      <div className="mt-16 grid w-full max-w-4xl grid-cols-1 gap-4 text-sm sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <Reveal key={s.n} delay={i * 80}>
            <Step n={s.n} text={s.text} />
          </Reveal>
        ))}
      </div>

      <Reveal delay={0} className="mt-28 w-full max-w-4xl">
        <p className="text-sm font-medium uppercase tracking-wide text-muted">See it in action</p>
        <h2 className="mx-auto mt-2 max-w-lg font-display text-3xl font-semibold tracking-tight">
          Any brand, the same 60 seconds
        </h2>
        <p className="mx-auto mt-2 max-w-md text-muted">
          Real builds, running live — not screenshots. It auto-advances, or click through it yourself.
        </p>
        <div className="mt-8">
          <ShowcaseSlideshow />
        </div>
      </Reveal>

      <Reveal delay={0} className="mt-28 grid w-full max-w-3xl grid-cols-1 gap-8 sm:grid-cols-3">
        <StatBlock value={60} suffix="s" label="from URL to playable game" />
        <StatBlock value={7} label="ready-made game templates" />
        <StatBlock value={1} label="line of code to embed" />
      </Reveal>
    </main>
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

function StatBlock({
  value,
  suffix = "",
  label,
}: {
  value: number;
  suffix?: string;
  label: string;
}) {
  return (
    <div>
      <div className="font-display text-4xl font-semibold tracking-tight text-primary">
        <AnimatedNumber value={value} suffix={suffix} />
      </div>
      <p className="mt-1 text-sm text-muted">{label}</p>
    </div>
  );
}

