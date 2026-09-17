// app/api/generate/route.ts
//
// POST { url } | { manualAssets } -> { jobId }. Build spec §6, §12.
//
// Generation is a job, not a request (spec §6): we create the job row and
// respond with its id immediately, then run the extraction phase via
// Next.js 15's `after()` so it keeps executing on this same invocation
// after the response has been sent. The pipeline PAUSES once the matcher
// has scored every template (job.stage becomes "choosing", with
// job.match populated) instead of picking one itself — the client shows
// the eligible templates and the user picks, which resumes generation via
// POST /api/generate/:jobId/choose (see that route). maxDuration=120
// covers this phase's ~15s budget; the composition phase after the user's
// choice has its own budget in the choose route.
//
// The client polls GET /api/generate/:jobId and sees the
// stage/percent/message fields update in near-real-time as onProgress
// writes them, which is the whole point of the job model (a 30s spinner
// reads as broken; "Found 14 products" reads as work happening).

export const runtime = "nodejs"; // sharp runs downstream of runExtraction; never Edge.
export const maxDuration = 120;

import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";

import { createJob, updateJob } from "@/lib/db/queries";
import { requireAccount } from "@/lib/auth/server";
import { checkRateLimit } from "@/lib/rateLimit";
import type { JobStage } from "@/lib/engine/types";
// @/lib/engine is another track's module (pipeline). It is not visible to
// this file at write time in the concurrent build, but the contract is
// fixed (see build spec + task brief) — import and call it for real; a
// missing/throwing module surfaces as a normal pipeline error below, which
// lands the job in stage "error" rather than crashing the route.
import type { GenerationCallbacks, GenerationInput } from "@/lib/engine";
import { runExtraction } from "@/lib/engine";

const manualAssetSchema = z.object({
  url: z.string().url(),
  name: z.string().optional(),
  priceMinor: z.number().int().nonnegative().optional(),
});

// Required, not optional-with-a-default: the client UI (app/(app)/build/
// page.tsx) gates its own submit button on this same checkbox, but that's
// cosmetic on its own — a direct API call could just omit it. z.literal(true)
// means the request is rejected outright (400, same as any other malformed
// body) unless the caller explicitly affirms it, so the confirmation is
// actually load-bearing rather than decorative. This route is the one that
// scrapes a *third-party* URL server-side, so what's being confirmed here is
// specifically the right to use that site's own content/assets — not just
// "I agree to terms."
const rightsConfirmedSchema = {
  rightsConfirmed: z.literal(true, {
    errorMap: () => ({ message: "You must confirm you have the rights to use this site's content." }),
  }),
};

const bodySchema = z.union([
  z.object({ url: z.string().url(), ...rightsConfirmedSchema }),
  z.object({ manualAssets: z.array(manualAssetSchema).min(1), ...rightsConfirmedSchema }),
]);

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

async function runExtractionPhase(
  jobId: string,
  input: GenerationInput,
): Promise<void> {
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
    const result = await runExtraction(input, callbacks);
    const eligibleCount = result.match.results.filter((r) => r.eligible).length;
    await updateJob(jobId, {
      inventory: result.inventory,
      match: result.match,
      businessName: result.businessName ?? null,
      businessDescription: result.businessDescription ?? null,
      droppedCount: result.droppedCount,
      stage: "choosing",
      percent: 70,
      message:
        eligibleCount > 0
          ? "Pick a game"
          : "No template fit well — you can still continue in manual mode",
    });
  } catch (err) {
    await reportJobFailure(jobId, err);
  }
}

/**
 * Best-effort — this runs inside `after()`, detached from the request that
 * started it, so nothing downstream awaits or `.catch()`es this function's
 * own promise. Node's default (since v15, still true in the v22 this repo
 * runs on) is to crash the entire process on an unhandled rejection — and
 * `updateJob()` can itself throw (a real Supabase write, `if (error) throw
 * error`). Before this existed, a transient DB error while reporting a
 * *different* failure took the whole dev server down with it — confirmed
 * live: the exact `try { throw X } catch { await updateJobThatAlsoThrows()
 * }` shape reproduces a hard process exit, not just a failed request. This
 * is that reporting call, isolated so its own failure can only ever be
 * logged, never fatal. */
async function reportJobFailure(jobId: string, err: unknown): Promise<void> {
  try {
    await updateJob(jobId, {
      stage: "error",
      error: err instanceof Error ? err.message : "Generation failed.",
    });
  } catch (reportErr) {
    console.error(`[generate] failed to record error state for job ${jobId}:`, reportErr);
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let input: GenerationInput;
  let sourceUrl: string | undefined;

  if ("url" in parsed.data) {
    sourceUrl = parsed.data.url;
    input = { mode: "auto", sourceUrl };
  } else {
    input = { mode: "manual", manualAssets: parsed.data.manualAssets };
  }

  // Per-IP and per-domain rate limiting (spec §17: this route is the
  // scrape-abuse surface, since it fetches a user-supplied URL server-side).
  let domain: string | undefined;
  if (sourceUrl) {
    try {
      domain = new URL(sourceUrl).hostname;
    } catch {
      // already validated by z.string().url() above; unreachable in practice
    }
  }
  const rate = checkRateLimit({ ip: getClientIp(req), domain });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) } },
    );
  }

  // A generation job fetches a third-party site server-side and produces a
  // game that belongs to someone. Both of those want a real owner, so this is
  // where the landing page's "Make it playable" login gate is actually
  // enforced — the client-side modal is a courtesy, this is the check.
  const auth = await requireAccount();
  if (!auth.ok) return auth.response;

  const job = await createJob({ accountId: auth.accountId, mode: input.mode, sourceUrl });

  after(() => runExtractionPhase(job.id, input));

  return NextResponse.json({ jobId: job.id });
}
