// lib/engine/safeFetch.ts
//
// SSRF-safe fetch used by every extractor and by sprites.ts for image
// downloads. Build spec §7 (fetch rules) and §17 (security — SSRF).
//
// - Resolves the hostname and rejects private/loopback/link-local/multicast
//   ranges, re-checking after every redirect hop (redirects are followed
//   manually, never handed to the platform fetch implementation).
// - Honours robots.txt (hand-parsed, no dependency), identifies the bot
//   honestly via User-Agent.
// - Hard timeout via AbortController (FETCH_TIMEOUT_MS / IMAGE_TIMEOUT_MS).
// - Simple in-memory per-URL cache, 24h TTL — dev-only, not persisted, which
//   is fine: it exists to make repeat demos of the same site instant, not to
//   survive a restart.
//
// This module runs sharp-adjacent code paths (called from sprites.ts) —
// the calling route MUST declare `export const runtime = "nodejs"` (dns
// lookups and the raw socket-level IP checks below do not exist on Edge).

import dns from "node:dns/promises";
import net from "node:net";
import { Agent } from "undici";

const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 10000;
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS) || 5000;
const USER_AGENT = "PlayLoopBot/0.1 (+https://playloop.app/bot)";
const MAX_REDIRECTS = 3;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Node's built-in fetch (undici) rejects any response whose headers exceed
// its default ~16KB budget with UND_ERR_HEADERS_OVERFLOW — a real-world
// site with a large CSP or a pile of analytics Set-Cookie headers hits this
// easily (confirmed live against mvmt.com, which curl fetches fine but the
// default dispatcher can't). A dedicated Agent with a generous header
// budget avoids rejecting an otherwise-healthy response over header size
// alone; every other safety property (SSRF host checks, robots, timeout)
// still applies identically since only the dispatcher changes.
const fetchAgent = new Agent({ maxHeaderSize: 1_048_576 });

// `dispatcher` is a real, honored fetch option (it's how you configure
// undici's per-request Agent) but isn't part of lib.dom.d.ts's RequestInit
// type — extending it here means passing a *variable* of this type to
// fetch(), not an inline object literal, so TS's excess-property check
// (which only fires on fresh literals) never gets a chance to reject it.
interface FetchInit extends RequestInit {
  dispatcher?: Agent;
}

export type SafeFetchErrorCode =
  | "INVALID_URL"
  | "SSRF_BLOCKED"
  | "DNS_ERROR"
  | "ROBOTS_BLOCKED"
  | "TIMEOUT"
  | "FETCH_ERROR"
  | "TOO_MANY_REDIRECTS";

export class SafeFetchError extends Error {
  code: SafeFetchErrorCode;
  constructor(message: string, code: SafeFetchErrorCode) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
  }
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  /** URL after following redirects — record this, per build spec §7. */
  finalUrl: string;
  headers: Headers;
  buffer: Buffer;
  contentType: string | null;
  text: () => string;
  json: <T = unknown>() => T;
  fromCache: boolean;
}

export interface SafeFetchOptions {
  /** Defaults to IMAGE_TIMEOUT_MS if isImage, else FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Use the image timeout budget instead of the document one. */
  isImage?: boolean;
  /** Default true — set false only for trusted, already-vetted internal calls. */
  respectRobots?: boolean;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// IP range checks
// ---------------------------------------------------------------------------

function isBlockedIpv4(ip: string): boolean {
  const octets = ip.split(".").map((n) => Number(n));
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) return true;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  if (a === 192 && b === 0) return true; // IETF protocol assignments (192.0.0.0/24, includes 192.0.0.0/29 etc.)
  if (a >= 224) return true; // multicast (224-239) + reserved (240-255)
  return false;
}

function isBlockedIpv6(rawIp: string): boolean {
  const ip = rawIp.toLowerCase();
  if (ip === "::1") return true; // loopback
  if (ip === "::") return true; // unspecified
  if (ip.startsWith("fe80:") || ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) {
    return true; // link-local fe80::/10
  }
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // unique local fc00::/7
  if (ip.startsWith("ff")) return true; // multicast
  // IPv4-mapped / IPv4-translated addresses embed an IPv4 — check that too.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1] ?? "");
  return false;
}

