// app/api/generate/[jobId]/route.ts
//
// GET -> Job. The client polls this while app/(app)/build/auto/[jobId]
// shows progress, per build spec §6/§12.

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getJob } from "@/lib/db/queries";
import { notFound, ownsRecord, requireAccount } from "@/lib/auth/server";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;

  const auth = await requireAccount();
  if (!auth.ok) return auth.response;

  const job = await getJob(jobId);
  // A job carries the full extracted AssetInventory of someone's site — not
  // something to hand out on a guessed id.
  if (!job || !ownsRecord(job, auth.accountId)) return notFound();

  return NextResponse.json(job);
}
