#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HELP = `Frees GitHub Actions cache space, which is capped at 10 GB a repository.
Deletes the caches of pull requests that are no longer open, for each --drop-prefix key
prefix every cache on every branch (a key no workflow makes any more), for each --main-only
key prefix every cache outside main (open pull requests too: a cache only main should save),
and for each --newest-only key prefix every cache but the newest one of each branch, since
a branch cannot restore another branch's cache.

  scripts/ci/prune-caches.mjs [--dry-run] [--repo <owner/name>] [--drop-prefix <key prefix>]...
                              [--main-only <key prefix>]... [--newest-only <key prefix>]...

--dry-run lists what would go and deletes nothing.`;

const PULL_REF = /^refs\/pull\/(\d+)\/merge$/;
export const MAIN_REF = "refs/heads/main";

export function pullNumberOf(ref) {
  const found = PULL_REF.exec(ref || "");
  return found ? Number(found[1]) : null;
}

export function plan({ caches, openPulls, newestOnly, mainOnly = [], dropPrefixes = [] }) {
  const open = new Set(openPulls);
  const doomed = new Map();
  for (const cache of caches) {
    const number = pullNumberOf(cache.ref);
    if (number !== null && !open.has(number)) doomed.set(cache.id, { ...cache, why: `pull request #${number} is closed` });
  }
  for (const prefix of dropPrefixes) {
    for (const cache of caches) {
      if (cache.key.startsWith(prefix) && !doomed.has(cache.id)) doomed.set(cache.id, { ...cache, why: `no workflow makes ${prefix} caches any more` });
    }
  }
  for (const prefix of mainOnly) {
    for (const cache of caches) {
      if (cache.key.startsWith(prefix) && cache.ref !== MAIN_REF && !doomed.has(cache.id)) {
        doomed.set(cache.id, { ...cache, why: `only ${MAIN_REF} keeps ${prefix} caches` });
      }
    }
  }
  for (const prefix of newestOnly) {
    const newestFirst = caches
      .filter((cache) => cache.key.startsWith(prefix) && !doomed.has(cache.id))
      .sort((one, other) => other.createdAt.localeCompare(one.createdAt) || other.id - one.id);
    const refsWithANewerCache = new Set();
    for (const cache of newestFirst) {
      if (refsWithANewerCache.has(cache.ref)) doomed.set(cache.id, { ...cache, why: `${cache.ref} has a newer ${prefix} cache` });
      refsWithANewerCache.add(cache.ref);
    }
  }
  return [...doomed.values()];
}

export function sweep(doomed, remove) {
  const outcome = { deleted: [], gone: [], failed: [] };
  for (const cache of doomed) {
    try {
      remove(cache);
      outcome.deleted.push(cache);
    } catch (error) {
      if (/\b404\b|Not Found/.test(`${error.stderr || ""}${error.message || ""}`)) outcome.gone.push(cache);
      else outcome.failed.push({ ...cache, error: String(error.stderr || error.message || error).trim() });
    }
  }
  return outcome;
}

export function parse(argv, env = process.env) {
  const options = { dryRun: false, repo: env.GITHUB_REPOSITORY || "", newestOnly: [], mainOnly: [], dropPrefixes: [], help: false };
  const valueAfter = (index, what) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`${argv[index]} takes ${what}`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (word === "-h" || word === "--help") options.help = true;
    else if (word === "--dry-run") options.dryRun = true;
    else if (word === "--repo") options.repo = valueAfter(index++, "<owner/name>");
    else if (word === "--newest-only") options.newestOnly.push(valueAfter(index++, "a key prefix"));
    else if (word === "--main-only") options.mainOnly.push(valueAfter(index++, "a key prefix"));
    else if (word === "--drop-prefix") options.dropPrefixes.push(valueAfter(index++, "a key prefix"));
    else throw new Error(`unknown option ${word} (--help)`);
  }
  return options;
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function listCaches(repo) {
  const rows = gh(["api", "--paginate", `repos/${repo}/actions/caches?per_page=100`, "--jq", ".actions_caches[] | @json"]);
  return rows
    .split("\n")
    .filter(Boolean)
    .map((row) => JSON.parse(row))
    .map((cache) => ({ id: cache.id, ref: cache.ref, key: cache.key, size: cache.size_in_bytes, createdAt: cache.created_at }));
}

function listOpenPulls(repo) {
  const rows = gh(["api", "--paginate", `repos/${repo}/pulls?state=open&per_page=100`, "--jq", ".[].number"]);
  return rows.split("\n").filter(Boolean).map(Number);
}

const megabytes = (bytes) => `${Math.round(bytes / 1e6)} MB`;

function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (!options.repo) options.repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  const caches = listCaches(options.repo);
  const doomed = plan({ caches, openPulls: listOpenPulls(options.repo), newestOnly: options.newestOnly, mainOnly: options.mainOnly, dropPrefixes: options.dropPrefixes });
  const total = caches.reduce((sum, cache) => sum + cache.size, 0);
  const sizeOf = (list) => list.reduce((sum, cache) => sum + cache.size, 0);
  for (const cache of doomed) console.log(`${options.dryRun ? "would delete" : "delete"} ${cache.key} (${megabytes(cache.size)}, ${cache.ref}): ${cache.why}`);
  if (options.dryRun) {
    console.log(`${options.repo}: ${caches.length} caches, ${megabytes(total)}; would free ${megabytes(sizeOf(doomed))} in ${doomed.length}, leaving ${megabytes(total - sizeOf(doomed))}`);
    return;
  }
  const outcome = sweep(doomed, (cache) => gh(["api", "-X", "DELETE", `repos/${options.repo}/actions/caches/${cache.id}`]));
  for (const cache of outcome.gone) console.log(`already gone: ${cache.key} (${cache.ref})`);
  for (const cache of outcome.failed) console.error(`could not delete ${cache.key} (${cache.ref}): ${cache.error}`);
  const freed = sizeOf(outcome.deleted) + sizeOf(outcome.gone);
  console.log(`${options.repo}: ${caches.length} caches, ${megabytes(total)}; freed ${megabytes(freed)} in ${outcome.deleted.length + outcome.gone.length}, leaving ${megabytes(total - freed)}`);
  if (outcome.failed.length) throw new Error(`${outcome.failed.length} of ${doomed.length} caches could not be deleted`);
}

const invokedAs = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedAs === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
