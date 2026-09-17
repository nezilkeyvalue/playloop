// lib/db/queries.ts
//
// Typed query helpers. Maps 1:1 onto the tables in lib/db/schema.sql when
// Supabase is configured, and onto a JSON-file dev store under ./dev-data/
// otherwise (see lib/db/client.ts#isDevMode). Every exported function below
// behaves identically either way — that equivalence is the point of this
// file, so callers (API routes) never branch on dev mode themselves.
//
// MVP auth stub (build spec §19: "magic link or a stub is fine"): real auth
// is out of scope. Every route in this build passes accountId: null, which
// this file treats as a single implicit dev account. `accounts` rows are
// never created or read here for that reason — nothing in the MVP needs
// one. Swap this for real per-account scoping when auth lands; every
// function already threads accountId through so that change is local to
// this file.

import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { nanoid } from "nanoid";

import { getSupabaseServerClient, isDevMode } from "./client";
import { isCouponExpired, originalTierIndexFromSortedIndex } from "@/lib/engine/specRules";
import { generateSlug } from "@/lib/slug";
import { resolveMaxRealisticScoreForSpec } from "@/lib/engine/scoreCeiling";
import type {
  AnalyticsEvent,
  CouponRecord,
  CouponTierStats,
  GameRecord,
  GameSpec,
  GameStatus,
  Job,
  JobStage,
  LeadRecord,
  Placement,
  PlayRecord,
  RewardTier,
} from "@/lib/engine/types";
import type {
  AccountAnalytics,
  AnalyticsDateRange,
  GameAnalytics,
  GameAnalyticsEventRecord,
} from "@/lib/analytics/types";
import { inAnalyticsRange } from "@/lib/analytics/types";
import { buildAccountAnalytics, buildGameAnalytics } from "@/lib/analytics/aggregate";

// ---------------------------------------------------------------------------
// Dev-mode storage: a tiny JSON-file-per-table store under ./dev-data/.
// ---------------------------------------------------------------------------

const DEV_DATA_DIR = path.join(process.cwd(), "dev-data");

async function ensureDevDataDir(): Promise<void> {
  await fs.mkdir(DEV_DATA_DIR, { recursive: true });
}

