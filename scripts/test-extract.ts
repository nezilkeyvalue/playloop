#!/usr/bin/env tsx
// scripts/test-extract.ts
//
// Runs the extraction ladder (lib/engine/extract) against real brand sites
// and prints a pass/fail table plus an overall success rate. Build spec
// §20: "Run the extractor against 20 real brand sites and record the
// success rate... the highest-value hour in the whole build."
//
// Deliberately exercises extraction only (not sprites/quality/matching/AI)
// — the question that actually matters before a demo is "does the source
// ladder find products on a real site", which this answers directly and
// fast, without spending time on sharp/Gemini calls per site.
//
// Usage: npm run test:extract
//
// NOTE for whoever runs this first: it was written and reviewed carefully
// but could not be executed in the build sandbox (no npm registry access,
// nothing installed) — run it for real once dependencies are installed,
// and expect to prune/replace a few sample-sites.json entries once you see
// which ones block scraping (that's the point of the exercise).

import { readFileSync } from "node:fs";
import path from "node:path";
import { extractFromUrl } from "../lib/engine/extract";

interface SampleSite {
  url: string;
  expectedMinAssets: number;
  note?: string;
}

interface ResultRow {
  url: string;
  ok: boolean;
  assetCount: number;
  expected: number;
  platform?: string;
  ms: number;
  error?: string;
}

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

async function main(): Promise<void> {
  const samplesPath = path.join(process.cwd(), "scripts", "sample-sites.json");
  const sites: SampleSite[] = JSON.parse(readFileSync(samplesPath, "utf-8"));

  console.log(`${BOLD}PlayLoop extractor reliability check${RESET} — ${sites.length} sites\n`);

  const rows: ResultRow[] = [];

  for (const site of sites) {
    const started = Date.now();
    try {
      const { inventory } = await extractFromUrl(site.url);
      const row: ResultRow = {
        url: site.url,
        ok: inventory.assets.length >= site.expectedMinAssets,
        assetCount: inventory.assets.length,
        expected: site.expectedMinAssets,
        platform: inventory.source.platform,
        ms: Date.now() - started,
      };
      rows.push(row);
      printRow(row);
    } catch (err) {
      const row: ResultRow = {
        url: site.url,
        ok: false,
        assetCount: 0,
        expected: site.expectedMinAssets,
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
      rows.push(row);
      printRow(row);
    }
  }

  const passed = rows.filter((r) => r.ok).length;
  const rate = rows.length > 0 ? ((passed / rows.length) * 100).toFixed(0) : "0";

  console.log("");
  console.log(`${BOLD}${passed}/${rows.length} sites passed (${rate}%)${RESET}`);

  const failed = rows.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(`\n${YELLOW}Failed sites:${RESET}`);
    for (const r of failed) {
      const reason = r.error ?? `found ${r.assetCount}, needed ${r.expected}`;
      console.log(`  ${RED}x${RESET} ${r.url} - ${reason}`);
    }
  }
}

function printRow(row: ResultRow): void {
  const mark = row.ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const platform = row.platform ? ` ${DIM}[${row.platform}]${RESET}` : "";
  const detail = row.error ? `${RED}${row.error}${RESET}` : `${row.assetCount} assets (needed ${row.expected})`;
  const url = row.url.length >= 42 ? row.url.slice(0, 41) : row.url.padEnd(42);
  console.log(`${mark}  ${url}${platform}  ${detail}  ${DIM}${row.ms}ms${RESET}`);
}

main().catch((err) => {
  console.error("test-extract failed to run:", err);
  process.exitCode = 1;
});
