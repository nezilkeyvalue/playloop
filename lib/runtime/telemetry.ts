// lib/runtime/telemetry.ts
//
// Fires play events by calling the /api/plays/* and /api/leads routes
// (build spec §12 API contract, §16 Analytics). Those routes are owned by
// a different, concurrently-building track — they don't exist yet, so
// every call here is fire-and-forget with one retry, and NEVER throws into
// the game loop. A 404 today is expected; see the report for what this
// track needs back from `/api/plays/*`.
//
// No browser storage anywhere (build spec §4, §14, §23): session identity
// lives entirely in `sessionToken`, held only in memory by mount.ts for the
// lifetime of one play, never persisted client-side.

export type TelemetryEvent =
  | "impression"
  | "start"
  | "complete"
  | "replay"
  | "reward_revealed"
  | "lead_captured";

async function postOnce<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // Lets the request survive a page/iframe teardown (e.g. a "complete"
    // fired right as the reward screen unmounts).
    keepalive: true,
  });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return (await res.json()) as T;
}

/** POST with one retry on failure. Never throws — resolves to null instead. */
async function postWithRetry<T>(url: string, body: unknown): Promise<T | null> {
  try {
    return await postOnce<T>(url, body);
  } catch {
    try {
      return await postOnce<T>(url, body);
    } catch (err) {
      if (typeof console !== "undefined") {
        console.debug(`[playloop] telemetry call to ${url} failed (route may not exist yet):`, err);
      }
      return null;
    }
  }
}

/**
 * POST /api/plays/start { slug } → { sessionToken }
 * Mints the server-side session for one play. Returns null (never throws)
 * if the route 404s or the network fails — mount.ts treats a null token as
 * "run the game anyway, just don't expect finish()/leads() to do anything".
 */
export async function beginSession(slug: string): Promise<string | null> {
  const result = await postWithRetry<{ sessionToken: string }>("/api/plays/start", { slug });
  return result?.sessionToken ?? null;
}

/**
 * POST /api/plays/finish { sessionToken, score } → { tier, code }
 * Server-validates the score against the capability's maxRealistic and
 * elapsed time (build spec §12, §17) — the runtime's own reward.ts
 * resolution is what's actually shown; the server's tier/code here is the
 * source of truth once this route exists, and `code` is what the future
 * "email my code" step sends.
 */
export async function endSession(
  sessionToken: string | null,
  score: number,
): Promise<{ tier: string | null; code: string | null }> {
  if (!sessionToken) return { tier: null, code: null };
  const result = await postWithRetry<{ tier: string; code: string }>("/api/plays/finish", {
    sessionToken,
    score: Math.max(0, Math.round(score)),
  });
  return { tier: result?.tier ?? null, code: result?.code ?? null };
}

export type CouponClaimStatus = "ok" | "no_reward" | "expired" | "exhausted" | "error";

export interface CouponClaim {
  status: CouponClaimStatus;
  code: string | null;
}

/**
 * POST /api/plays/claim-coupon { sessionToken } → { status, code }
 *
 * Consumes one coupon from the tier's pool and returns it. Idempotent: the
 * same session always gets the same code back and only the first call
 * consumes anything, so the reward screen's Copy button is safe to mash.
 *
 * Uses postWithRetry like the rest of this module, which is only safe
 * BECAUSE of that idempotency — a retried claim cannot double-spend.
 */
export async function claimCoupon(sessionToken: string | null): Promise<CouponClaim> {
  if (!sessionToken) return { status: "error", code: null };
  const result = await postWithRetry<{ status: CouponClaimStatus; code: string | null }>(
    "/api/plays/claim-coupon",
    { sessionToken },
  );
  if (!result) return { status: "error", code: null };
  return { status: result.status ?? "error", code: result.code ?? null };
}

/** POST /api/leads { sessionToken, email } → { ok } */
export interface LeadResult {
  /** The address was stored. */
  ok: boolean;
  /** An email with the code was actually dispatched. */
  emailed: boolean;
}

export async function captureLead(
  sessionToken: string | null,
  email: string,
): Promise<LeadResult> {
  if (!sessionToken) return { ok: false, emailed: false };
  const result = await postWithRetry<{ ok: boolean; emailed?: boolean }>("/api/leads", {
    sessionToken,
    email,
  });
  // `emailed` is reported separately from `ok` so the reward screen can tell
  // the player what actually happened. Saying "check your inbox" when no mail
  // transport is configured — or when the sending domain is unverified — is
  // worse than silence, because they wait instead of copying the code that is
  // on screen.
  return { ok: result?.ok ?? false, emailed: Boolean(result?.emailed) };
}

/**
 * Lightweight lifecycle marker for the four events (`impression`, `replay`,
 * `reward_revealed`, plus a general hook) that build spec §16 lists but
 * §12's API contract has no dedicated ingestion route for — `start`,
 * `complete` and `lead_captured` carry real payloads through beginSession /
 * endSession / captureLead above because the runtime needs their responses
 * back (sessionToken, tier/code, ok). Wiring a real analytics endpoint
 * later is a one-line change here, not a change at every call site in
 * mount.ts.
 */
export function trackEvent(event: TelemetryEvent, detail?: Record<string, unknown>): void {
  if (typeof console !== "undefined") {
    console.debug(`[playloop] event: ${event}`, detail ?? {});
  }
}
