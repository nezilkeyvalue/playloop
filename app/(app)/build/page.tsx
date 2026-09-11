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
      <h1 className="text-2xl font-semibold">Build a game</h1>
      <p className="mt-2 text-ink/60">
        Paste a website URL and we&apos;ll build it automatically, or upload your own
        images and build it by hand.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-2 sm:flex-row">
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
          className="rounded-md bg-ink px-5 py-3 text-sm font-medium text-paper transition disabled:opacity-50"
        >
          {loading ? "Starting…" : "Generate"}
        </button>
      </form>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-10 flex items-center gap-4 text-xs uppercase tracking-wide text-ink/40">
        <span className="h-px flex-1 bg-ink/10" />
        or
        <span className="h-px flex-1 bg-ink/10" />
      </div>

      <a
        href="/build/manual"
        className="mt-6 block rounded-md border border-ink/20 px-5 py-3 text-center text-sm font-medium hover:border-ink/40"
      >
        Upload your own images instead
      </a>
    </div>
  );
}
