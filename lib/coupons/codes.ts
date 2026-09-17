// lib/coupons/codes.ts
//
// Generating coupon codes from the UI, and normalising codes that arrive from
// a file. Pure functions, no I/O — the DB write lives in lib/db/queries.ts and
// the file decoding in lib/coupons/parse.ts.

/**
 * Deliberately excludes 0/O/1/I/L and every vowel.
 *
 * No vowels because a random 8-character string over the full alphabet
 * reliably produces real words, and a merchant's customers should not be
 * handed an obscenity as a discount code. No 0/O/1/I/L because these codes
 * get read off a phone screen and typed into a checkout box by hand, and
 * those five are the pairs people get wrong.
 */
const CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";

export const CODE_MIN_LENGTH = 4;
export const CODE_MAX_LENGTH = 32;
export const MAX_GENERATE_COUNT = 5_000;
/** One upload / one generate call may not add more than this. */
export const MAX_CODES_PER_REQUEST = 5_000;

export interface GenerateOptions {
  /** How many codes to produce. */
  count: number;
  /** Length of the RANDOM portion, excluding any prefix. */
  length?: number;
  /** Optional fixed prefix, e.g. "SUMMER-". Normalised like any other code. */
  prefix?: string;
}

export interface GenerateResult {
  codes: string[];
  /**
   * How many draws collided with an already-generated code and were retried.
   * Surfaced so a caller asking for more codes than the alphabet can support
   * at a given length gets a signal rather than a silently short list.
   */
  collisions: number;
}

/**
 * Cryptographically-random codes, de-duplicated within the batch.
 *
 * Math.random is not used: these are bearer tokens for money off. A
 * predictable PRNG lets someone who has seen a few codes derive the rest of
 * the batch, and the whole pool is worth exactly as much as it is
 * unguessable.
 */
export function generateCodes(options: GenerateOptions): GenerateResult {
  const count = Math.trunc(options.count);
  if (!Number.isFinite(count) || count < 1) {
    throw new Error("count must be a positive integer");
  }
  if (count > MAX_GENERATE_COUNT) {
    throw new Error(`count must not exceed ${MAX_GENERATE_COUNT}`);
  }

  const length = Math.trunc(options.length ?? 8);
  if (length < CODE_MIN_LENGTH || length > CODE_MAX_LENGTH) {
    throw new Error(`length must be between ${CODE_MIN_LENGTH} and ${CODE_MAX_LENGTH}`);
  }

  const prefix = normalizeCode(options.prefix ?? "");
  if (prefix.length + length > CODE_MAX_LENGTH) {
    throw new Error(`prefix plus length must not exceed ${CODE_MAX_LENGTH} characters`);
  }

  const seen = new Set<string>();
  const codes: string[] = [];
  let collisions = 0;
  // Bounded so an over-subscribed keyspace (e.g. 5000 codes of length 4)
  // terminates with a short list instead of spinning forever.
  const maxAttempts = count * 20 + 1000;
  let attempts = 0;

  while (codes.length < count && attempts < maxAttempts) {
    attempts++;
    const candidate = prefix + randomString(length);
    if (seen.has(candidate)) {
      collisions++;
      continue;
    }
    seen.add(candidate);
    codes.push(candidate);
  }

  return { codes, collisions };
}

function randomString(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    // Modulo bias here is negligible (256 % 28 over a 28-char alphabet) and
    // irrelevant to the threat model: these are high-entropy one-time codes
    // checked against a database, not key material.
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  const webcrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (webcrypto?.getRandomValues) {
    webcrypto.getRandomValues(buf);
    return buf;
  }
  throw new Error("No cryptographic RNG available to generate coupon codes.");
}

/**
 * Canonical form of a code: trimmed, uppercased, inner whitespace removed.
 *
 * Uppercasing matters beyond tidiness — the DB uniqueness index is
 * case-sensitive, so without this "save20" and "SAVE20" would both insert and
 * the merchant would have two rows for one real coupon. Matches the existing
 * treatment of the legacy static RewardTier.code in specRules.ts.
 */
export function normalizeCode(raw: string): string {
  return raw.replace(/\s+/g, "").trim().toUpperCase();
}

export interface NormalizeBatchResult {
  /** Valid, unique, canonical codes, in first-seen order. */
  codes: string[];
  /** Count of entries dropped for being blank. */
  blank: number;
  /** Count of entries dropped as duplicates WITHIN this batch. */
  duplicates: number;
  /** Entries dropped for being too long or containing illegal characters. */
  invalid: string[];
}

/**
 * Cleans a raw list (from a file or a textarea) into something insertable.
 *
 * Reports what it dropped rather than throwing: a 2000-row spreadsheet with
 * three bad rows should import 1997 codes and tell the merchant about the
 * three, not refuse the whole file.
 */
export function normalizeCodeBatch(raw: string[]): NormalizeBatchResult {
  const seen = new Set<string>();
  const codes: string[] = [];
  const invalid: string[] = [];
  let blank = 0;
  let duplicates = 0;

  for (const entry of raw) {
    const code = normalizeCode(entry ?? "");
    if (code.length === 0) {
      blank++;
      continue;
    }
    if (code.length > CODE_MAX_LENGTH) {
      invalid.push(entry);
      continue;
    }
    // Permissive on purpose: real merchant codes contain hyphens, underscores
    // and dots. Anything outside this set is far more likely to be a stray
    // spreadsheet cell (a header, a price, a note) than a coupon.
    if (!/^[A-Z0-9._-]+$/.test(code)) {
      invalid.push(entry);
      continue;
    }
    if (seen.has(code)) {
      duplicates++;
      continue;
    }
    seen.add(code);
    codes.push(code);
  }

  return { codes, blank, duplicates, invalid };
}
