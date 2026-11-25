#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findTests, hashOf, languageOf, pickTest } from "./test-source.mjs";

const HELP = `Holds the regression tests that guard closed bugs to what they were when the bug closed.
scripts/ci/promises.lock has one line per promise: the closed issue, the hash of the test's
source and of what it runs under (the loop, describe or condition around it; whitespace,
comments, trailing commas and quote style don't count), the test file and the test's name
(its describe path, outer › inner, when the name alone is not unique). The check fails when
a locked test is deleted, renamed or changed.

  scripts/ci/promises.mjs                        check every promise
  scripts/ci/promises.mjs --update <issue>       record the current hash of the issue's tests
  scripts/ci/promises.mjs --add <issue> <file> <test name>
                                                 lock one more test for a closed issue

A test that moved or was renamed: edit its file or name in the lock, then --update the issue.
A promise that no longer holds: delete its line and say why in the pull request.`;

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const LOCK = "scripts/ci/promises.lock";
const HEADER = ["issue", "hash", "file", "test"].join("\t");

export function parseLock(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((line) => line.length);
  if (lines[0] !== HEADER) throw new Error(`${LOCK} starts with the header line: ${HEADER.replace(/\t/g, "\\t")}`);
  return lines.slice(1).map((line, index) => {
    const fields = line.split("\t");
    if (fields.length !== 4) throw new Error(`${LOCK}:${index + 2}: four tab-separated fields`);
    const [issue, hash, file, test] = fields;
    if (!/^[1-9][0-9]*$/.test(issue)) throw new Error(`${LOCK}:${index + 2}: issue is a number`);
    if (!/^[0-9a-f]{16}$/.test(hash)) throw new Error(`${LOCK}:${index + 2}: hash is 16 hex digits`);
    return { issue: Number(issue), hash, file, test };
  });
}

const order = (a, b) => a.issue - b.issue || a.file.localeCompare(b.file) || a.test.localeCompare(b.test);

export function formatLock(promises) {
  return `${[HEADER, ...[...promises].sort(order).map((p) => [p.issue, p.hash, p.file, p.test].join("\t"))].join("\n")}\n`;
}

export function readSource(root, file) {
  const path = join(root, file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function locate(root, promise, cache = new Map()) {
  if (!languageOf(promise.file)) return { error: "is not a JavaScript, TypeScript or Swift file" };
  if (!cache.has(promise.file)) {
    const source = readSource(root, promise.file);
    cache.set(promise.file, source === null ? null : findTests(promise.file, source));
  }
  const tests = cache.get(promise.file);
  if (tests === null) return { error: "is gone" };
  const picked = pickTest(tests, promise.test);
  return picked.error ? picked : { hash: hashOf(picked.test) };
}

export function check(root, promises) {
  const problems = [];
  const seen = new Set();
  const cache = new Map();
  for (const promise of promises) {
    const key = `${promise.file}\t${promise.test}`;
    const where = `#${promise.issue} ${promise.file} › "${promise.test}"`;
    if (seen.has(key)) problems.push(`${where}: locked twice`);
    if (!LOCKABLE.test(promise.file)) problems.push(`${where}: only test files (*.test.*, *-test.mjs, *Tests.swift) can be locked`);
    seen.add(key);
    const found = locate(root, promise, cache);
    if (found.error) {
      problems.push(`${where}: ${found.error === "is gone" ? "the file is gone" : found.error}. If it moved or was renamed, fix its line in ${LOCK} and run scripts/ci/promises.mjs --update ${promise.issue}`);
    } else if (found.hash !== promise.hash) {
      problems.push(`${where}: the test changed (${promise.hash} → ${found.hash}). If it still guards the bug, run scripts/ci/promises.mjs --update ${promise.issue} so the review sees the new hash`);
    }
  }
  const sorted = [...promises].sort(order);
  if (sorted.some((promise, index) => promise !== promises[index])) problems.push(`${LOCK} is sorted by issue, file and test; any --update rewrites it in order`);
  return problems;
}

export function update(root, promises, issue) {
  const mine = promises.filter((promise) => promise.issue === issue);
  if (!mine.length) throw new Error(`no promise for #${issue} in ${LOCK}`);
  const cache = new Map();
  return promises.map((promise) => {
    if (promise.issue !== issue) return promise;
    const found = locate(root, promise, cache);
    if (found.error) throw new Error(`#${issue} ${promise.file} › "${promise.test}" ${found.error}; fix its file or name in ${LOCK} first`);
    return { ...promise, hash: found.hash };
  });
}

const LOCKABLE = /(?:^|\/)(?:[^/]+\.test\.[^/]+|[^/]+-test\.mjs|[^/]+Tests\.swift)$/;

export function add(root, promises, issue, file, test) {
  if (!LOCKABLE.test(file)) throw new Error(`${file}: only test files (*.test.*, *-test.mjs, *Tests.swift) can be locked, so Checks' repository job runs when they change`);
  if (promises.some((promise) => promise.file === file && promise.test === test)) throw new Error(`${file} › "${test}" is locked already`);
  const promise = { issue, file, test, hash: "" };
  const found = locate(root, promise);
  if (found.error) throw new Error(`${file} › "${test}": ${found.error}`);
  return [...promises, { ...promise, hash: found.hash }];
}

function main(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const lockPath = join(ROOT, LOCK);
  const promises = parseLock(readFileSync(lockPath, "utf8"));
  if (args[0] === "--update" || args[0] === "--add") {
    const issue = Number(args[1]);
    if (!Number.isInteger(issue) || issue <= 0) throw new Error(`${args[0]} takes an issue number`);
    if (args[0] === "--add" && args.length !== 4) throw new Error("--add takes <issue> <file> <test name>");
    const next = args[0] === "--update" ? update(ROOT, promises, issue) : add(ROOT, promises, issue, args[2], args[3]);
    writeFileSync(lockPath, formatLock(next));
    console.log(`${LOCK}: #${issue} recorded`);
    return 0;
  }
  if (args.length) throw new Error(`unknown arguments: ${args.join(" ")}\n\n${HELP}`);
  const problems = check(ROOT, promises);
  for (const problem of problems) console.error(problem);
  if (!problems.length) console.log(`${promises.length} promises hold`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
