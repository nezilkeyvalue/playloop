// app/(marketing)/page.tsx
//
// Replaces the placeholder landing page (spec §1, §15 flow diagram): URL
// input that posts to /api/generate and routes to /build/auto/:jobId, plus
// a manual-mode link.
"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LandingPage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) throw new Error("Could not start generation. Try again.");
      const { jobId } = (await res.json()) as { jobId: string };
      router.push(`/build/auto/${jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-10 p-8 text-center">
      <div>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">PlayLoop</h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-ink/70">
          Make your brand playable in 60 seconds. Paste a website URL — we&apos;ll
          grab the logo, colours and products, pick a game that fits, and build it.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-xl flex-col gap-2 sm:flex-row"
      >
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-store.com"
          className="flex-1 rounded-md border border-ink/20 bg-paper px-4 py-3 text-sm outline-none focus:border-ink/50"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-ink px-6 py-3 text-sm font-medium text-paper transition disabled:opacity-50"
        >
          {loading ? "Starting…" : "Make it playable"}
        </button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <p className="text-sm text-ink/50">
        Prefer to build it yourself?{" "}
        <Link href="/build/manual" className="underline">
          Upload images instead
        </Link>
      </p>

      <div className="mt-6 grid grid-cols-1 gap-6 text-sm text-ink/60 sm:grid-cols-3">
        <Step n={1} text="Paste your URL — we read your site and products." />
        <Step n={2} text="Preview the game, tweak colours, copy and rewards." />
        <Step n={3} text="Publish and copy one line of embed code." />
      </div>
    </main>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div className="rounded-md border border-ink/10 p-4 text-left">
      <div className="text-xs font-semibold text-ink/40">STEP {n}</div>
      <p className="mt-1">{text}</p>
    </div>
  );
}
