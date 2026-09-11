// app/api/generate/route.ts
//
// POST { url } | { manualAssets } -> { jobId }. Build spec §6, §12.
//
// Generation is a job, not a request (spec §6): we create the job row and
// respond with its id immediately, then run the actual pipeline via
// Next.js 15's `after()` so it keeps executing on this same invocation
// after the response has been sent — maxDuration=120 covers the ~30s
// pipeline budget. The client polls GET /api/generate/:jobId and sees the
// stage/percent/message fields update in near-real-time as onProgress
// writes them, which is the whole point of the job model (a 30s spinner
// reads as broken; "Found 14 products" reads as work happening).

export const runtime = "nodejs"; // sharp runs downstream of runGeneration; never Edge.
export const maxDuration = 120;

import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";

import { createJob, createGame, updateJob } from "@/lib/db/queries";
import { checkRateLimit } from "@/lib/rateLimit";
import type { GameSpec, JobStage } from "@/lib/engine/types";
// @/lib/engine is another track's module (pipeline). It is not visible to
// this file at write time in the concurrent build, but the contract is
// fixed (see build spec + task brief) — import and call it for real; a
// missing/throwing module surfaces as a normal pipeline error below, which
// lands the job in stage "error" rather than crashing the route.
import type { GenerationCallbacks, GenerationInput } from "@/lib/engine";
import { runGeneration } from "@/lib/engine";

const manualAssetSchema = z.object({
  url: z.string().url(),
  name: z.string().optional(),
  priceMinor: z.number().int().nonnegative().optional(),
});

const bodySchema = z.union([
  z.object({ url: z.string().url() }),
  z.object({ manualAssets: z.array(manualAssetSchema).min(1) }),
]);

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

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

async function runPipeline(
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
    const result = await runGeneration(input, callbacks);
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
      name: deriveGameName(result.spec, input.sourceUrl),
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

  const job = await createJob({ accountId: null, mode: input.mode, sourceUrl });

  after(() => runPipeline(job.id, input));

  return NextResponse.json({ jobId: job.id });
}
