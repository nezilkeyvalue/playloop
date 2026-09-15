// app/(app)/build/auto/[jobId]/page.tsx
//
// Polls /api/generate/:jobId and shows job.message as the progress copy
// (spec §6: "progress messages matter more than they look"). Redirects to
// the game preview once stage === "done".
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { Job } from "@/lib/engine/types";

const STAGE_LABELS: Partial<Record<Job["stage"], string>> = {
  queued: "Queued…",
  fetching: "Reading your site…",
  extracting: "Finding your products…",
  downloading: "Downloading images…",
  processing: "Preparing your products…",
  quality: "Checking image quality…",
  matching: "Matching a game to your brand…",
  thinking: "Choosing your game…",
  composing: "Almost there…",
  done: "Ready!",
  error: "Something went wrong",
};

export default function AutoBuildProgressPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch(`/api/generate/${jobId}`, { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) {
          setPollError("Couldn't find that job.");
          return;
        }
        const data: Job = await res.json();
        setJob(data);
        if (data.stage === "done" && data.gameId) {
          router.push(`/games/${data.gameId}`);
          return;
        }
        if (data.stage === "error") return;
      } catch {
        // transient network hiccup — keep polling
      }
      if (!cancelled) timer = setTimeout(poll, 1200);
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId, router]);

  const stage = job?.stage ?? "queued";
  const label = job?.message || STAGE_LABELS[stage] || "Working…";
  const percent = job?.percent ?? 5;

  return (
    <div className="mx-auto max-w-lg text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary">
        <span className="h-6 w-6 animate-pulse rounded-full bg-white/90" />
      </div>
      <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight">Building your game</h1>
      <p className="mt-2 text-muted">This usually takes under a minute.</p>

      <div className="mt-10 h-2 w-full overflow-hidden rounded-full bg-foreground/[0.08]">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
          style={{ width: `${Math.min(100, Math.max(4, percent))}%` }}
        />
      </div>
      <p className="mt-4 text-sm text-foreground/80">{label}</p>

      {(stage === "error" || pollError) && (
        <div className="mt-8 rounded-2xl border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
          <p>{job?.error ?? pollError ?? "Generation failed."}</p>
          <a href="/build/manual" className="mt-3 inline-block font-medium underline underline-offset-4">
            Try manual mode instead
          </a>
        </div>
      )}
    </div>
  );
}
