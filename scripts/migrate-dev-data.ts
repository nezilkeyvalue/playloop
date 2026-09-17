// scripts/migrate-dev-data.ts
//
// One-shot migration: ./dev-data/  ->  the configured Supabase project.
//
//   npx tsx scripts/migrate-dev-data.ts --owner you@example.com
//   npx tsx scripts/migrate-dev-data.ts --owner you@example.com --dry-run
//
// Moves three things, in this order, because each depends on the one before:
//
//   1. ./dev-data/blob/*          -> the `sprites` Storage bucket
//   2. every /dev-blob/<name> URL inside a stored GameSpec -> its new public URL
//   3. ./dev-data/{games,jobs,plays,leads}.json -> the matching Postgres tables
//
// Step 2 is the reason this is a script and not a psql \copy: the sprite URLs
// are buried at arbitrary depths inside the `spec` JSON blob, and a row copied
// without rewriting them points at a local path that only ever existed on one
// laptop. Getting the rows across but leaving the images behind would look
// like a successful migration right up until someone opened a game.
//
// Idempotent: rows are upserted by primary key and objects are
// content-addressed, so re-running it is safe.

import { promises as fs } from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

// .env.local is not loaded automatically outside `next dev`.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

const DEV_DATA_DIR = path.join(process.cwd(), "dev-data");
const DEV_BLOB_DIR = path.join(DEV_DATA_DIR, "blob");
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "sprites";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const ownerEmail = valueOf("--owner");
const ownerIdArg = valueOf("--owner-id");

function valueOf(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

const EXT_BY_MAGIC: { bytes: number[]; ext: string; contentType: string }[] = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], ext: "png", contentType: "image/png" },
  { bytes: [0xff, 0xd8, 0xff], ext: "jpg", contentType: "image/jpeg" },
];

/**
 * The dev-disk store wrote `.bin` for anything it didn't have an extension
 * mapping for, so the file name can't be trusted to describe the bytes.
 * Storage needs a real content type (the bucket has an allowed_mime_types
 * allowlist), so sniff it.
 */
function sniff(buffer: Buffer): { ext: string; contentType: string } {
  for (const sig of EXT_BY_MAGIC) {
    if (sig.bytes.every((b, i) => buffer[i] === b)) {
      return { ext: sig.ext, contentType: sig.contentType };
    }
  }
  // RIFF....WEBP
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { ext: "webp", contentType: "image/webp" };
  }
  return { ext: "png", contentType: "image/png" };
}