async function readDevTable<T>(file: string): Promise<T[]> {
  await ensureDevDataDir();
  try {
    const raw = await fs.readFile(path.join(DEV_DATA_DIR, file), "utf8");
    return JSON.parse(raw) as T[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeDevTable<T>(file: string, rows: T[]): Promise<void> {
  await ensureDevDataDir();
  const target = path.join(DEV_DATA_DIR, file);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), "utf8");
  await fs.rename(tmp, target);
}

/**
 * Every dev-mode table gets one of these so concurrent requests in the same
 * process don't lose updates to a read-modify-write cycle (there is no
 * transaction to lean on — this is a JSON file). This does NOT protect
 * against multiple processes/instances sharing ./dev-data/ concurrently;
 * that's an accepted dev-only limitation, documented in the final report.
 */
function createMutex() {
  let chain: Promise<unknown> = Promise.resolve();
  function run<T>(fn: () => Promise<T>): Promise<T> {
    const result = chain.then(fn, fn);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  return { run };
}

const couponsMutex = createMutex();
const gamesMutex = createMutex();
const jobsMutex = createMutex();
const playsMutex = createMutex();
const leadsMutex = createMutex();
const analyticsEventsMutex = createMutex();

const GAMES_FILE = "games.json";
const JOBS_FILE = "jobs.json";
const PLAYS_FILE = "plays.json";
const LEADS_FILE = "leads.json";
const COUPONS_FILE = "coupons.json";
const ANALYTICS_EVENTS_FILE = "game_analytics_events.json";

// ---------------------------------------------------------------------------
// Supabase row <-> camelCase mapping (schema.sql columns are snake_case).
// ---------------------------------------------------------------------------

interface GameRow {
  id: string;
  account_id: string | null;
  slug: string | null;
  name: string;
  spec: GameSpec;
  placement: Placement;
  status: GameStatus;
  allowed_hosts: string[] | null;
  created_at: string;
  updated_at: string;
}

function gameRowToRecord(row: GameRow): GameRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    slug: row.slug,
    name: row.name,
    spec: row.spec,
    placement: row.placement,
    status: row.status,
    allowedHosts: row.allowed_hosts ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function gameRecordToRow(rec: Partial<GameRecord>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (rec.id !== undefined) row.id = rec.id;
  if (rec.accountId !== undefined) row.account_id = rec.accountId;
  if (rec.slug !== undefined) row.slug = rec.slug;
  if (rec.name !== undefined) row.name = rec.name;
  if (rec.spec !== undefined) row.spec = rec.spec;
  if (rec.placement !== undefined) row.placement = rec.placement;
  if (rec.status !== undefined) row.status = rec.status;
  if (rec.allowedHosts !== undefined) row.allowed_hosts = rec.allowedHosts;
  if (rec.createdAt !== undefined) row.created_at = rec.createdAt;
  if (rec.updatedAt !== undefined) row.updated_at = rec.updatedAt;
  return row;
}

interface JobRow {
  id: string;
  account_id: string | null;
  mode: "auto" | "manual";
  source_url: string | null;
  stage: JobStage;
  percent: number;
  message: string | null;
  inventory: Job["inventory"];
  match: Job["match"];
  spec: GameSpec | null;
  game_id: string | null;
  business_name: string | null;
  business_description: string | null;
  dropped_count: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function jobRowToRecord(row: JobRow): Job {
  return {
    id: row.id,
    accountId: row.account_id,
    mode: row.mode,
    sourceUrl: row.source_url,
    stage: row.stage,
    percent: row.percent,
    message: row.message,
    inventory: row.inventory,
    match: row.match,
    spec: row.spec,
    gameId: row.game_id,
    businessName: row.business_name,
    businessDescription: row.business_description,
    droppedCount: row.dropped_count,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function jobRecordToRow(rec: Partial<Job>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (rec.id !== undefined) row.id = rec.id;
  if (rec.accountId !== undefined) row.account_id = rec.accountId;
  if (rec.mode !== undefined) row.mode = rec.mode;
  if (rec.sourceUrl !== undefined) row.source_url = rec.sourceUrl;
  if (rec.stage !== undefined) row.stage = rec.stage;
  if (rec.percent !== undefined) row.percent = rec.percent;
  if (rec.message !== undefined) row.message = rec.message;
  if (rec.inventory !== undefined) row.inventory = rec.inventory;
  if (rec.match !== undefined) row.match = rec.match;
  if (rec.spec !== undefined) row.spec = rec.spec;
  if (rec.gameId !== undefined) row.game_id = rec.gameId;
  if (rec.businessName !== undefined) row.business_name = rec.businessName;
  if (rec.businessDescription !== undefined) row.business_description = rec.businessDescription;
  if (rec.droppedCount !== undefined) row.dropped_count = rec.droppedCount;
  if (rec.error !== undefined) row.error = rec.error;
  if (rec.createdAt !== undefined) row.created_at = rec.createdAt;
  if (rec.updatedAt !== undefined) row.updated_at = rec.updatedAt;
  return row;
}

interface PlayRow {
  id: string;
  game_id: string;
  session: string;
  started_at: string;
  finished_at: string | null;
  score: number | null;
  tier_index: number | null;
  replay_of: string | null;
  referrer: string | null;
  device: "mobile" | "desktop" | null;
  country: string | null;
}

function playRowToRecord(row: PlayRow): PlayRecord {
  return {
    id: row.id,
    gameId: row.game_id,
    session: row.session,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    score: row.score,
    tierIndex: row.tier_index,
    replayOf: row.replay_of,
    referrer: row.referrer,
    device: row.device,
    country: row.country,
  };
}

function playRecordToRow(rec: Partial<PlayRecord>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (rec.id !== undefined) row.id = rec.id;
  if (rec.gameId !== undefined) row.game_id = rec.gameId;
  if (rec.session !== undefined) row.session = rec.session;
  if (rec.startedAt !== undefined) row.started_at = rec.startedAt;
  if (rec.finishedAt !== undefined) row.finished_at = rec.finishedAt;
  if (rec.score !== undefined) row.score = rec.score;
  if (rec.tierIndex !== undefined) row.tier_index = rec.tierIndex;
  if (rec.replayOf !== undefined) row.replay_of = rec.replayOf;
  if (rec.referrer !== undefined) row.referrer = rec.referrer;
  if (rec.device !== undefined) row.device = rec.device;
  if (rec.country !== undefined) row.country = rec.country;
  return row;
}

interface LeadRow {
  id: string;
  game_id: string;
  play_id: string | null;
  email: string | null;
  phone: string | null;
  consent: boolean;
  created_at: string;
}

interface AnalyticsEventRow {
  id: string;
  game_id: string;
  play_id: string | null;
  event: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

function analyticsEventRowToRecord(row: AnalyticsEventRow): GameAnalyticsEventRecord {
  return {
    id: row.id,
    gameId: row.game_id,
    playId: row.play_id,
    event: row.event as AnalyticsEvent,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

function leadRowToRecord(row: LeadRow): LeadRecord {
  return {
    id: row.id,
    gameId: row.game_id,
    playId: row.play_id,
    email: row.email,
    phone: row.phone,
    consent: row.consent,
    createdAt: row.created_at,
  };
}

function leadRecordToRow(rec: Partial<LeadRecord>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (rec.id !== undefined) row.id = rec.id;
  if (rec.gameId !== undefined) row.game_id = rec.gameId;
  if (rec.playId !== undefined) row.play_id = rec.playId;
  if (rec.email !== undefined) row.email = rec.email;
  if (rec.phone !== undefined) row.phone = rec.phone;
  if (rec.consent !== undefined) row.consent = rec.consent;
  if (rec.createdAt !== undefined) row.created_at = rec.createdAt;
  return row;
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

export async function getGameBySlug(slug: string): Promise<GameRecord | null> {
  if (isDevMode()) {
    const rows = await readDevTable<GameRecord>(GAMES_FILE);
    const found = rows.find((g) => g.slug === slug && g.status === "published");
    return found ?? null;
  }
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("games")
    .select("*")
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle();
  if (error) throw error;
  return data ? gameRowToRecord(data as GameRow) : null;
}

export async function getGameById(id: string): Promise<GameRecord | null> {
  if (isDevMode()) {
    const rows = await readDevTable<GameRecord>(GAMES_FILE);
    return rows.find((g) => g.id === id) ?? null;
  }
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("games")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? gameRowToRecord(data as GameRow) : null;
}

export async function listGames(accountId: string | null): Promise<GameRecord[]> {
  if (isDevMode()) {
    const rows = await readDevTable<GameRecord>(GAMES_FILE);
    return rows
      .filter((g) => g.accountId === accountId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }
  const supabase = getSupabaseServerClient();
  let query = supabase.from("games").select("*").order("updated_at", { ascending: false });
  query = accountId === null ? query.is("account_id", null) : query.eq("account_id", accountId);
  const { data, error } = await query;
  if (error) throw error;
  return (data as GameRow[]).map(gameRowToRecord);
}

export async function createGame(input: {
  accountId: string | null;
  name: string;
  spec: GameSpec;
  placement: Placement;
}): Promise<GameRecord> {
  const now = new Date().toISOString();
  const record: GameRecord = {
    id: randomUUID(),
    accountId: input.accountId,
    slug: null,
    name: input.name,
    spec: input.spec,
    placement: input.placement,
    status: "draft",
    allowedHosts: [],
    createdAt: now,
    updatedAt: now,
  };

  if (isDevMode()) {
    return gamesMutex.run(async () => {
      const rows = await readDevTable<GameRecord>(GAMES_FILE);
      rows.push(record);
      await writeDevTable(GAMES_FILE, rows);
      return record;
    });
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("games")
    .insert(gameRecordToRow(record))
    .select("*")
    .single();
  if (error) throw error;
  return gameRowToRecord(data as GameRow);
}

export async function updateGameSpec(
  id: string,
  patch: Partial<GameSpec>,
): Promise<GameRecord> {
  if (isDevMode()) {
    return gamesMutex.run(async () => {
      const rows = await readDevTable<GameRecord>(GAMES_FILE);
      const idx = rows.findIndex((g) => g.id === id);
      if (idx === -1) throw new Error("game_not_found");
      const existing = rows[idx]!;
      const updated: GameRecord = {
        ...existing,
        spec: { ...existing.spec, ...patch },
        updatedAt: new Date().toISOString(),
      };
      rows[idx] = updated;
      await writeDevTable(GAMES_FILE, rows);
      return updated;
    });
  }

  const supabase = getSupabaseServerClient();
  const existing = await getGameById(id);
  if (!existing) throw new Error("game_not_found");
  const mergedSpec = { ...existing.spec, ...patch };
  const { data, error } = await supabase
    .from("games")
    .update({ spec: mergedSpec, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return gameRowToRecord(data as GameRow);
}

async function gameSlugExists(slug: string): Promise<boolean> {
  if (isDevMode()) {
    const rows = await readDevTable<GameRecord>(GAMES_FILE);
    return rows.some((g) => g.slug === slug);
  }
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("games")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function publishGame(id: string, placement: Placement): Promise<GameRecord> {
  const existing = await getGameById(id);
  if (!existing) throw new Error("game_not_found");

  let slug = existing.slug;
  if (!slug) {
    let candidate = generateSlug();
    let attempts = 0;
    while (await gameSlugExists(candidate)) {
      candidate = generateSlug();
      attempts += 1;
      if (attempts > 20) throw new Error("slug_generation_failed");
    }
    slug = candidate;
  }
  const now = new Date().toISOString();

  if (isDevMode()) {
    return gamesMutex.run(async () => {
      const rows = await readDevTable<GameRecord>(GAMES_FILE);
      const idx = rows.findIndex((g) => g.id === id);
      if (idx === -1) throw new Error("game_not_found");
      const updated: GameRecord = {
        ...rows[idx]!,
        slug: slug!,
        placement,
        status: "published",
        updatedAt: now,
      };
      rows[idx] = updated;
      await writeDevTable(GAMES_FILE, rows);
      return updated;
    });
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("games")
    .update({ slug, placement, status: "published", updated_at: now })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return gameRowToRecord(data as GameRow);
}

export async function deleteGame(id: string): Promise<void> {
  if (isDevMode()) {
    await gamesMutex.run(async () => {
      const rows = await readDevTable<GameRecord>(GAMES_FILE);
      await writeDevTable(GAMES_FILE, rows.filter((g) => g.id !== id));
    });
    // Mimic the schema's ON DELETE CASCADE for plays/leads in dev mode.
    await playsMutex.run(async () => {
      const rows = await readDevTable<PlayRecord>(PLAYS_FILE);
      await writeDevTable(PLAYS_FILE, rows.filter((p) => p.gameId !== id));
    });
    await leadsMutex.run(async () => {
      const rows = await readDevTable<LeadRecord>(LEADS_FILE);
      await writeDevTable(LEADS_FILE, rows.filter((l) => l.gameId !== id));
    });
    await analyticsEventsMutex.run(async () => {
      const rows = await readDevTable<GameAnalyticsEventRecord>(ANALYTICS_EVENTS_FILE);
      await writeDevTable(
        ANALYTICS_EVENTS_FILE,
        rows.filter((e) => e.gameId !== id),
      );
    });
    return;
  }
  const supabase = getSupabaseServerClient();
  const { error } = await supabase.from("games").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export async function createJob(input: {
  accountId: string | null;
  mode: "auto" | "manual";
  sourceUrl?: string;
}): Promise<Job> {
  const now = new Date().toISOString();
  const job: Job = {
    id: randomUUID(),
    accountId: input.accountId,
    mode: input.mode,
    sourceUrl: input.sourceUrl ?? null,
    stage: "queued",
    percent: 0,
    message: null,
    inventory: null,
    match: null,
    spec: null,
    gameId: null,
    businessName: null,
    businessDescription: null,
    droppedCount: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  if (isDevMode()) {
    return jobsMutex.run(async () => {
      const rows = await readDevTable<Job>(JOBS_FILE);
      rows.push(job);
      await writeDevTable(JOBS_FILE, rows);
      return job;
    });
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("jobs")
    .insert(jobRecordToRow(job))
    .select("*")
    .single();
  if (error) throw error;
  return jobRowToRecord(data as JobRow);
}

export async function updateJob(id: string, patch: Partial<Job>): Promise<Job> {
  const now = new Date().toISOString();
  if (isDevMode()) {
    return jobsMutex.run(async () => {
      const rows = await readDevTable<Job>(JOBS_FILE);
      const idx = rows.findIndex((j) => j.id === id);
      if (idx === -1) throw new Error("job_not_found");
      const updated: Job = { ...rows[idx]!, ...patch, updatedAt: now };
      rows[idx] = updated;
      await writeDevTable(JOBS_FILE, rows);
      return updated;
    });
  }

  const supabase = getSupabaseServerClient();
  const row = jobRecordToRow(patch);
  row.updated_at = now;
  const { data, error } = await supabase
    .from("jobs")
    .update(row)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return jobRowToRecord(data as JobRow);
}

export async function getJob(id: string): Promise<Job | null> {
  if (isDevMode()) {
    const rows = await readDevTable<Job>(JOBS_FILE);
    return rows.find((j) => j.id === id) ?? null;
  }
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.from("jobs").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? jobRowToRecord(data as JobRow) : null;
}

/**
 * The job that originally generated a game — the only place `AssetInventory`
 * survives (games.spec never stores it). Used by the template-switch route
 * to re-run the matcher against the site's real assets. Manual-mode games
 * never had a job at all (app/api/games/route.ts creates them directly), so
 * `null` here is an expected, honest answer, not an error condition.
 * Most-recent by `created_at` in case a game somehow has more than one
 * associated job row — there's no code path that produces that today, but
 * "newest" is the safer tie-break if it ever does.
 */
export async function getJobByGameId(gameId: string): Promise<Job | null> {
  if (isDevMode()) {
    const rows = await readDevTable<Job>(JOBS_FILE);
    const matches = rows.filter((j) => j.gameId === gameId);
    matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return matches[0] ?? null;
  }
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("game_id", gameId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? jobRowToRecord(data as JobRow) : null;
}

// ---------------------------------------------------------------------------
// Plays
// ---------------------------------------------------------------------------

async function insertPlayRow(record: PlayRecord): Promise<PlayRecord> {
  if (isDevMode()) {
    return playsMutex.run(async () => {
      const rows = await readDevTable<PlayRecord>(PLAYS_FILE);
      rows.push(record);
      await writeDevTable(PLAYS_FILE, rows);
      return record;
    });
  }
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("plays")
    .insert(playRecordToRow(record))
    .select("*")
    .single();
  if (error) throw error;
  return playRowToRecord(data as PlayRow);
}

async function findPlayBySession(session: string): Promise<PlayRecord | null> {
  if (isDevMode()) {
    const rows = await readDevTable<PlayRecord>(PLAYS_FILE);
    return rows.find((p) => p.session === session) ?? null;
  }
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("plays")
    .select("*")
    .eq("session", session)
    .maybeSingle();
  if (error) throw error;
  return data ? playRowToRecord(data as PlayRow) : null;
}

async function updatePlayRow(id: string, patch: Partial<PlayRecord>): Promise<PlayRecord> {
  if (isDevMode()) {
    return playsMutex.run(async () => {
      const rows = await readDevTable<PlayRecord>(PLAYS_FILE);
      const idx = rows.findIndex((p) => p.id === id);
      if (idx === -1) throw new Error("play_not_found");
      const updated = { ...rows[idx]!, ...patch };
      rows[idx] = updated;
      await writeDevTable(PLAYS_FILE, rows);
      return updated;
    });
  }
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("plays")
    .update(playRecordToRow(patch))
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return playRowToRecord(data as PlayRow);
}

/**
 * Look up a play by its session token. Not part of the fixed cross-track
 * contract, but needed by this track's own /api/leads route to resolve
 * `sessionToken` into the `gameId`/`playId` that `recordLead` requires.
 */
export async function getPlayBySession(sessionToken: string): Promise<PlayRecord | null> {
  return findPlayBySession(sessionToken);
}

/**
 * Begin a play session. Public contract is `startPlay(gameId)`; the optional
 * second argument is an internal extension used only by this track's own
 * `/api/plays/start` route to record referrer/device for the analytics
 * dashboard (build spec §16) — it is not part of the cross-track contract,
 * and every call with just `gameId` behaves exactly as documented.
 */
export async function startPlay(
  gameId: string,
  meta?: {
    referrer?: string | null;
    device?: "mobile" | "desktop" | null;
    replayOfSessionToken?: string | null;
  },
): Promise<{ sessionToken: string; playId: string }> {
  const id = randomUUID();
  const sessionToken = nanoid(24);
  const now = new Date().toISOString();

  let replayOf: string | null = null;
  if (meta?.replayOfSessionToken) {
    const prior = await findPlayBySession(meta.replayOfSessionToken);
    if (prior && prior.gameId === gameId) replayOf = prior.id;
  }

  const record: PlayRecord = {
    id,
    gameId,
    session: sessionToken,
    startedAt: now,
    finishedAt: null,
    score: null,
    tierIndex: null,
    replayOf,
    referrer: meta?.referrer ?? null,
    device: meta?.device ?? null,
    country: null,
  };
  await insertPlayRow(record);
  return { sessionToken, playId: id };
}

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes, per build spec §12/§17
const MIN_PLAY_SECONDS_FLOOR = 2;

// Reward codes are a placeholder until Horizon 2 coupon APIs mint a real,
// redeemable, single-use code in the merchant's own store (build spec §22).
// Until then, GameSpec.rewards[].code is essentially never set (nothing in
// the auto or manual path populates it), but the runtime's reward screen
// displays whatever code this route returns as the thing to email — so we
// still mint a short, human-typeable placeholder here rather than showing
// "pending" on every single reward. No ambiguous characters (0/O, 1/I/L).

/**
 * Server-side anti-forgery gate (build spec §12, §17). `sessionToken` is
 * single-use and expires 10 minutes after startPlay(); the reported score is
 * checked against this game's own realistic score ceiling (tuning-aware —
 * see lib/engine/scoreCeiling.ts) and an elapsed-time floor, so a play that
 * reports a real-looking score in an impossibly short time is not rewarded.
 * A forged/implausible submission still consumes the token (so it can't be
 * retried into something that passes) but is scored as 0 with no tier — it
 * is not a hard error, so a legitimate slow network doesn't error out the
 * whole request.
 */
export async function finishPlay(
  sessionToken: string,
  score: number,
): Promise<{ tier: RewardTier | null; tierIndex: number; code?: string }> {
  const play = await findPlayBySession(sessionToken);
  if (!play) throw new Error("invalid_session");
  if (play.finishedAt) throw new Error("session_already_used");

  const startedAtMs = new Date(play.startedAt).getTime();
  const now = Date.now();
  if (now - startedAtMs > SESSION_TTL_MS) throw new Error("session_expired");

  const game = await getGameById(play.gameId);
  if (!game) throw new Error("game_not_found");

  const elapsedSeconds = (now - startedAtMs) / 1000;
  // Resolved from this game's tuning, not from the template's static
  // capability.scoring.maxRealistic: the editor can raise durationSec /
  // spawnRateHz, and a fixed per-template constant would then read honest
  // scores as forged and silently stop paying rewards out. The resolver falls
  // back to that same constant whenever it can't load a runtime module, so
  // the worst case here is the behaviour this replaced.
  const maxRealistic =
    (await resolveMaxRealisticScoreForSpec(game.spec)) ?? Number.POSITIVE_INFINITY;
  const minPlausibleSeconds = Math.max(
    MIN_PLAY_SECONDS_FLOOR,
    game.spec.durationSeconds * 0.2,
  );

  const reportedScore = Math.max(0, Math.trunc(score));
  const withinRealisticRange = reportedScore <= maxRealistic;
  const withinTimeFloor = elapsedSeconds >= minPlausibleSeconds;
  const forged = !withinRealisticRange || !withinTimeFloor;
  const effectiveScore = forged ? 0 : reportedScore;

  let tierIndex = -1;
  let tier: RewardTier | null = null;
  if (!forged) {
    const sortedRewards = [...game.spec.rewards].sort((a, b) => a.minScore - b.minScore);
    for (let idx = 0; idx < sortedRewards.length; idx++) {
      const candidate = sortedRewards[idx]!;
      if (effectiveScore >= candidate.minScore) {
        tier = candidate;
        tierIndex = idx;
      }
    }
  }

  await updatePlayRow(play.id, {
    finishedAt: new Date(now).toISOString(),
    score: reportedScore, // raw reported score kept for audit even when forged
    tierIndex: tierIndex >= 0 ? tierIndex : null,
  });

  // Only the legacy STATIC code from the spec, never a freshly invented one.
  //
  // This used to be `tier.code ?? generateRewardCode()`, which minted a
  // random 8-character string per play. That was a placeholder from before
  // coupon pools existed and it is actively harmful now: the code exists
  // nowhere in the merchant's store, so the player carries it to checkout and
  // it is rejected. Worse, the reward screen seeds its coupon block from this
  // value, so a game WITH a real pool would display the fake code instead of
  // claiming a real one.
  //
  // A tier with a pool now returns undefined here and the reward screen
  // claims on demand via POST /api/plays/claim-coupon. A tier with neither a
  // pool nor a static code shows the tier and no code, which is the decided
  // behaviour for an empty pool.
  const code = tier?.code ?? undefined;
  return { tier, tierIndex: tierIndex >= 0 ? tierIndex : -1, code };
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export async function recordLead(input: {
  gameId: string;
  playId?: string;
  email?: string;
  phone?: string;
  consent: boolean;
}): Promise<LeadRecord> {
  const now = new Date().toISOString();

  if (isDevMode()) {
    return leadsMutex.run(async () => {
      const rows = await readDevTable<LeadRecord>(LEADS_FILE);
      // Mirror the DB's partial unique index on (game_id, email): update in
      // place rather than duplicate when this email already has a lead for
      // this game.
      if (input.email) {
        const idx = rows.findIndex(
          (l) => l.gameId === input.gameId && l.email === input.email,
        );
        if (idx !== -1) {
          const updated: LeadRecord = {
            ...rows[idx]!,
            playId: input.playId ?? rows[idx]!.playId,
            phone: input.phone ?? rows[idx]!.phone,
            consent: input.consent,
          };
          rows[idx] = updated;
          await writeDevTable(LEADS_FILE, rows);
          return updated;
        }
      }
      const record: LeadRecord = {
        id: randomUUID(),
        gameId: input.gameId,
        playId: input.playId ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        consent: input.consent,
        createdAt: now,
      };
      rows.push(record);
      await writeDevTable(LEADS_FILE, rows);
      return record;
    });
  }

  const supabase = getSupabaseServerClient();
  const row = leadRecordToRow({
    id: randomUUID(),
    gameId: input.gameId,
    playId: input.playId ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    consent: input.consent,
    createdAt: now,
  });
  if (input.email) {
    const { data, error } = await supabase
      .from("leads")
      .upsert(row, { onConflict: "game_id,email" })
      .select("*")
      .single();
    if (error) throw error;
    return leadRowToRecord(data as LeadRow);
  }
  const { data, error } = await supabase.from("leads").insert(row).select("*").single();
  if (error) throw error;
  return leadRowToRecord(data as LeadRow);
}

// ---------------------------------------------------------------------------
// Analytics events (build spec §16)
// ---------------------------------------------------------------------------

export async function recordAnalyticsEvent(input: {
  gameId: string;
  playId?: string | null;
  event: AnalyticsEvent;
  detail?: Record<string, unknown> | null;
}): Promise<GameAnalyticsEventRecord> {
  const now = new Date().toISOString();
  const record: GameAnalyticsEventRecord = {
    id: randomUUID(),
    gameId: input.gameId,
    playId: input.playId ?? null,
    event: input.event,
    detail: input.detail ?? null,
    createdAt: now,
  };

  if (isDevMode()) {
    return analyticsEventsMutex.run(async () => {
      const rows = await readDevTable<GameAnalyticsEventRecord>(ANALYTICS_EVENTS_FILE);
      rows.push(record);
      await writeDevTable(ANALYTICS_EVENTS_FILE, rows);
      return record;
    });
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("game_analytics_events")
    .insert({
      id: record.id,
      game_id: record.gameId,
      play_id: record.playId,
      event: record.event,
      detail: record.detail,
      created_at: record.createdAt,
    })
    .select("*")
    .single();
  if (error) throw error;
  return analyticsEventRowToRecord(data as AnalyticsEventRow);
}

export async function listAnalyticsEventsForGames(
  gameIds: string[],
  range: AnalyticsDateRange,
): Promise<GameAnalyticsEventRecord[]> {
  if (gameIds.length === 0) return [];

  if (isDevMode()) {
    const rows = await readDevTable<GameAnalyticsEventRecord>(ANALYTICS_EVENTS_FILE);
    return rows.filter(
      (e) => gameIds.includes(e.gameId) && inAnalyticsRange(e.createdAt, range),
    );
  }

  const supabase = getSupabaseServerClient();
  let query = supabase
    .from("game_analytics_events")
    .select("*")
    .in("game_id", gameIds)
    .order("created_at", { ascending: true });
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lte("created_at", range.to);
  const { data, error } = await query;
  if (error) throw error;
  return (data as AnalyticsEventRow[]).map(analyticsEventRowToRecord);
}

export async function listPlaysForGames(
  gameIds: string[],
  range: AnalyticsDateRange,
): Promise<PlayRecord[]> {
  if (gameIds.length === 0) return [];

  if (isDevMode()) {
    const rows = await readDevTable<PlayRecord>(PLAYS_FILE);
    return rows.filter(
      (p) => gameIds.includes(p.gameId) && inAnalyticsRange(p.startedAt, range),
    );
  }

  const supabase = getSupabaseServerClient();
  let query = supabase.from("plays").select("*").in("game_id", gameIds);
  if (range.from) query = query.gte("started_at", range.from);
  if (range.to) query = query.lte("started_at", range.to);
  const { data, error } = await query;
  if (error) throw error;
  return (data as PlayRow[]).map(playRowToRecord);
}

export async function listLeadsForGames(
  gameIds: string[],
  range: AnalyticsDateRange,
): Promise<LeadRecord[]> {
  if (gameIds.length === 0) return [];

  if (isDevMode()) {
    const rows = await readDevTable<LeadRecord>(LEADS_FILE);
    return rows.filter(
      (l) => gameIds.includes(l.gameId) && inAnalyticsRange(l.createdAt, range),
    );
  }

  const supabase = getSupabaseServerClient();
  let query = supabase.from("leads").select("*").in("game_id", gameIds);
  if (range.from) query = query.gte("created_at", range.from);
  if (range.to) query = query.lte("created_at", range.to);
  const { data, error } = await query;
  if (error) throw error;
  return (data as LeadRow[]).map(leadRowToRecord);
}

export async function listClaimedCouponsForGames(
  gameIds: string[],
): Promise<{ playId: string; gameId: string }[]> {
  if (gameIds.length === 0) return [];

  if (isDevMode()) {
    const rows = await readDevTable<CouponRecord>(COUPONS_FILE);
    return rows
      .filter((c) => gameIds.includes(c.gameId) && c.claimedByPlayId !== null)
      .map((c) => ({ playId: c.claimedByPlayId!, gameId: c.gameId }));
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("coupons")
    .select("game_id, claimed_by_play_id")
    .in("game_id", gameIds)
    .not("claimed_by_play_id", "is", null);
  if (error) throw error;
  return (data ?? []).map((row: { game_id: string; claimed_by_play_id: string }) => ({
    gameId: row.game_id,
    playId: row.claimed_by_play_id,
  }));
}

// ---------------------------------------------------------------------------
// Analytics (build spec §16)
// ---------------------------------------------------------------------------

export async function getGameAnalytics(
  gameId: string,
  range: AnalyticsDateRange,
): Promise<GameAnalytics | null> {
  const game = await getGameById(gameId);
  if (!game) return null;

  const gameIds = [gameId];
  const [plays, leads, events, couponTiers, claimedRows] = await Promise.all([
    listPlaysForGames(gameIds, range),
    listLeadsForGames(gameIds, range),
    listAnalyticsEventsForGames(gameIds, range),
    getCouponStats(gameId),
    listClaimedCouponsForGames(gameIds),
  ]);

  const claimedPlayIds = new Set(
    claimedRows.filter((c) => c.gameId === gameId).map((c) => c.playId),
  );

  return buildGameAnalytics({
    game,
    range,
    plays,
    leads,
    events,
    couponTiers,
    claimedPlayIds,
  });
}

export async function getAccountAnalytics(
  accountId: string | null,
  range: AnalyticsDateRange,
): Promise<AccountAnalytics> {
  const games = await listGames(accountId);
  const gameIds = games.map((g) => g.id);

  const [plays, leads, events, claimedRows] = await Promise.all([
    listPlaysForGames(gameIds, range),
    listLeadsForGames(gameIds, range),
    listAnalyticsEventsForGames(gameIds, range),
    listClaimedCouponsForGames(gameIds),
  ]);

  const claimedByGame = new Map<string, Set<string>>();
  for (const row of claimedRows) {
    let set = claimedByGame.get(row.gameId);
    if (!set) {
      set = new Set();
      claimedByGame.set(row.gameId, set);
    }
    set.add(row.playId);
  }

  return buildAccountAnalytics({
    range,
    games,
    plays,
    leads,
    events,
    claimedByGame,
  });
}

export async function getGameStats(gameId: string): Promise<{
  plays: number;
  completionRate: number;
  avgScore: number;
  replayRate: number;
  rewardsByTier: { label: string; count: number }[];
  leadsCaptured: number;
  deviceSplit: { mobile: number; desktop: number };
  topReferrers: { referrer: string; count: number }[];
}> {
  const analytics = await getGameAnalytics(gameId, { from: null, to: null });
  if (!analytics) {
    return {
      plays: 0,
      completionRate: 0,
      avgScore: 0,
      replayRate: 0,
      rewardsByTier: [],
      leadsCaptured: 0,
      deviceSplit: { mobile: 0, desktop: 0 },
      topReferrers: [],
    };
  }
  return {
    plays: analytics.plays,
    completionRate: analytics.completionRate,
    avgScore: analytics.avgScore,
    replayRate: analytics.replayRate,
    rewardsByTier: analytics.rewardsByTier,
    leadsCaptured: analytics.leadsCaptured,
    deviceSplit: analytics.deviceSplit,
    topReferrers: analytics.topReferrers,
  };
}

// ---------------------------------------------------------------------------
// Coupons
//
// Per-reward-tier pools of single-use codes. Two invariants carry this whole
// feature, and both are enforced by the DATABASE rather than by care here:
//
//   1. A code is unique within a game (coupons_game_code_idx) — re-uploading
//      the same CSV cannot double-issue.
//   2. A play holds at most one code per tier (coupons_one_per_play_idx) — a
//      double-clicked "Copy code" cannot burn two coupons.
//
// See supabase/migrations/20260917000003_coupons.sql, especially the
// claim_coupon() function: the claim CANNOT be a read-then-write from here,
// because two concurrent players would read the same unclaimed row and both
// walk away with it.
// ---------------------------------------------------------------------------

interface CouponRow {
  id: string;
  game_id: string;
  tier_index: number;
  code: string;
  claimed_at: string | null;
  claimed_by_play_id: string | null;
  created_at: string;
}

function couponRowToRecord(row: CouponRow): CouponRecord {
  return {
    id: row.id,
    gameId: row.game_id,
    tierIndex: row.tier_index,
    code: row.code,
    claimedAt: row.claimed_at,
    claimedByPlayId: row.claimed_by_play_id,
    createdAt: row.created_at,
  };
}

export interface AddCouponsResult {
  /** How many rows actually landed. */
  inserted: number;
  /** Codes rejected because that code already exists in this game. */
  duplicates: string[];
}

/**
 * Appends codes to one tier's pool. Idempotent per code: a code already in
 * this game is reported as a duplicate rather than inserted again or thrown
 * over, so re-uploading a superset of a previous file tops the pool up
 * instead of failing wholesale.
 */
export async function addCoupons(input: {
  gameId: string;
  tierIndex: number;
  codes: string[];
}): Promise<AddCouponsResult> {
  const { gameId, tierIndex, codes } = input;
  if (codes.length === 0) return { inserted: 0, duplicates: [] };

  if (isDevMode()) {
    return couponsMutex.run(async () => {
      const rows = await readDevTable<CouponRecord>(COUPONS_FILE);
      const existing = new Set(rows.filter((c) => c.gameId === gameId).map((c) => c.code));
      const duplicates: string[] = [];
      const now = new Date().toISOString();
      let inserted = 0;
      for (const code of codes) {
        if (existing.has(code)) {
          duplicates.push(code);
          continue;
        }
        existing.add(code);
        rows.push({
          id: randomUUID(),
          gameId,
          tierIndex,
          code,
          claimedAt: null,
          claimedByPlayId: null,
          createdAt: now,
        });
        inserted++;
      }
      await writeDevTable(COUPONS_FILE, rows);
      return { inserted, duplicates };
    });
  }

  const supabase = getSupabaseServerClient();

  // Read the existing codes for this game first so duplicates can be
  // REPORTED, not just silently skipped. `upsert(..., ignoreDuplicates)`
  // would insert the new ones and tell us nothing about which were dropped,
  // and a merchant uploading 500 codes needs to know that 480 of them were
  // already there.
  const { data: existingRows, error: existingError } = await supabase
    .from("coupons")
    .select("code")
    .eq("game_id", gameId)
    .in("code", codes);
  if (existingError) throw existingError;

  const existing = new Set((existingRows ?? []).map((r) => (r as { code: string }).code));
  const duplicates = codes.filter((c) => existing.has(c));
  const fresh = codes.filter((c) => !existing.has(c));
  if (fresh.length === 0) return { inserted: 0, duplicates };

  const { data, error } = await supabase
    .from("coupons")
    .insert(
      fresh.map((code) => ({ game_id: gameId, tier_index: tierIndex, code })),
    )
    .select("id");
  if (error) throw error;

  return { inserted: (data ?? []).length, duplicates };
}

/**
 * Per-tier inventory for every tier that has a pool. Tiers with no codes at
 * all are simply absent — the editor fills those in as "no pool yet" from
 * the spec's own reward list.
 */
export async function getCouponStats(gameId: string): Promise<CouponTierStats[]> {
  const byTier = new Map<number, { total: number; claimed: number }>();

  if (isDevMode()) {
    const rows = await readDevTable<CouponRecord>(COUPONS_FILE);
    for (const c of rows) {
      if (c.gameId !== gameId) continue;
      const entry = byTier.get(c.tierIndex) ?? { total: 0, claimed: 0 };
      entry.total++;
      if (c.claimedAt) entry.claimed++;
      byTier.set(c.tierIndex, entry);
    }
  } else {
    const supabase = getSupabaseServerClient();
    // Selecting only the two columns needed keeps this cheap on a pool of
    // tens of thousands; the aggregate is done here rather than in SQL to
    // keep one code path for both stores.
    const { data, error } = await supabase
      .from("coupons")
      .select("tier_index, claimed_at")
      .eq("game_id", gameId);
    if (error) throw error;
    for (const row of (data ?? []) as { tier_index: number; claimed_at: string | null }[]) {
      const entry = byTier.get(row.tier_index) ?? { total: 0, claimed: 0 };
      entry.total++;
      if (row.claimed_at) entry.claimed++;
      byTier.set(row.tier_index, entry);
    }
  }

  return [...byTier.entries()]
    .map(([tierIndex, v]) => ({
      tierIndex,
      total: v.total,
      claimed: v.claimed,
      remaining: v.total - v.claimed,
    }))
    .sort((a, b) => a.tierIndex - b.tierIndex);
}

/** Unclaimed codes for one tier, for the admin's own export/preview. */
export async function listCoupons(input: {
  gameId: string;
  tierIndex?: number;
  limit?: number;
}): Promise<CouponRecord[]> {
  const limit = Math.min(Math.max(1, input.limit ?? 100), 5000);

  if (isDevMode()) {
    const rows = await readDevTable<CouponRecord>(COUPONS_FILE);
    return rows
      .filter(
        (c) =>
          c.gameId === input.gameId &&
          (input.tierIndex === undefined || c.tierIndex === input.tierIndex),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .slice(0, limit);
  }

  const supabase = getSupabaseServerClient();
  let query = supabase
    .from("coupons")
    .select("*")
    .eq("game_id", input.gameId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (input.tierIndex !== undefined) query = query.eq("tier_index", input.tierIndex);

  const { data, error } = await query;
  if (error) throw error;
  return (data as CouponRow[]).map(couponRowToRecord);
}

/**
 * Removes UNCLAIMED codes from a tier's pool (or the whole game when
 * tierIndex is omitted), returning how many went.
 *
 * Claimed rows are deliberately never deleted: they are the record of what
 * was handed to which play, which is what a merchant needs when a customer
 * disputes a code at checkout.
 */
export async function deleteUnclaimedCoupons(input: {
  gameId: string;
  tierIndex?: number;
}): Promise<number> {
  if (isDevMode()) {
    return couponsMutex.run(async () => {
      const rows = await readDevTable<CouponRecord>(COUPONS_FILE);
      const keep = rows.filter(
        (c) =>
          !(
            c.gameId === input.gameId &&
            c.claimedAt === null &&
            (input.tierIndex === undefined || c.tierIndex === input.tierIndex)
          ),
      );
      const removed = rows.length - keep.length;
      if (removed > 0) await writeDevTable(COUPONS_FILE, keep);
      return removed;
    });
  }

  const supabase = getSupabaseServerClient();
  let query = supabase
    .from("coupons")
    .delete()
    .eq("game_id", input.gameId)
    .is("claimed_at", null);
  if (input.tierIndex !== undefined) query = query.eq("tier_index", input.tierIndex);

  const { data, error } = await query.select("id");
  if (error) throw error;
  return (data ?? []).length;
}

export interface ClaimedCoupon {
  code: string;
  /** True when this play already held the code and nothing was consumed. */
  reused: boolean;
}

export type CouponClaimOutcome =
  | { status: "ok"; coupon: ClaimedCoupon }
  | { status: "no_reward" }
  | { status: "expired" }
  | { status: "exhausted" };

/**
 * Hands the player of `sessionToken` exactly one code for the tier their
 * score earned.
 *
 * Safe to call repeatedly: the same play always gets back the same code and
 * only the first call consumes anything. That is what makes the reward
 * screen's Copy button safe to double-click, and it is enforced in the
 * database (see the module header), not just here.
 */
export async function claimCouponForPlay(sessionToken: string): Promise<CouponClaimOutcome> {
  const play = await getPlayBySession(sessionToken);
  if (!play) throw new Error("invalid_session");
  // Claiming before the game is over would let someone skip playing; the
  // score is only trustworthy once finishPlay has vetted it.
  if (!play.finishedAt) throw new Error("session_not_finished");

  const game = await getGameById(play.gameId);
  if (!game) throw new Error("game_not_found");

  // finishPlay's verdict is authoritative, and it is read from
  // play.tierIndex — NOT recomputed from play.score.
  //
  // This is load-bearing for anti-forgery. finishPlay vets the reported score
  // against the template's realistic ceiling and an elapsed-time floor; when
  // it judges a score forged it writes tier_index = null but KEEPS the raw
  // reported score in `score` for audit. Re-deriving the tier from that raw
  // score therefore pays out exactly the plays finishPlay just rejected —
  // caught by a test where finishPlay returned tier null and the claim still
  // handed over a code.
  if (play.tierIndex === null || play.tierIndex < 0) return { status: "no_reward" };

  // play.tierIndex is an index into the SORTED rewards; pools are keyed by the
  // spec's own array order. These are different numbers whenever the merchant
  // has reordered tiers.
  const tierIndex = originalTierIndexFromSortedIndex(game.spec.rewards, play.tierIndex);
  const tier = tierIndex >= 0 ? game.spec.rewards[tierIndex] : undefined;
  if (!tier) return { status: "no_reward" };

  // An expired offer must stop paying out even if codes remain, otherwise the
  // pool keeps handing out codes the merchant's checkout will reject.
  if (isCouponExpired(tier.coupon)) return { status: "expired" };

  if (isDevMode()) {
    return couponsMutex.run<CouponClaimOutcome>(async () => {
      const rows = await readDevTable<CouponRecord>(COUPONS_FILE);

      const already = rows.find(
        (c) =>
          c.gameId === play.gameId &&
          c.tierIndex === tierIndex &&
          c.claimedByPlayId === play.id,
      );
      if (already) return { status: "ok", coupon: { code: already.code, reused: true } };

      const next = rows
        .filter(
          (c) => c.gameId === play.gameId && c.tierIndex === tierIndex && c.claimedAt === null,
        )
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];

      if (!next) {
        // Last resort: the legacy single static code from the spec. Not a
        // generated one — a made-up code fails at the merchant's checkout,
        // which is worse for the player than being told to check back.
        if (tier.code) return { status: "ok", coupon: { code: tier.code, reused: true } };
        // "Never had a pool" is not the same as "ran out", and the reward
        // screen words them differently: a thank-you tier with no coupon
        // should not tell the player codes have run out.
        const everHadCodes = rows.some(
          (c) => c.gameId === play.gameId && c.tierIndex === tierIndex,
        );
        return { status: everHadCodes ? "exhausted" : "no_reward" };
      }

      next.claimedAt = new Date().toISOString();
      next.claimedByPlayId = play.id;
      await writeDevTable(COUPONS_FILE, rows);
      return { status: "ok", coupon: { code: next.code, reused: false } };
    });
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.rpc("claim_coupon", {
    p_game_id: play.gameId,
    p_tier_index: tierIndex,
    p_play_id: play.id,
  });
  if (error) throw error;

  const code = typeof data === "string" && data.length > 0 ? data : null;
  if (!code) {
    if (tier.code) return { status: "ok", coupon: { code: tier.code, reused: true } };
    // One extra query, only on the miss path: tell "ran out" apart from
    // "never had a pool" so the player is not told codes ran out for a tier
    // that never offered one.
    const { count, error: countError } = await supabase
      .from("coupons")
      .select("id", { count: "exact", head: true })
      .eq("game_id", play.gameId)
      .eq("tier_index", tierIndex);
    if (countError) throw countError;
    return { status: (count ?? 0) > 0 ? "exhausted" : "no_reward" };
  }

  // `reused` is not distinguishable from the SQL function's return value on
  // purpose — it returns the code whether it just claimed it or found an
  // existing claim, which is exactly the idempotency the caller wants. The
  // flag only drives a cosmetic "already claimed" hint, so reporting false
  // here is harmless; the dev path, which can tell, reports it accurately.
  return { status: "ok", coupon: { code, reused: false } };
}
