// app/api/generate/[jobId]/route.ts
//
// GET -> Job. The client polls this while app/(app)/build/auto/[jobId]
// shows progress, per build spec §6/§12.

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getJob } from "@/lib/db/queries";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = await getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(job);
}