function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (net.isIPv6(ip)) return isBlockedIpv6(ip);
  return true; // unrecognised format — fail closed
}

async function resolveAndCheck(rawHostname: string): Promise<void> {
  // URL.hostname keeps the brackets for a literal IPv6 host (e.g. "[::1]"
  // from "http://[::1]/") — net.isIP()/dns.lookup() both need the bare
  // address, so strip them before anything else.
  const hostname =
    rawHostname.startsWith("[") && rawHostname.endsWith("]") ? rawHostname.slice(1, -1) : rawHostname;

  const lowerHost = hostname.toLowerCase();
  if (lowerHost === "localhost" || lowerHost.endsWith(".localhost")) {
    throw new SafeFetchError(`Blocked hostname: ${rawHostname}`, "SSRF_BLOCKED");
  }
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new SafeFetchError(`Blocked IP literal: ${hostname}`, "SSRF_BLOCKED");
    }
    return;
  }
  let records: { address: string }[];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new SafeFetchError(`DNS resolution failed for ${hostname}`, "DNS_ERROR");
  }
  if (records.length === 0) {
    throw new SafeFetchError(`No DNS records for ${hostname}`, "DNS_ERROR");
  }
  for (const { address } of records) {
    if (isBlockedIp(address)) {
      throw new SafeFetchError(
        `Host ${hostname} resolves to a blocked address (${address})`,
        "SSRF_BLOCKED",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// robots.txt — hand-parsed, cached per-origin for 24h alongside the fetch cache
// ---------------------------------------------------------------------------

interface RobotsGroup {
  agents: string[];
  disallow: string[];
  allow: string[];
}

/** Groups records by consecutive User-agent lines, per the de facto robots.txt
 * grouping convention (no npm dependency — hand-rolled per build spec §7/§17). */
export function parseRobotsGroups(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastFieldWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastFieldWasAgent) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastFieldWasAgent = true;
    } else if (field === "disallow" || field === "allow") {
      if (!current) {
        current = { agents: ["*"], disallow: [], allow: [] };
        groups.push(current);
      }
      if (value) {
        if (field === "disallow") current.disallow.push(value);
        else current.allow.push(value);
      }
      lastFieldWasAgent = false;
    } else {
      lastFieldWasAgent = false;
    }
  }
  return groups;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** robots.txt patterns support `*` wildcards and a trailing `$` end-anchor. */
function robotsRuleMatches(path: string, rule: string): boolean {
  if (!rule) return false;
  const endAnchor = rule.endsWith("$");
  const body = endAnchor ? rule.slice(0, -1) : rule;
  const pattern = "^" + body.split("*").map(escapeRegExp).join(".*") + (endAnchor ? "$" : "");
  try {
    return new RegExp(pattern).test(path);
  } catch {
    return path.startsWith(body);
  }
}

// ---------------------------------------------------------------------------
// Origin failure cache — short-lived "this origin just hard-failed" memory,
// shared by the robots.txt lookup below and the main fetch loop further
// down. Distinct from responseCache/robotsCache's 24h TTL: this exists
// purely to avoid paying a full FETCH_TIMEOUT_MS timeout more than once per
// origin within a single generation run, not to remember anything
// long-term (a site that's down for a minute shouldn't be memorized as
// broken for a day). Confirmed live against uniqlo.com, whose edge WAF
// silently drops any request carrying our bot User-Agent rather than
// returning a real HTTP response: a single extractFromUrl() call paid the
// full ~10s timeout *four separate times* discovering the same fact —
// robots.txt, the root page, the Shopify products.json probe, and the
// sitemap.xml probe — each independently unaware the others had already
// found the origin unreachable. This cache means only the first of those
// pays the timeout; the rest fail immediately. A clean non-2xx/3xx HTTP
// response is never recorded here — only a genuine failure to get a
// response at all (timeout, connection error, DNS failure) counts, since
// that (not "robots.txt happens not to exist") is the actual signal that
// every other path on this origin is likely to fail the same way.
const ORIGIN_FAILURE_TTL_MS = 5 * 60 * 1000;
const originFailureCache = new Map<string, number>(); // origin -> expiresAt

function isOriginRecentlyFailed(origin: string): boolean {
  const expiresAt = originFailureCache.get(origin);
  return expiresAt !== undefined && expiresAt > Date.now();
}

function recordOriginFailure(origin: string): void {
  originFailureCache.set(origin, Date.now() + ORIGIN_FAILURE_TTL_MS);
}

interface RobotsCacheEntry {
  expiresAt: number;
  disallow: string[];
  allow: string[];
}
const robotsCache = new Map<string, RobotsCacheEntry>();

async function fetchRobotsRules(origin: string): Promise<{ disallow: string[]; allow: string[] }> {
  const cached = robotsCache.get(origin);
  if (cached && cached.expiresAt > Date.now()) {
    return { disallow: cached.disallow, allow: cached.allow };
  }
  let disallow: string[] = [];
  let allow: string[] = [];
  if (!isOriginRecentlyFailed(origin)) {
    try {
      const robotsUrl = `${origin}/robots.txt`;
      const host = new URL(robotsUrl).hostname;
      await resolveAndCheck(host);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const init: FetchInit = {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
        dispatcher: fetchAgent,
      };
      const res = await fetch(robotsUrl, init);
      clearTimeout(timer);
      if (res.ok) {
        const text = await res.text();
        const groups = parseRobotsGroups(text);
        const wildcard = groups.find((g) => g.agents.includes("*"));
        if (wildcard) {
          disallow = wildcard.disallow;
          allow = wildcard.allow;
        }
      }
    } catch {
      // No robots.txt, unreachable, or blocked target — fail open (allow),
      // and remember it so the page fetch right after this one (and any
      // sibling ladder step's fetch to the same origin) doesn't pay its
      // own full timeout rediscovering the same thing.
      disallow = [];
      allow = [];
      recordOriginFailure(origin);
    }
  }
  // Cached regardless of outcome (including the recently-failed skip
  // above) — a blocked/unreachable origin's robots.txt result is "allow
  // everything" either way, and this cache is what stops it from being
  // re-attempted on every subsequent call within CACHE_TTL_MS.
  robotsCache.set(origin, { expiresAt: Date.now() + CACHE_TTL_MS, disallow, allow });
  return { disallow, allow };
}

async function isAllowedByRobots(target: URL): Promise<boolean> {
  const { disallow, allow } = await fetchRobotsRules(target.origin);
  const path = target.pathname + target.search;
  const matchedDisallow = disallow
    .filter((rule) => robotsRuleMatches(path, rule))
    .sort((a, b) => b.length - a.length)[0];
  if (!matchedDisallow) return true;
  const matchedAllow = allow
    .filter((rule) => robotsRuleMatches(path, rule))
    .sort((a, b) => b.length - a.length)[0];
  // Longest matching rule wins, per the standard robots.txt precedence rule.
  return Boolean(matchedAllow && matchedAllow.length >= matchedDisallow.length);
}

// ---------------------------------------------------------------------------
// Cache + core fetch
// ---------------------------------------------------------------------------

interface CacheEntry {
  expiresAt: number;
  result: Omit<SafeFetchResult, "fromCache">;
}
const responseCache = new Map<string, CacheEntry>();

/** SSRF host check alone, with no fetch attached — for callers (like
 * extract/render.ts's headless-browser step) that don't go through
 * safeFetch()'s own request path but still load attacker-influenced URLs
 * and need the same private/loopback/link-local IP rejection applied. */
export async function assertSafeUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SafeFetchError(`Blocked protocol: ${parsed.protocol}`, "SSRF_BLOCKED");
  }
  await resolveAndCheck(parsed.hostname);
}

