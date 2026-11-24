#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { REPO } from "./lib/repo.mjs";
import { clickhouse, run, TABLE } from "./symbols/job.mjs";
import { SymbolStore } from "./symbols/releases.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `Names the native frames of recent Mac crashes and app_freeze events and stores them in ClickHouse
(sandbox.${TABLE}), where the dashboard's Errors and Freezes views read them.

  node scripts/symbolicate-frames.mjs [--days <n>] [--dry-run] [--cache <dir>] [--maps <dir>]... [--repo <owner/name>]

Every frame keeps its image's UUID (crash_images, freeze_images). For each UUID it hasn't named yet it finds the
release whose *-uuids.txt lists it (engine-<key:12> for Chromium Framework and its helpers, v<version> for Ardia),
downloads that release's *-symbols.tar.xz, unpacks only that image's DWARF file and reads its symbol table (no atos,
so it runs on Linux too: tar and xz, plus swift-demangle and c++filt when present to demangle names). A release may
also carry *-symbol-map.tsv.gz, a ready map for a build without a dSYM (scripts/symbols/name-stripped-build.mjs);
--maps adds a folder of such maps. Maps are cached per UUID in --cache (default dist/frame-symbols).

A frame with no symbols is stored as source "none", one named from a match map as "match", and a frame outside every named function of
its image as "outside"; all three are tried again after a day, so a dSYM published later replaces them. Names come from the function that holds the offset, written "<function> + <bytes>".

Environment: CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD read telemetry.events (the reader user);
TRIAGE_CLICKHOUSE_PASSWORD (with TRIAGE_CLICKHOUSE_URL, TRIAGE_CLICKHOUSE_USER, TRIAGE_CLICKHOUSE_DATABASE, defaulting
to CLICKHOUSE_URL, sandbox, sandbox) writes the names; GITHUB_TOKEN raises GitHub's rate limit. --dry-run writes
nothing and prints what it would store; it needs only the reader.`;

const { values } = parseArgs({
  options: {
    days: { type: "string", default: "14" },
    "dry-run": { type: "boolean", default: false },
    cache: { type: "string", default: join(root, "dist/frame-symbols") },
    maps: { type: "string", multiple: true, default: [] },
    repo: { type: "string", default: process.env.GITHUB_REPOSITORY || REPO },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const env = process.env;
const reader = clickhouse({ url: env.CLICKHOUSE_URL, user: env.CLICKHOUSE_USER, password: env.CLICKHOUSE_PASSWORD });
if (!reader) {
  console.error("error: set CLICKHOUSE_URL, CLICKHOUSE_USER and CLICKHOUSE_PASSWORD (the telemetry reader) (--help)");
  process.exit(1);
}
const sandbox = clickhouse({
  url: env.TRIAGE_CLICKHOUSE_URL || env.CLICKHOUSE_URL,
  user: env.TRIAGE_CLICKHOUSE_USER || "sandbox",
  password: env.TRIAGE_CLICKHOUSE_PASSWORD,
});
const log = (line) => console.error(line);
const store = new SymbolStore({ cache: resolve(values.cache), repo: values.repo, token: env.GITHUB_TOKEN, mapDirs: values.maps.map((d) => resolve(d)), log });

try {
  const { rows, summary } = await run({
    reader,
    sandbox,
    db: env.TRIAGE_CLICKHOUSE_DATABASE || "sandbox",
    store,
    days: Number(values.days),
    dryRun: values["dry-run"],
    log,
  });
  if (values["dry-run"]) for (const r of rows) console.log(`${r.image}\t${r.uuid}\t0x${r.offset.toString(16)}\t${r.source}\t${r.symbol ? `${r.symbol} + ${r.symbol_offset}` : ""}`);
  const named = rows.filter((r) => r.symbol).length;
  const report = [
    `Named ${named} of ${rows.length} new frames${values["dry-run"] ? " (dry run, nothing written)" : ""}.`,
    `By source: ${JSON.stringify(summary.bySource)}. By image: ${JSON.stringify(summary.byImage)}.`,
    summary.buildsWithoutSymbols.length ? `Builds without symbols: ${summary.buildsWithoutSymbols.join(", ")}.` : "Every build had symbols.",
  ].join("\n");
  console.error(report);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${report.replace(/\n/g, "\n\n")}\n`);
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
