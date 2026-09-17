// components/CouponManager.tsx
//
// Per-reward-tier coupon administration, rendered inside each RewardRow in
// the editor (app/(app)/games/[id]/page.tsx).
//
// Two halves that live in different places and must not be confused:
//
//   * TERMS (T&C text, expiry date, offer link) are part of GameSpec, saved
//     through the same PATCH /api/games/:id the rest of the editor uses, and
//     shipped to the browser so the reward screen can render them with no
//     extra request.
//   * CODES are rows in the `coupons` table, managed through
//     /api/games/:id/coupons, and never sent to a player in bulk — the
//     runtime receives exactly one, from /api/plays/claim-coupon.
//
// The component deliberately shows COUNTS, not codes, by default. A merchant
// screen-sharing their editor should not be broadcasting a live pool of
// discount codes.

"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { CouponTerms, CouponTierStats, RewardTier } from "@/lib/engine/types";
import {
  COUPON_TERMS_MAX,
  validateCouponTerms,
  type CouponTermsIssue,
} from "@/lib/engine/specRules";

/** Below this many remaining codes the row nags the merchant to top up. */
const LOW_STOCK_THRESHOLD = 10;

interface UploadSummary {
  inserted: number;
  duplicates: string[];
  source?: { format: string; columnHeader: string | null; rowsScanned: number };
  skipped?: { blank: number; duplicatesInFile: number; invalidCount: number };
  collisions?: number;
  requested?: number;
}