async function readTable<T>(file: string): Promise<T[]> {
  try {
    return JSON.parse(await fs.readFile(path.join(DEV_DATA_DIR, file), "utf8")) as T[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.local).");
  }
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // --- Resolve the owner ----------------------------------------------------
  // Every dev-mode row was written with accountId: null (the single implicit
  // dev account). In the real database account_id references auth.users, and a
  // null owner means the row can never appear in anyone's "My games" — so the
  // migration has to be told who these games now belong to.
  let ownerId: string | null = ownerIdArg ?? null;
  if (!ownerId && ownerEmail) {
    const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (error) throw error;
    const match = data.users.find(
      (u) => u.email?.toLowerCase() === ownerEmail.toLowerCase(),
    );
    if (!match) {
      throw new Error(
        `No auth user found for ${ownerEmail}. Sign in to the app with Google once ` +
          `first — the account row is created on first sign-in — then re-run this.`,
      );
    }
    ownerId = match.id;
  }
  if (!ownerId) {
    throw new Error("Pass --owner <email> (or --owner-id <uuid>) to say who owns the migrated games.");
  }
  console.log(`Owner: ${ownerEmail ?? ownerId} -> ${ownerId}`);

  // --- 1. Blobs -------------------------------------------------------------
  const urlRewrites = new Map<string, string>();
  let blobFiles: string[] = [];
  try {
    blobFiles = await fs.readdir(DEV_BLOB_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  for (const file of blobFiles) {
    const buffer = await fs.readFile(path.join(DEV_BLOB_DIR, file));
    const { ext, contentType } = sniff(buffer);
    // Keep the existing content hash as the object name so the mapping from
    // old URL to new is one-to-one and re-running rewrites nothing twice.
    const base = file.replace(/\.[^.]+$/, "");
    const objectName = `${base}.${ext}`;

    if (!dryRun) {
      const { error } = await supabase.storage.from(BUCKET).upload(objectName, buffer, {
        contentType,
        upsert: true,
        // Supabase prefixes `public, max-age=` itself — see lib/storage.ts.
        cacheControl: "31536000, immutable",
      });
      if (error) throw new Error(`upload ${objectName}: ${error.message}`);
    }
    const publicUrl = supabase.storage.from(BUCKET).getPublicUrl(objectName).data.publicUrl;
    urlRewrites.set(`/dev-blob/${file}`, publicUrl);
    console.log(`  blob ${file} -> ${objectName}`);
  }
  console.log(`Blobs: ${blobFiles.length}`);

  /** Rewrites every local /dev-blob URL anywhere inside a JSON value. */
  function rewrite<T>(value: T): T {
    if (urlRewrites.size === 0) return value;
    let json = JSON.stringify(value);
    for (const [from, to] of urlRewrites) {
      json = json.split(from).join(to);
    }
    return JSON.parse(json) as T;
  }

  // --- 2 + 3. Rows ----------------------------------------------------------
  interface DevGame {
    id: string; accountId: string | null; slug: string | null; name: string;
    spec: unknown; placement: string; status: string; allowedHosts: string[];
    createdAt: string; updatedAt: string;
  }
  interface DevJob {
    id: string; accountId: string | null; mode: string; sourceUrl: string | null;
    stage: string; percent: number; message: string | null; inventory: unknown;
    match: unknown; spec: unknown; gameId: string | null; businessName: string | null;
    businessDescription: string | null; droppedCount: number | null; error: string | null;
    createdAt: string; updatedAt: string;
  }
  interface DevPlay {
    id: string; gameId: string; session: string; startedAt: string;
    finishedAt: string | null; score: number | null; tierIndex: number | null;
    replayOf: string | null; referrer: string | null; device: string | null; country: string | null;
  }
  interface DevLead {
    id: string; gameId: string; playId: string | null; email: string | null;
    phone: string | null; consent: boolean; createdAt: string;
  }

  const games = await readTable<DevGame>("games.json");
  const jobs = await readTable<DevJob>("jobs.json");
  const plays = await readTable<DevPlay>("plays.json");
  const leads = await readTable<DevLead>("leads.json");

  const gameRows = games.map((g) => ({
    id: g.id,
    account_id: ownerId,
    slug: g.slug,
    name: g.name,
    spec: rewrite(g.spec),
    placement: g.placement,
    status: g.status,
    allowed_hosts: g.allowedHosts ?? [],
    created_at: g.createdAt,
    updated_at: g.updatedAt,
  }));

  const jobRows = jobs.map((j) => ({
    id: j.id,
    account_id: ownerId,
    mode: j.mode,
    source_url: j.sourceUrl,
    stage: j.stage,
    percent: j.percent,
    message: j.message,
    inventory: rewrite(j.inventory),
    match: rewrite(j.match),
    spec: rewrite(j.spec),
    game_id: j.gameId,
    business_name: j.businessName,
    business_description: j.businessDescription,
    dropped_count: j.droppedCount,
    error: j.error,
    created_at: j.createdAt,
    updated_at: j.updatedAt,
  }));

  const playRows = plays.map((p) => ({
    id: p.id, game_id: p.gameId, session: p.session, started_at: p.startedAt,
    finished_at: p.finishedAt, score: p.score, tier_index: p.tierIndex,
    replay_of: p.replayOf, referrer: p.referrer, device: p.device, country: p.country,
  }));

  const leadRows = leads.map((l) => ({
    id: l.id, game_id: l.gameId, play_id: l.playId, email: l.email,
    phone: l.phone, consent: l.consent, created_at: l.createdAt,
  }));

  // Order matters: jobs.game_id and plays.game_id both reference games, and
  // leads reference plays.
  const batches: [string, Record<string, unknown>[]][] = [
    ["games", gameRows],
    ["jobs", jobRows],
    ["plays", playRows],
    ["leads", leadRows],
  ];

  for (const [table, rows] of batches) {
    if (rows.length === 0) {
      console.log(`${table}: 0 rows, skipped`);
      continue;
    }
    if (dryRun) {
      console.log(`${table}: would upsert ${rows.length} rows (dry run)`);
      continue;
    }
    const { error } = await supabase.from(table).upsert(rows, { onConflict: "id" });
    if (error) throw new Error(`${table}: ${error.message}`);
    console.log(`${table}: upserted ${rows.length} rows`);
  }

  console.log(
    dryRun
      ? "\nDry run complete — nothing was written."
      : "\nMigration complete. ./dev-data is now redundant; keep it as a backup or delete it.",
  );
}

main().catch((err) => {
  console.error("\nMigration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
