// app/(app)/build/auto/[jobId]/page.tsx
//
// Polls /api/generate/:jobId and shows job.message as the progress copy
// (spec §6: "progress messages matter more than they look"). Once
// extraction finishes, job.stage becomes "choosing" and job.match is
// populated with every template's eligibility/score — this page renders
// the eligible ones as cards and lets the user pick before any copy/AI
// generation happens (POST /api/generate/:jobId/choose). Redirects to the
// editor once stage === "done".
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { Job, TemplateId } from "@/lib/engine/types";
import { getTemplatePickerMeta } from "@/lib/capabilities";

const STAGE_LABELS: Partial<Record<Job["stage"], string>> = {
  queued: "Queued…",
  fetching: "Reading your site…",
  extracting: "Finding your products…",
  downloading: "Downloading images…",
  processing: "Preparing your products…",
  quality: "Checking image quality…",
  matching: "Matching games to your brand…",
  choosing: "Pick a game",
  thinking: "Writing your game…",
  composing: "Almost there…",
  done: "Ready!",
  error: "Something went wrong",
};

export default function AutoBuildProgressPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<TemplateId | null>(null);
  const [chooseError, setChooseError] = useState<string | null>(null);

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

  async function chooseTemplate(template: TemplateId) {
    if (selecting) return;
    setSelecting(template);
    setChooseError(null);
    try {
      const res = await fetch(`/api/generate/${jobId}/choose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template }),
      });
      if (!res.ok) {
        throw new Error("That game couldn't be started — try another one.");
      }
      // job.stage flips to "thinking" server-side; the poll loop above
      // (still running) picks it up on its next tick and this component
      // re-renders into the progress view automatically.
    } catch (err) {
      setChooseError(err instanceof Error ? err.message : "Something went wrong.");
      setSelecting(null);
    }
  }

  const stage = job?.stage ?? "queued";
  const label = job?.message || STAGE_LABELS[stage] || "Working…";
  const percent = job?.percent ?? 5;

  if (stage === "choosing" && job?.match) {
    return (
      <TemplatePicker
        match={job.match}
        selecting={selecting}
        error={chooseError}
        onChoose={chooseTemplate}
      />
    );
  }

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

function fitLabel(score: number): string {
  if (score >= 0.75) return "Great fit";
  if (score >= 0.5) return "Good fit";
  return "Workable";
}

function TemplatePicker({
  match,
  selecting,
  error,
  onChoose,
}: {
  match: NonNullable<Job["match"]>;
  selecting: TemplateId | null;
  error: string | null;
  onChoose: (template: TemplateId) => void;
}) {
  const eligible = match.results.filter((r) => r.eligible).sort((a, b) => b.score - a.score);
  const ineligible = match.results.filter((r) => !r.eligible);
  const [showNearMiss, setShowNearMiss] = useState(false);

  if (eligible.length === 0) {
    return (
      <div className="mx-auto max-w-lg text-center">
        <h1 className="font-display text-2xl font-semibold tracking-tight">No game quite fits yet</h1>
        <p className="mt-2 text-muted">
          We couldn&apos;t find enough usable products or images on that page to build any of our games
          automatically.
        </p>
        <a
          href="/build/manual"
          className="mt-6 inline-block rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
        >
          Build it manually instead
        </a>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl text-center">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Pick your game</h1>
      <p className="mt-2 text-muted">
        Based on what we found on your site, here&apos;s what we can build — choose one to continue.
      </p>

      {error && (
        <div className="mt-6 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 gap-4 text-left sm:grid-cols-2">
        {eligible.map((result, i) => {
          const meta = getTemplatePickerMeta(result.template);
          const isBest = i === 0;
          const isSelecting = selecting === result.template;
          const disabled = selecting !== null;

          return (
            <button
              key={result.template}
              type="button"
              disabled={disabled}
              onClick={() => onChoose(result.template)}
              className={`group relative flex flex-col rounded-2xl border p-5 text-left shadow-card transition ${
                isSelecting
                  ? "border-primary bg-primary/5"
                  : "border-border bg-card hover:border-primary/40 hover:shadow-elevated"
              } ${disabled && !isSelecting ? "opacity-50" : ""} disabled:cursor-not-allowed`}
            >
              {isBest && (
                <span className="absolute -top-2.5 left-4 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-semibold text-primary-foreground">
                  Recommended
                </span>
              )}
              <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">
                {meta.name}
              </h2>
              <p className="mt-1.5 text-sm text-muted">{meta.summary}</p>

              <div className="mt-4 flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">
                  {fitLabel(result.score)}
                </span>
                <span className="text-sm font-medium text-primary opacity-0 transition group-hover:opacity-100">
                  {isSelecting ? "Setting up…" : "Choose →"}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {ineligible.length > 0 && (
        <div className="mt-10 text-left">
          <button
            type="button"
            onClick={() => setShowNearMiss((v) => !v)}
            className="text-sm font-medium text-muted underline underline-offset-4 hover:text-foreground"
          >
            {showNearMiss ? "Hide" : "Show"} games that need more from your site ({ineligible.length})
          </button>
          {showNearMiss && (
            <ul className="mt-4 space-y-3">
              {ineligible.map((result) => {
                const meta = getTemplatePickerMeta(result.template);
                const gapSummary =
                  result.gaps?.[0]?.reason ??
                  result.warnings[0] ??
                  "Not enough matching product images on this page.";
                return (
                  <li
                    key={result.template}
                    className="rounded-xl border border-border bg-card/50 px-4 py-3 text-left"
                  >
                    <p className="font-medium text-foreground">{meta.name}</p>
                    <p className="mt-1 text-sm text-muted">{gapSummary}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <a href="/build/manual" className="mt-8 inline-block text-sm text-muted underline underline-offset-4">
        None of these? Build it manually instead
      </a>
    </div>
  );
}