export function CouponManager({
  gameId,
  tierIndex,
  tier,
  onCommitTerms,
}: {
  gameId: string;
  /** Index into spec.rewards — the key coupon pools are stored under. */
  tierIndex: number;
  tier: RewardTier;
  /** Persists the terms through the editor's own spec patch pipeline. */
  onCommitTerms: (coupon: CouponTerms | null) => void;
}) {
  const baseId = useId();
  const [stats, setStats] = useState<CouponTierStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "generate" | "upload" | "paste" | "clear">(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  const [expanded, setExpanded] = useState(false);

  const [terms, setTerms] = useState(tier.coupon?.terms ?? "");
  const [expiresAt, setExpiresAt] = useState(tier.coupon?.expiresAt ?? "");
  const [offerUrl, setOfferUrl] = useState(tier.coupon?.offerUrl ?? "");
  const [termsIssues, setTermsIssues] = useState<CouponTermsIssue[]>([]);

  const [count, setCount] = useState("50");
  const [length, setLength] = useState("8");
  const [prefix, setPrefix] = useState("");
  const [pasted, setPasted] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTerms(tier.coupon?.terms ?? "");
    setExpiresAt(tier.coupon?.expiresAt ?? "");
    setOfferUrl(tier.coupon?.offerUrl ?? "");
  }, [tier]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/games/${gameId}/coupons`, { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load coupon stock.");
      const data = (await res.json()) as { tiers: CouponTierStats[] };
      setStats(data.tiers.find((t) => t.tierIndex === tierIndex) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [gameId, tierIndex]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function commitTerms() {
    const draft: CouponTerms = {};
    if (terms.trim()) draft.terms = terms.trim();
    if (expiresAt.trim()) draft.expiresAt = expiresAt.trim();
    if (offerUrl.trim()) draft.offerUrl = offerUrl.trim();

    const issues = validateCouponTerms(draft);
    setTermsIssues(issues);
    if (issues.length > 0) return;

    // null, not {} — the contract treats an absent `coupon` as "no terms to
    // render", and an empty object would make the runtime reserve space for
    // nothing.
    onCommitTerms(Object.keys(draft).length === 0 ? null : draft);
  }

  function issueFor(field: CouponTermsIssue["field"]): string | null {
    return termsIssues.find((i) => i.field === field)?.message ?? null;
  }

  async function post(body: unknown, kind: "generate" | "paste") {
    setBusy(kind);
    setError(null);
    setSummary(null);
    try {
      const res = await fetch(`/api/games/${gameId}/coupons`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? data?.error ?? "Could not add codes.");
      setSummary(data as UploadSummary);
      setStats(
        (data.tiers as CouponTierStats[]).find((t) => t.tierIndex === tierIndex) ?? null,
      );
      if (kind === "paste") setPasted("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File) {
    setBusy("upload");
    setError(null);
    setSummary(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("tierIndex", String(tierIndex));
      const res = await fetch(`/api/games/${gameId}/coupons`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? data?.error ?? "Could not read that file.");
      setSummary(data as UploadSummary);
      setStats(
        (data.tiers as CouponTierStats[]).find((t) => t.tierIndex === tierIndex) ?? null,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function clearUnclaimed() {
    if (!confirm("Remove all unclaimed codes from this tier? Codes already given to players are kept.")) {
      return;
    }
    setBusy("clear");
    setError(null);
    setSummary(null);
    try {
      const res = await fetch(`/api/games/${gameId}/coupons?tierIndex=${tierIndex}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not clear codes.");
      setStats(
        (data.tiers as CouponTierStats[]).find((t) => t.tierIndex === tierIndex) ?? null,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed.");
    } finally {
      setBusy(null);
    }
  }

  const remaining = stats?.remaining ?? 0;
  const total = stats?.total ?? 0;
  const lowStock = total > 0 && remaining <= LOW_STOCK_THRESHOLD;

  return (
    <div className="mt-3 rounded-xl border border-border bg-background/50 p-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-xs font-semibold">Coupon codes</span>
        <span className="flex items-center gap-2">
          {loading ? (
            <span className="h-4 w-16 animate-pulse rounded-full bg-foreground/[0.08]" />
          ) : (
            <StockBadge remaining={remaining} total={total} />
          )}
          <span className="text-xs text-muted">{expanded ? "Hide" : "Manage"}</span>
        </span>
      </button>

      {/* The warning stays visible collapsed — an exhausted pool silently
          stops paying out, so it must not be hidden behind a disclosure. */}
      {!loading && total === 0 && (
        <p className="mt-2 text-xs text-muted">
          No codes yet. Players reaching this tier see the reward but get no code.
        </p>
      )}
      {!loading && lowStock && remaining > 0 && (
        <p className="mt-2 rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs text-foreground">
          Only {remaining} code{remaining === 1 ? "" : "s"} left — top up before they run out.
        </p>
      )}
      {!loading && total > 0 && remaining === 0 && (
        <p className="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-foreground">
          All {total} codes claimed. Players now see the reward with no code.
        </p>
      )}

      {expanded && (
        <div className="mt-3 space-y-4">
          {/* ---- Terms (saved into GameSpec) ---------------------------- */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-muted">
              Terms players see on the end screen
            </legend>

            <div>
              <label htmlFor={`${baseId}-terms`} className="sr-only">
                Terms and conditions
              </label>
              <textarea
                id={`${baseId}-terms`}
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                onBlur={commitTerms}
                rows={3}
                maxLength={COUPON_TERMS_MAX + 50}
                placeholder="e.g. One per customer. Not valid with other offers."
                className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <div className="mt-0.5 flex items-center justify-between">
                <FieldError message={issueFor("terms")} />
                <span className="text-[10px] text-muted">
                  {terms.length}/{COUPON_TERMS_MAX}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor={`${baseId}-exp`} className="block text-[10px] text-muted">
                  Expires
                </label>
                <input
                  id={`${baseId}-exp`}
                  type="date"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  onBlur={commitTerms}
                  className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <FieldError message={issueFor("expiresAt")} />
              </div>
              <div>
                <label htmlFor={`${baseId}-url`} className="block text-[10px] text-muted">
                  Offer link
                </label>
                <input
                  id={`${baseId}-url`}
                  type="url"
                  value={offerUrl}
                  onChange={(e) => setOfferUrl(e.target.value)}
                  onBlur={commitTerms}
                  placeholder="https://your-store.com/sale"
                  className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <FieldError message={issueFor("offerUrl")} />
              </div>
            </div>
            {expiresAt && (
              <p className="text-[10px] text-muted">
                After this date no codes are handed out, even if some remain.
              </p>
            )}
          </fieldset>

          {/* ---- Add codes --------------------------------------------- */}
          <fieldset className="space-y-2 border-t border-border pt-3">
            <legend className="text-xs font-medium text-muted">Add codes</legend>

            <div className="flex flex-wrap items-end gap-2">
              <NumberBox
                id={`${baseId}-count`}
                label="How many"
                value={count}
                onChange={setCount}
                min={1}
                max={5000}
              />
              <NumberBox
                id={`${baseId}-len`}
                label="Length"
                value={length}
                onChange={setLength}
                min={4}
                max={32}
              />
              <div>
                <label htmlFor={`${baseId}-prefix`} className="block text-[10px] text-muted">
                  Prefix
                </label>
                <input
                  id={`${baseId}-prefix`}
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  placeholder="SUMMER-"
                  className="w-24 rounded-lg border border-border bg-card px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void post(
                    {
                      mode: "generate",
                      tierIndex,
                      count: Number(count) || 0,
                      length: Number(length) || 8,
                      ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
                    },
                    "generate",
                  )
                }
                className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition active:scale-[0.98] disabled:opacity-50"
              >
                {busy === "generate" ? "Generating…" : "Generate"}
              </button>
            </div>
            <p className="text-[10px] text-muted">
              Generated codes skip vowels and look-alike characters (0/O, 1/I/L) so they
              survive being read off a phone and typed in.
            </p>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <input
                ref={fileRef}
                id={`${baseId}-file`}
                type="file"
                accept=".csv,.tsv,.txt,.xlsx,.xlsm"
                className="peer sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
              <label
                htmlFor={`${baseId}-file`}
                className="cursor-pointer rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium transition hover:bg-foreground/[0.04] peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
              >
                {busy === "upload" ? "Reading…" : "Upload CSV / Excel"}
              </label>
              <span className="text-[10px] text-muted">
                .csv or .xlsx — we look for a &ldquo;Code&rdquo; column, else the first one.
              </span>
            </div>

            <details className="pt-1">
              <summary className="cursor-pointer text-[10px] text-muted">
                or paste a list
              </summary>
              <textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={3}
                placeholder={"SAVE10\nSAVE20\nSAVE30"}
                className="mt-1 w-full rounded-lg border border-border bg-card px-2 py-1.5 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <button
                type="button"
                disabled={busy !== null || pasted.trim().length === 0}
                onClick={() =>
                  void post(
                    {
                      mode: "list",
                      tierIndex,
                      // Split on any separator a human might paste; the server
                      // normalises and de-duplicates.
                      codes: pasted.split(/[\s,;]+/).filter(Boolean),
                    },
                    "paste",
                  )
                }
                className="mt-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium transition hover:bg-foreground/[0.04] disabled:opacity-50"
              >
                {busy === "paste" ? "Adding…" : "Add pasted codes"}
              </button>
            </details>
          </fieldset>

          {error && <p className="text-xs text-destructive">{error}</p>}
          {summary && <Summary summary={summary} />}

          {total > remaining && (
            <p className="text-[10px] text-muted">
              {total - remaining} code{total - remaining === 1 ? "" : "s"} already given to
              players — those are kept permanently as a record.
            </p>
          )}

          {remaining > 0 && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void clearUnclaimed()}
              className="text-xs text-destructive/80 transition hover:text-destructive disabled:opacity-50"
            >
              {busy === "clear" ? "Removing…" : `Remove ${remaining} unclaimed`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StockBadge({ remaining, total }: { remaining: number; total: number }) {
  if (total === 0) {
    return (
      <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] text-muted">
        No codes
      </span>
    );
  }
  const empty = remaining === 0;
  const low = remaining <= LOW_STOCK_THRESHOLD;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
        empty
          ? "bg-destructive/10 text-destructive"
          : low
            ? "bg-warning/15 text-foreground"
            : "bg-success/10 text-success"
      }`}
    >
      {remaining}/{total} left
    </span>
  );
}

function FieldError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="mt-0.5 text-[10px] text-destructive">{message}</p>;
}

function NumberBox({
  id,
  label,
  value,
  onChange,
  min,
  max,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-[10px] text-muted">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-20 rounded-lg border border-border bg-card px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}

/**
 * The import receipt. Echoing which COLUMN was read is the important part:
 * picking the wrong column out of a wide merchant export is the way a
 * spreadsheet import goes wrong without anyone noticing.
 */
function Summary({ summary }: { summary: UploadSummary }) {
  const parts: string[] = [];
  if (summary.source) {
    parts.push(
      summary.source.columnHeader
        ? `Read the “${summary.source.columnHeader}” column`
        : "Read the first column",
    );
    parts.push(`${summary.source.rowsScanned} rows scanned`);
  }
  if (summary.skipped) {
    const { blank, duplicatesInFile, invalidCount } = summary.skipped;
    if (blank) parts.push(`${blank} blank skipped`);
    if (duplicatesInFile) parts.push(`${duplicatesInFile} repeated in file`);
    if (invalidCount) parts.push(`${invalidCount} not a valid code`);
  }
  if (summary.duplicates.length) {
    parts.push(`${summary.duplicates.length} already in this game`);
  }
  if (summary.requested !== undefined && summary.inserted < summary.requested) {
    parts.push(
      `asked for ${summary.requested} — try a longer code length for more unique codes`,
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-2 text-[10px] text-muted">
      <p className="font-medium text-foreground">
        Added {summary.inserted} code{summary.inserted === 1 ? "" : "s"}.
      </p>
      {parts.length > 0 && <p className="mt-0.5">{parts.join(" · ")}</p>}
    </div>
  );
}
