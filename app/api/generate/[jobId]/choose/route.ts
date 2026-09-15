// app/api/generate/[jobId]/choose/route.ts
//
// POST { template } -> { ok: true }. Resumes a job paused at stage
// "choosing" (see app/api/generate/route.ts) with the template the user
// picked from the eligible list. Runs composition (thinking -> composing)
// via Next.js 15's `after()`, same pattern as the extraction phase — the
// client keeps polling GET /api/generate/:jobId and sees stage progress
// through to "done" with a gameId, exactly as it did before this route
// existed for the single-phase flow.

export const runtime = "nodejs"; // sharp runs transitively via brain.ts's image resizing; never Edge.
export const maxDuration = 60;

import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";

import { createGame, getJob, updateJob } from "@/lib/db/queries";
import type { GameSpec, JobStage, TemplateId } from "@/lib/engine/types";
import type { GenerationCallbacks } from "@/lib/engine";
import { runComposition } from "@/lib/engine";

// Not a z.enum of TemplateId — that list would drift from
// lib/engine/types.ts's TemplateId union every time a template is added.
// The real validation is the `isEligible` lookup below, against this job's
// own match report: only a template this exact inventory actually scored
// as eligible can ever be chosen, which is a strictly tighter check than
// "is a known template id" anyway.
const bodySchema = z.object({ template: z.string().min(1) });

function deriveGameName(spec: GameSpec, sourceUrl?: string | null): string {
  if (spec.brand.name) return spec.brand.name;
  if (sourceUrl) {
    try {
      return new URL(sourceUrl).hostname.replace(/^www\./, "");
    } catch {
      // fall through
    }
  }
  return spec.copy.headline || "Untitled game";
}

async function runCompositionPhase(jobId: string, template: TemplateId): Promise<void> {
  const job = await getJob(jobId);
  // Re-checked inside the background task too (not just the route handler
  // below) since a job can theoretically be re-chosen while this is
  // already queued — belt and suspenders, cheap given jobs are tiny rows.
  if (!job || !job.inventory || !job.match) {
    await updateJob(jobId, { stage: "error", error: "Job is missing its extraction results." });
    return;
  }

  const callbacks: GenerationCallbacks = {
    onProgress: async (patch) => {
      await updateJob(jobId, {
        stage: patch.stage as JobStage,
        percent: patch.percent,
        message: patch.message ?? null,
      });
    },
  };

  try {
    const result = await runComposition(
      {
        inventory: job.inventory,
        match: job.match,
        template,
        mode: job.mode,
        businessName: job.businessName ?? undefined,
        businessDescription: job.businessDescription ?? undefined,
        droppedCount: job.droppedCount ?? undefined,
      },
      callbacks,
    );
    await updateJob(jobId, {
      inventory: result.inventory,
      match: result.match,
      spec: result.spec,
      stage: "done",
      percent: 100,
      message: "Your game is ready.",
    });
    const game = await createGame({
      accountId: null,
      name: deriveGameName(result.spec, job.sourceUrl),
      spec: result.spec,
      placement: result.spec.placements[0] ?? "section",
    });
    await updateJob(jobId, { gameId: game.id });
  } catch (err) {
    await updateJob(jobId, {
      stage: "error",
      error: err instanceof Error ? err.message : "Generation failed.",
    });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", details: parsed.error.flatten() }, { status: 400 });
  }

  const job = await getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (job.stage !== "choosing") {
    // Already resumed (double-click), or not far enough along yet — either
    // way, resuming again would double-create a game.
    return NextResponse.json({ error: "not_ready", stage: job.stage }, { status: 409 });
  }
  if (!job.match) {
    return NextResponse.json({ error: "missing_match_report" }, { status: 409 });
  }
  const chosen = job.match.results.find((r) => r.eligible && r.template === parsed.data.template);
  if (!chosen) {
    return NextResponse.json({ error: "ineligible_template" }, { status: 400 });
  }

  // Move off "choosing" immediately (not just inside the background task)
  // so a second POST while the first is still in flight hits the 409 above
  // instead of racing it.
  await updateJob(jobId, { stage: "thinking", percent: 72, message: "Writing your game…" });

  after(() => runCompositionPhase(jobId, chosen.template));

  return NextResponse.json({ ok: true });
}
