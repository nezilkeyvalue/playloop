// lib/email/send.ts
//
// Transactional email, via the Resend marketplace integration
// (`vercel integration add resend/resend-email`). RESEND_API_KEY and
// RESEND_EMAIL_DOMAIN are injected by that integration — neither is in
// .env.example, because a developer without the integration should get the
// no-op path below rather than a broken build.
//
// Optional by construction, exactly like Supabase and Gemini elsewhere in
// this codebase: with RESEND_API_KEY unset, isEmailEnabled() is false and
// every caller degrades to "we saved your address" rather than erroring. The
// zero-external-accounts local run in CLAUDE.md keeps working.

import type { CouponTerms } from "@/lib/engine/types";

export function isEmailEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_EMAIL_DOMAIN);
}

/**
 * The From address. `rewards@<domain>` rather than `noreply@`: a player
 * replying to a coupon email is a customer trying to reach the merchant, and
 * bouncing that is a poor outcome for a marketing tool.
 */
function fromAddress(brandName?: string): string {
  const domain = process.env.RESEND_EMAIL_DOMAIN;
  const name = (brandName ?? "PlayLoop").replace(/["<>\r\n]/g, "").trim() || "PlayLoop";
  return `${name} <rewards@${domain}>`;
}

export type SendResult =
  | { ok: true; id: string | null }
  | { ok: false; reason: "disabled" | "unverified_domain" | "failed"; message?: string };

export interface CouponEmailInput {
  to: string;
  code: string;
  /** Tier label, e.g. "20% off your order". */
  rewardLabel: string;
  brandName?: string;
  terms?: CouponTerms;
  /** Where to play again / see the offer. */
  siteUrl?: string;
}

/**
 * Sends one coupon code.
 *
 * Never throws: a failure here must not fail the lead capture that triggered
 * it. The player already has the code on screen — email is the convenience
 * copy, not the delivery mechanism, and treating a mail outage as a fatal
 * error would lose the lead as well.
 */
export async function sendCouponEmail(input: CouponEmailInput): Promise<SendResult> {
  if (!isEmailEnabled()) return { ok: false, reason: "disabled" };

  try {
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);

    const { data, error } = await resend.emails.send({
      from: fromAddress(input.brandName),
      to: [input.to],
      subject: `${input.rewardLabel} — here's your code`,
      text: buildText(input),
      html: buildHtml(input),
    });

    if (error) {
      // Resend reports an unverified sending domain as a 403. Distinguished
      // because it is a setup step the operator must complete (DNS), not a
      // transient failure worth retrying.
      const message = error.message ?? String(error);
      const unverified = /domain is not verified|not verified/i.test(message);
      return {
        ok: false,
        reason: unverified ? "unverified_domain" : "failed",
        message,
      };
    }
    return { ok: true, id: data?.id ?? null };
  } catch (err) {
    return {
      ok: false,
      reason: "failed",
      message: err instanceof Error ? err.message : "send_failed",
    };
  }
}

/** Escapes text for interpolation into the HTML body. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildText(input: CouponEmailInput): string {
  const lines = [
    `You won ${input.rewardLabel}.`,
    "",
    `Your code: ${input.code}`,
    "",
  ];
  if (input.terms?.expiresAt) lines.push(`Valid until ${input.terms.expiresAt}.`);
  if (input.terms?.offerUrl) lines.push(`Shop the offer: ${input.terms.offerUrl}`);
  if (input.terms?.terms) lines.push("", input.terms.terms);
  return lines.join("\n");
}

function buildHtml(input: CouponEmailInput): string {
  // Deliberately plain, inline-styled HTML with a table-free layout. Email
  // clients are not browsers; anything clever here degrades unpredictably,
  // and the only thing that must survive is the code itself.
  const parts = [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">`,
    `<p style="font-size:16px;margin:0 0 4px">You won <strong>${esc(input.rewardLabel)}</strong>.</p>`,
    `<p style="margin:0 0 16px;color:#555;font-size:14px">Here's your code:</p>`,
    `<p style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:24px;font-weight:700;letter-spacing:.08em;background:#f4f4f5;border-radius:10px;padding:16px;text-align:center;margin:0 0 16px">${esc(input.code)}</p>`,
  ];
  if (input.terms?.offerUrl) {
    parts.push(
      `<p style="margin:0 0 12px"><a href="${esc(input.terms.offerUrl)}" style="color:#5B4AFF;font-weight:600">Shop the offer</a></p>`,
    );
  }
  if (input.terms?.expiresAt) {
    parts.push(
      `<p style="margin:0 0 8px;font-size:12px;color:#666">Valid until ${esc(input.terms.expiresAt)}.</p>`,
    );
  }
  if (input.terms?.terms) {
    parts.push(
      `<p style="margin:0;font-size:12px;color:#888;line-height:1.5">${esc(input.terms.terms)}</p>`,
    );
  }
  parts.push(`</div>`);
  return parts.join("");
}
