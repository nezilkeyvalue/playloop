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
import { nanoid, customAlphabet } from "nanoid";

import { getSupabaseServerClient, isDevMode } from "./client";
import { generateSlug } from "@/lib/slug";
import { getCapability } from "@/lib/capabilities";
import type {
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

const gamesMutex = createMutex();
const jobsMutex = createMutex();
const playsMutex = createMutex();
const leadsMutex = createMutex();

const GAMES_FILE = "games.json";
const JOBS_FILE = "jobs.json";
const PLAYS_FILE = "plays.json";
const LEADS_FILE = "leads.json";

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
  meta?: { referrer?: string | null; device?: "mobile" | "desktop" | null },
): Promise<{ sessionToken: string; playId: string }> {
  const id = randomUUID();
  const sessionToken = nanoid(24);
  const now = new Date().toISOString();
  const record: PlayRecord = {
    id,
    gameId,
    session: sessionToken,
    startedAt: now,
    finishedAt: null,
    score: null,
    tierIndex: null,
    replayOf: null,
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
const generateRewardCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8);

/**
 * Server-side anti-forgery gate (build spec §12, §17). `sessionToken` is
 * single-use and expires 10 minutes after startPlay(); the reported score is
 * checked against the template capability's `scoring.maxRealistic` and an
 * elapsed-time floor so a play that reports a real-looking score in an
 * impossibly short time is not rewarded. A forged/implausible submission
 * still consumes the token (so it can't be retried into something that
 * passes) but is scored as 0 with no tier — it is not a hard error, so a
 * legitimate slow network doesn't error out the whole request.
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
  const capability = getCapability(game.spec.template);
  const maxRealistic = capability?.scoring.maxRealistic ?? Number.POSITIVE_INFINITY;
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

  const code = tier ? (tier.code ?? generateRewardCode()) : undefined;
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
// Analytics (build spec §16)
// ---------------------------------------------------------------------------

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
  let plays: PlayRecord[];
  let leads: LeadRecord[];

  if (isDevMode()) {
    const [allPlays, allLeads] = await Promise.all([
      readDevTable<PlayRecord>(PLAYS_FILE),
      readDevTable<LeadRecord>(LEADS_FILE),
    ]);
    plays = allPlays.filter((p) => p.gameId === gameId);
    leads = allLeads.filter((l) => l.gameId === gameId);
  } else {
    const supabase = getSupabaseServerClient();
    const [{ data: playRows, error: playsErr }, { data: leadRows, error: leadsErr }] =
      await Promise.all([
        supabase.from("plays").select("*").eq("game_id", gameId),
        supabase.from("leads").select("*").eq("game_id", gameId),
      ]);
    if (playsErr) throw playsErr;
    if (leadsErr) throw leadsErr;
    plays = (playRows as PlayRow[]).map(playRowToRecord);
    leads = (leadRows as LeadRow[]).map(leadRowToRecord);
  }

  const game = await getGameById(gameId);
  const totalPlays = plays.length;
  const finished = plays.filter((p) => p.finishedAt !== null);
  const completionRate = totalPlays > 0 ? finished.length / totalPlays : 0;

  const scored = finished.filter((p) => p.score !== null) as (PlayRecord & { score: number })[];
  const avgScore =
    scored.length > 0 ? scored.reduce((sum, p) => sum + p.score, 0) / scored.length : 0;

  const replays = plays.filter((p) => p.replayOf !== null);
  const replayRate = totalPlays > 0 ? replays.length / totalPlays : 0;

  const tierCounts = new Map<number, number>();
  for (const p of finished) {
    if (p.tierIndex !== null && p.tierIndex >= 0) {
      tierCounts.set(p.tierIndex, (tierCounts.get(p.tierIndex) ?? 0) + 1);
    }
  }
  const rewards = game?.spec.rewards ?? [];
  const sortedRewards = [...rewards].sort((a, b) => a.minScore - b.minScore);
  const rewardsByTier = sortedRewards.map((tier, idx) => ({
    label: tier.label,
    count: tierCounts.get(idx) ?? 0,
  }));

  const deviceSplit = { mobile: 0, desktop: 0 };
  for (const p of plays) {
    if (p.device === "mobile") deviceSplit.mobile += 1;
    else if (p.device === "desktop") deviceSplit.desktop += 1;
  }

  const referrerCounts = new Map<string, number>();
  for (const p of plays) {
    if (p.referrer) referrerCounts.set(p.referrer, (referrerCounts.get(p.referrer) ?? 0) + 1);
  }
  const topReferrers = [...referrerCounts.entries()]
    .map(([referrer, count]) => ({ referrer, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    plays: totalPlays,
    completionRate,
    avgScore,
    replayRate,
    rewardsByTier,
    leadsCaptured: leads.length,
    deviceSplit,
    topReferrers,
  };
}