/** robots.txt check alone, for the same class of caller as assertSafeUrl
 * above — reuses the same 24h-cached parse safeFetch() itself relies on. */
export async function isUrlAllowedByRobots(url: string): Promise<boolean> {
  return isAllowedByRobots(new URL(url));
}

export function clearSafeFetchCache(): void {
  responseCache.clear();
  robotsCache.clear();
  originFailureCache.clear();
}

export async function safeFetch(
  inputUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? (options.isImage ? IMAGE_TIMEOUT_MS : FETCH_TIMEOUT_MS);
  const respectRobots = options.respectRobots ?? true;

  const cached = responseCache.get(inputUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, fromCache: true };
  }

  let currentUrl = inputUrl;
  let redirects = 0;
  const headers = { "User-Agent": USER_AGENT, ...options.headers };

  for (;;) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new SafeFetchError(`Invalid URL: ${currentUrl}`, "INVALID_URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new SafeFetchError(`Blocked protocol: ${parsed.protocol}`, "SSRF_BLOCKED");
    }

    // Skip straight to failing — no DNS lookup, no robots check, no
    // timeout to wait out — if this exact origin already hard-failed
    // (timeout/connection error) somewhere else in this same run. See
    // originFailureCache's doc comment above fetchRobotsRules.
    if (isOriginRecentlyFailed(parsed.origin)) {
      throw new SafeFetchError(`${parsed.origin} failed to respond earlier in this run`, "TIMEOUT");
    }

    // Re-checked on every hop, including the initial URL and every redirect.
    await resolveAndCheck(parsed.hostname);

    if (respectRobots) {
      const allowed = await isAllowedByRobots(parsed);
      if (!allowed) {
        throw new SafeFetchError(`Blocked by robots.txt: ${parsed.pathname}`, "ROBOTS_BLOCKED");
      }
      // The robots.txt lookup just above is itself the *first* fetch to
      // this origin — if it hard-failed, it already recorded that via
      // recordOriginFailure() and fell back to "allow" rather than
      // throwing (see fetchRobotsRules). Check again here rather than
      // only at the top of this iteration, so the actual page fetch below
      // doesn't independently pay its own full timeout re-discovering
      // what the robots.txt attempt (which always runs first) just did —
      // this is what collapsed the *very first* safeFetch call to a dead
      // origin from ~20s (robots.txt timeout + page timeout, sequential)
      // to ~10s (just the robots.txt timeout) when verified live.
      if (isOriginRecentlyFailed(parsed.origin)) {
        throw new SafeFetchError(`${parsed.origin} failed to respond to the robots.txt lookup`, "TIMEOUT");
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      const init: FetchInit = { redirect: "manual", signal: controller.signal, headers, dispatcher: fetchAgent };
      res = await fetch(currentUrl, init);
    } catch (err) {
      clearTimeout(timer);
      recordOriginFailure(parsed.origin);
      if (err instanceof Error && err.name === "AbortError") {
        throw new SafeFetchError(`Timed out fetching ${currentUrl}`, "TIMEOUT");
      }
      throw new SafeFetchError(
        `Fetch failed for ${currentUrl}: ${err instanceof Error ? err.message : String(err)}`,
        "FETCH_ERROR",
      );
    }
    clearTimeout(timer);

    const isRedirect = res.status >= 300 && res.status < 400;
    const location = res.headers.get("location");
    if (isRedirect && location) {
      redirects += 1;
      if (redirects > MAX_REDIRECTS) {
        throw new SafeFetchError(`Too many redirects starting from ${inputUrl}`, "TOO_MANY_REDIRECTS");
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue; // loop back — re-validates SSRF + robots for the new hop
    }

    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const finalUrl = currentUrl;
    const base: Omit<SafeFetchResult, "fromCache"> = {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      finalUrl,
      headers: res.headers,
      contentType: res.headers.get("content-type"),
      buffer,
      text: () => buffer.toString("utf-8"),
      json: <T,>() => JSON.parse(buffer.toString("utf-8")) as T,
    };
    // Only cache successful responses — caching a transient failure (a 500,
    // a momentary blip) for 24h would make a real outage look permanent for
    // the rest of the cache window. Repeat-demo speed only matters for the
    // happy path anyway.
    if (base.ok) {
      responseCache.set(inputUrl, { expiresAt: Date.now() + CACHE_TTL_MS, result: base });
    }
    return { ...base, fromCache: false };
  }
}

/** Convenience wrapper for image downloads — uses IMAGE_TIMEOUT_MS. */
export async function safeFetchImage(url: string): Promise<SafeFetchResult> {
  return safeFetch(url, { isImage: true });
}
