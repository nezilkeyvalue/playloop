// app/(app)/build/page.tsx — mode chooser: paste URL | upload (spec §15).
"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function BuildPage() {
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
    <div className="mx-auto max-w-xl">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Build a game</h1>
      <p className="mt-2 text-muted">
        Paste a website URL and we&apos;ll build it automatically, or upload your own
        images and build it by hand.
      </p>

      <form
        onSubmit={handleSubmit}
        className="mt-8 flex flex-col gap-2 rounded-2xl border border-border bg-card p-2 shadow-card sm:flex-row"
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
          disabled={loading}
          className="rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-50"
        >
          {loading ? "Starting…" : "Generate"}
        </button>
      </form>
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      <div className="mt-10 flex items-center gap-4 text-xs uppercase tracking-wide text-muted">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <a
        href="/build/manual"
        className="mt-6 block rounded-2xl border border-border bg-card px-5 py-3 text-center text-sm font-medium shadow-card transition hover:border-border"
      >
        Upload your own images instead
      </a>
    </div>
  );
}
