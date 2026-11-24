import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, plan, pullNumberOf, sweep } from "./prune-caches.mjs";

const cache = (id, key, ref, createdAt) => ({ id, key, ref, size: 100, createdAt });
const MAIN = "refs/heads/main";

test("a pull request ref names its number; a branch names none", () => {
  assert.equal(pullNumberOf("refs/pull/1116/merge"), 1116);
  assert.equal(pullNumberOf(MAIN), null);
  assert.equal(pullNumberOf("refs/pull/7/head"), null);
});

test("the caches of closed pull requests go; those of open ones and of branches stay", () => {
  const caches = [
    cache(1, "node-cache-Windows-x64-pnpm-aa", "refs/pull/10/merge", "2026-11-01T00:00:00Z"),
    cache(2, "node-cache-Windows-x64-pnpm-aa", "refs/pull/11/merge", "2026-11-02T00:00:00Z"),
    cache(3, "node-cache-Windows-x64-pnpm-aa", MAIN, "2026-11-03T00:00:00Z"),
  ];
  const doomed = plan({ caches, openPulls: [11], newestOnly: [] });
  assert.deepEqual(doomed.map((item) => item.id), [1]);
  assert.match(doomed[0].why, /#10 is closed/);
});

test("a newest-only prefix keeps its newest cache and nothing of another prefix is touched", () => {
  const caches = [
    cache(1, "xcode-cas-release-27A-2026-11-aaa", MAIN, "2026-11-01T00:00:00Z"),
    cache(2, "xcode-cas-release-27A-2026-11-bbb", MAIN, "2026-11-05T00:00:00Z"),
    cache(3, "xcode-cas-release-27A-2026-11-ccc", MAIN, "2026-11-03T00:00:00Z"),
    cache(4, "pods-abc", MAIN, "2026-10-01T00:00:00Z"),
    cache(5, "pods-def", MAIN, "2026-10-02T00:00:00Z"),
  ];
  const doomed = plan({ caches, openPulls: [], newestOnly: ["xcode-cas-release-"] });
  assert.deepEqual(doomed.map((item) => item.id).sort(), [1, 3]);
});

test("the newest cache is chosen among those that survive the closed pull requests", () => {
  const caches = [
    cache(1, "swiftpm-xcode-27.1-aaa", MAIN, "2026-11-01T00:00:00Z"),
    cache(2, "swiftpm-xcode-27.1-bbb", "refs/pull/9/merge", "2026-11-09T00:00:00Z"),
  ];
  const doomed = plan({ caches, openPulls: [], newestOnly: ["swiftpm-xcode-"] });
  assert.deepEqual(doomed.map((item) => item.id), [2]);
});

test("nothing is listed twice", () => {
  const caches = [
    cache(1, "turbo-aaa", "refs/pull/9/merge", "2026-11-01T00:00:00Z"),
    cache(2, "turbo-bbb", MAIN, "2026-11-02T00:00:00Z"),
    cache(3, "turbo-ccc", MAIN, "2026-11-03T00:00:00Z"),
  ];
  const doomed = plan({ caches, openPulls: [], newestOnly: ["turbo-", "turbo-"] });
  assert.deepEqual(doomed.map((item) => item.id).sort(), [1, 2]);
});

test("each branch keeps its own newest cache, since main cannot restore a branch's", () => {
  const caches = [
    cache(1, "xcode-cas-release-27A-2026-11-aaa", MAIN, "2026-11-01T00:00:00Z"),
    cache(2, "xcode-cas-release-27A-2026-11-bbb", MAIN, "2026-11-02T00:00:00Z"),
    cache(3, "xcode-cas-release-27A-2026-11-ccc", "refs/heads/release-dry-run", "2026-11-05T00:00:00Z"),
  ];
  const doomed = plan({ caches, openPulls: [], newestOnly: ["xcode-cas-release-"] });
  assert.deepEqual(doomed.map((item) => item.id), [1]);
});

test("a main-only prefix deletes its caches outside main, open pull requests included, and leaves main's to newest-only", () => {
  const caches = [
    cache(1, "gradle-phone-aaa", "refs/pull/12/merge", "2026-11-01T00:00:00Z"),
    cache(2, "gradle-phone-bbb", "refs/heads/feature", "2026-11-02T00:00:00Z"),
    cache(3, "gradle-phone-ccc", MAIN, "2026-11-03T00:00:00Z"),
    cache(4, "gradle-phone-ddd", MAIN, "2026-11-04T00:00:00Z"),
    cache(5, "turbo-aaa", "refs/pull/12/merge", "2026-11-05T00:00:00Z"),
  ];
  const doomed = plan({ caches, openPulls: [12], newestOnly: ["gradle-phone-"], mainOnly: ["gradle-phone-"] });
  assert.deepEqual(doomed.map((item) => item.id).sort(), [1, 2, 3]);
  assert.match(doomed.find((item) => item.id === 1).why, /only refs\/heads\/main keeps gradle-phone- caches/);
});

test("--main-only needs a key prefix", () => {
  const script = fileURLToPath(new URL("./prune-caches.mjs", import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [script, "--main-only"], { stdio: "pipe" }), /--main-only takes a key prefix/);
});

test("an option that takes a value refuses a missing one or the next flag", () => {
  for (const flag of ["--repo", "--newest-only", "--main-only", "--drop-prefix"]) {
    assert.throws(() => parse([flag], {}), new RegExp(`${flag} takes`), `${flag} at the end`);
    assert.throws(() => parse([flag, "--dry-run"], {}), new RegExp(`${flag} takes`), `${flag} before --dry-run`);
    assert.throws(() => parse([flag, "-h"], {}), new RegExp(`${flag} takes`), `${flag} before -h`);
  }
  const options = parse(["--main-only", "gradle-phone-", "--dry-run", "--drop-prefix", "ardia-test-tsx-1-of-8-", "--repo", "o/r"], {});
  assert.deepEqual(
    { mainOnly: options.mainOnly, dropPrefixes: options.dropPrefixes, dryRun: options.dryRun, repo: options.repo },
    { mainOnly: ["gradle-phone-"], dropPrefixes: ["ardia-test-tsx-1-of-8-"], dryRun: true, repo: "o/r" },
  );
});

test("a drop prefix deletes its caches on every branch and leaves keys that only share a stem", () => {
  const caches = [
    cache(1, "ardia-test-tsx-1-of-8-aaa-1", MAIN, "2026-11-01T00:00:00Z"),
    cache(2, "ardia-test-tsx-8-of-8-aaa-2", "refs/pull/12/merge", "2026-11-02T00:00:00Z"),
    cache(3, "ardia-test-tsx-1-of-3-aaa-sha", MAIN, "2026-11-03T00:00:00Z"),
    cache(4, "ardia-test-tsx-3-of-3-aaa-sha", "refs/heads/feature", "2026-11-04T00:00:00Z"),
    cache(5, "ardia-test-tsx-1-of-6-aaa-sha", MAIN, "2026-11-05T00:00:00Z"),
    cache(6, "ardia-test-tsx-6-of-6-aaa-sha", "refs/heads/feature", "2026-11-06T00:00:00Z"),
  ];
  const dropPrefixes = [8, 3].flatMap((total) => Array.from({ length: total }, (_, index) => `ardia-test-tsx-${index + 1}-of-${total}-`));
  const doomed = plan({ caches, openPulls: [12], newestOnly: [], dropPrefixes });
  assert.deepEqual(doomed.map((item) => item.id).sort(), [1, 2, 3, 4]);
  for (const item of doomed) assert.match(item.why, /no workflow makes ardia-test-tsx-\d-of-[38]- caches any more/);
});

test("a cache that is already gone counts as freed, and one failed delete does not stop the rest", () => {
  const doomed = [cache(1, "a", MAIN, "x"), cache(2, "b", MAIN, "x"), cache(3, "c", MAIN, "x"), cache(4, "d", MAIN, "x")];
  const tried = [];
  const outcome = sweep(doomed, (entry) => {
    tried.push(entry.id);
    if (entry.id === 2) throw Object.assign(new Error("Command failed"), { stderr: "gh: Not Found (HTTP 404)" });
    if (entry.id === 3) throw Object.assign(new Error("Command failed"), { stderr: "gh: Server Error (HTTP 502)" });
  });
  assert.deepEqual(tried, [1, 2, 3, 4]);
  assert.deepEqual(outcome.deleted.map((entry) => entry.id), [1, 4]);
  assert.deepEqual(outcome.gone.map((entry) => entry.id), [2]);
  assert.deepEqual(outcome.failed.map((entry) => [entry.id, entry.error]), [[3, "gh: Server Error (HTTP 502)"]]);
});

test("the script still runs when it is started through a symlinked path", () => {
  const link = join(mkdtempSync(join(tmpdir(), "prune-caches-")), "prune.mjs");
  symlinkSync(fileURLToPath(new URL("./prune-caches.mjs", import.meta.url)), link);
  assert.match(execFileSync(process.execPath, [link, "--help"], { encoding: "utf8" }), /Frees GitHub Actions cache space/);
});
