// lib/rateLimit.ts
//
// Per-IP and per-domain in-memory rate limiter (build spec §17: "Scrape
// abuse: per-IP and per-domain rate limits; respect robots.txt"). A token
// bucket refilled continuously, so "window" below means "time to fully
// refill from empty", not a fixed clock tick.
//
// In-memory is fine for a single-instance dev/demo deployment (matches
// safeFetch.ts's cache, which makes the same tradeoff). A multi-instance
// production deployment on Vercel would need this backed by something
// shared (Redis, or a Supabase table with an atomic increment) instead —
// noted here rather than silently pretending this scales past one instance.

export interface RateLimitConfig {
  /** Max requests allowed once the bucket is full. */
  limit: number;
  /** Time in ms to go from empty back to full. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

// One generation kicked off per IP per minute is already a fast demo pace;
// per-domain is looser since one popular demo URL shouldn't starve itself
// across multiple testers.
const DEFAULT_IP_CONFIG: RateLimitConfig = { limit: 10, windowMs: 60_000 };
const DEFAULT_DOMAIN_CONFIG: RateLimitConfig = { limit: 20, windowMs: 60_000 };

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();

function check(key: string, config: RateLimitConfig): RateLimitResult {
  const now = Date.now();
  const refillRatePerMs = config.limit / config.windowMs;

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: config.limit, lastRefillMs: now };
    buckets.set(key, bucket);
  } else {
    const elapsedMs = Math.max(0, now - bucket.lastRefillMs);
    bucket.tokens = Math.min(config.limit, bucket.tokens + elapsedMs * refillRatePerMs);
    bucket.lastRefillMs = now;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
  }

  const deficitMs = Math.ceil((1 - bucket.tokens) / refillRatePerMs);
  return { allowed: false, remaining: 0, retryAfterMs: deficitMs };
}

/**
 * Call before starting a generation job or fetching a given target. Checks
 * (and, if allowed, consumes from) both the caller's IP bucket and the
 * target domain's bucket — either being exhausted blocks the request. The
 * more restrictive result is returned so callers can build a Retry-After.
 */
export function checkRateLimit(params: {
  ip: string;
  domain?: string;
  ipConfig?: RateLimitConfig;
  domainConfig?: RateLimitConfig;
}): RateLimitResult {
  const ipResult = check(`ip:${params.ip}`, params.ipConfig ?? DEFAULT_IP_CONFIG);
  if (!ipResult.allowed) return ipResult;

  if (params.domain) {
    const domainResult = check(`domain:${params.domain}`, params.domainConfig ?? DEFAULT_DOMAIN_CONFIG);
    if (!domainResult.allowed) return domainResult;
    return {
      allowed: true,
      remaining: Math.min(ipResult.remaining, domainResult.remaining),
      retryAfterMs: 0,
    };
  }

  return ipResult;
}

/** Public analytics event ingest — generous per-IP bucket for embed traffic. */
const ANALYTICS_IP_CONFIG: RateLimitConfig = { limit: 120, windowMs: 60_000 };

export function checkAnalyticsEventRateLimit(ip: string): RateLimitResult {
  return check(`analytics:ip:${ip}`, ANALYTICS_IP_CONFIG);
}

/** Test/dev helper. */
export function resetRateLimits(): void {
  buckets.clear();
}
