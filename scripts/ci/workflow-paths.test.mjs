import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { citations, DOC } from "./parity-tests.mjs";
import { LOCK, parseLock } from "./promises.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const workflow = (name) => readFileSync(join(REPO, ".github/workflows", name), "utf8").replace(/\r\n/g, "\n");

function listAfter(lines, start) {
  const indent = lines[start + 1].match(/^ */)[0];
  const items = [];
  for (let at = start + 1; at < lines.length && lines[at].startsWith(`${indent}- `); at++) {
    items.push(JSON.parse(lines[at].slice(indent.length + 2)));
  }
  return items;
}

function triggerPaths(text, event) {
  const lines = text.split("\n");
  const eventAt = lines.indexOf(`  ${event}:`);
  assert.ok(eventAt >= 0, `the workflow runs on ${event}`);
  const pathsAt = lines.findIndex((line, at) => at > eventAt && /^    paths:/.test(line));
  assert.ok(pathsAt > eventAt, `${event} has a paths filter`);
  return listAfter(lines, pathsAt);
}

function changeFilters(text) {
  const lines = text.split("\n");
  const blockAt = lines.findIndex((line) => /^ +filters: \|$/.test(line));
  assert.ok(blockAt >= 0, "the changes job has a paths-filter block");
  const nameIndent = lines[blockAt + 1].match(/^ */)[0];
  const filters = {};
  for (let at = blockAt + 1; at < lines.length && lines[at].startsWith(nameIndent); at++) {
    const name = lines[at].slice(nameIndent.length).match(/^([a-z-]+):$/);
    if (name) filters[name[1]] = listAfter(lines, at);
  }
  return filters;
}

const covers = (outer, inner) => outer === inner || (outer.endsWith("/**") && inner.startsWith(outer.slice(0, -2)));

const globPattern = (glob) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0001").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*").replace(/\u0001/g, "(?:.*/)?")}$`);

function matched(globs, path) {
  let included = false;
  for (const glob of globs) {
    if (glob.startsWith("!") ? globPattern(glob.slice(1)).test(path) : globPattern(glob).test(path)) included = !glob.startsWith("!");
  }
  return included;
}

function assertTriggersMatchFilters(triggers, filters, own) {
  const globs = Object.values(filters).flat();
  for (const glob of globs) {
    assert.ok(triggers.some((trigger) => covers(trigger, glob)), `a change to ${glob} starts the workflow`);
  }
  for (const trigger of triggers.filter((trigger) => trigger !== own)) {
    assert.ok(globs.some((glob) => covers(trigger, glob)), `${trigger} starts the workflow for a job that reads it`);
  }
  assert.equal(new Set(triggers).size, triggers.length, "no trigger path is listed twice");
}

function filesUnder(dir, pick) {
  if (!existsSync(join(REPO, dir))) return [];
  return readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "__pycache__" ? [] : filesUnder(path, pick);
    return pick(entry.name) ? [path] : [];
  });
}

const REPO_PATH = /['"`](?:\.\.\/)*((?:apps|packages|engine|docs|infra|\.claude)\/[A-Za-z0-9_.@/-]+)['"`]/g;

function repoPathsNamedIn(files, root = REPO) {
  const named = new Set();
  for (const file of files) {
    for (const [, path] of readFileSync(join(root, file), "utf8").matchAll(REPO_PATH)) {
      const clean = path.replace(/\/+$/, "");
      if (clean.split("/").includes("node_modules")) continue;
      if (existsSync(join(root, clean))) named.add(statSync(join(root, clean)).isDirectory() ? `${clean}/` : clean);
    }
  }
  return [...named].sort();
}

function assertRepoJobStartsOnNamedPaths(repo, files, root = REPO) {
  for (const path of repoPathsNamedIn(files, root)) {
    const probe = path.endsWith("/") ? `${path}any` : path;
    assert.ok(matched(repo, probe), `a change to ${path}, which a root test names, runs the repository job`);
  }
}

const IMPORT = /(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

function relativeImports(entries) {
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const [, spec] of readFileSync(join(REPO, path), "utf8").matchAll(IMPORT)) {
      const target = posix.normalize(posix.join(posix.dirname(path), spec));
      const found = [target, `${target}.ts`, `${target}.mjs`, `${target}.js`, `${target}/index.ts`].find((candidate) => existsSync(join(REPO, candidate)) && statSync(join(REPO, candidate)).isFile());
      if (found && /\.(?:[cm]?[jt]s)$/.test(found)) visit(found);
      else if (found) seen.add(found);
    }
  };
  entries.forEach(visit);
  return [...seen].sort();
}

test("Checks starts on the paths its jobs read, the same on pull requests and on main", () => {
  const text = workflow("checks.yml");
  const filters = changeFilters(text);
  assert.deepEqual(Object.keys(filters).sort(), ["browser", "code", "repo"]);
  assertTriggersMatchFilters(triggerPaths(text, "pull_request"), filters, ".github/workflows/checks.yml");
  assert.match(text, /^  push:\n    branches: \[main\]\n    paths: \*inputs$/m);
});

test("every Checks job runs when its filter matches, when the filter can't tell and when the changes job fails", () => {
  const text = workflow("checks.yml");
  for (const name of ["code", "browser", "repo"]) {
    const fallback = `      ${name}: \${{ steps.filter.outcome != 'success' || steps.filter.outputs.${name} == 'true' }}`;
    assert.ok(text.includes(fallback), `${name} falls back to running`);
  }
  const jobs = text.split(/\n  (?=[a-z0-9-]+:\n)/).slice(1);
  const downstream = jobs.filter((job) => /\n    needs: changes\n/.test(job));
  assert.equal(downstream.length, 3, "three jobs wait on the changes job");
  for (const job of downstream) {
    const name = job.match(/^[a-z0-9-]+/)[0];
    assert.match(
      job,
      /\n    if: \$\{\{ !cancelled\(\) && \(needs\.changes\.result != 'success' \|\| needs\.changes\.outputs\.(code|browser|repo) == 'true'\) \}\}\n/,
      `${name} runs when the changes job failed or timed out`,
    );
    assert.match(
      job,
      /\n    concurrency:\n      group: checks-(code|browser-\$\{\{ matrix\.shard \}\}|repo)-\$\{\{ github\.ref \}\}\n      cancel-in-progress: true\n/,
      `${name} cancels only superseded runs of the same job on main`,
    );
  }
  assert.match(text, /\nconcurrency:\n  group: checks-\$\{\{ github\.event_name == 'pull_request' && github\.ref \|\| github\.run_id \}\}\n  cancel-in-progress: true\n/);
  assert.match(text, /- id: filter\n        if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.changed_files < 3000\n        continue-on-error: true\n/);
});

test("Checks' code filter covers every site file the meadow check builds from", () => {
  const meadow = readFileSync(join(REPO, "packages/shaders/scripts/meadow.mjs"), "utf8");
  const entries = [...meadow.matchAll(/join\(site, "([^"]+\.(?:ts|mjs))"\)/g)].map(([, path]) => `apps/site/src/${path}`);
  assert.ok(entries.length >= 2, "meadow.mjs still names its site entry points");
  const code = changeFilters(workflow("checks.yml")).code;
  for (const path of relativeImports(entries)) assert.ok(matched(code, path), `a change to ${path} runs the meadow check`);
  for (const [, dir] of meadow.matchAll(/join\(site, "([^".]+)"\)/g)) {
    assert.ok(matched(code, `apps/site/src/${dir}/any`), `a change under apps/site/src/${dir} runs the meadow check`);
  }
});

test("Linux starts on every repository file its fixture suites read", () => {
  const suites = ["engine/ardiacore-linux/tests", "engine/patches/build/tests", "engine/chromium/src/chrome/browser/ardia/tests", "scripts/linux", "apps/desktop/scripts"];
  const files = suites.flatMap((dir) => filesUnder(dir, (name) => /\.(?:py|mjs|sh)$/.test(name)));
  const triggers = triggerPaths(workflow("linux.yml"), "pull_request");
  const named = repoPathsNamedIn(files);
  assert.ok(named.length > 20, "the suites still name the files they read");
  for (const path of named) {
    const probe = path.endsWith("/") ? `${path}any` : path;
    assert.ok(matched(triggers, probe), `a change to ${path} starts linux.yml`);
  }
  assert.match(workflow("linux.yml"), /^  push:\n    branches: \[main\]\n    paths: \*linux$/m);
});

test("the repository job starts on every test test:root runs and every repository file those tests name", () => {
  const script = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts["test:root"];
  const globs = script.split("--test")[1].trim().split(/\s+/).map((token) => token.replace(/^"|"$/g, ""));
  const repo = changeFilters(workflow("checks.yml")).repo;
  const runs = globs.flatMap((glob) => {
    const fixed = glob.split("/").findIndex((part) => part.includes("*"));
    const dir = fixed < 0 ? posix.dirname(glob) : glob.split("/").slice(0, fixed).join("/");
    return filesUnder(dir, () => true).filter((path) => globPattern(glob).test(path));
  });
  assert.ok(runs.length > 10, "test:root still finds its tests");
  for (const path of runs) assert.ok(matched(repo, path), `a change to ${path} runs the repository job`);
  assertRepoJobStartsOnNamedPaths(repo, runs);
});

test("the repository job isn't asked to start on a folder an install adds under a path a root test names", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-paths-"));
  try {
    mkdirSync(join(root, "apps/desktop/node_modules/real"), { recursive: true });
    mkdirSync(join(root, "apps/desktop/scripts"), { recursive: true });
    writeFileSync(join(root, "apps/desktop/scripts/host-tests.mjs"), "");
    writeFileSync(join(root, "named.test.mjs"), 'const files = ["apps/desktop/node_modules", "apps/desktop/node_modules/real", "apps/desktop/scripts/host-tests.mjs"];\n');
    const repo = changeFilters(workflow("checks.yml")).repo;
    assertRepoJobStartsOnNamedPaths(repo, ["named.test.mjs"], root);
    assert.deepEqual(repoPathsNamedIn(["named.test.mjs"], root), ["apps/desktop/scripts/host-tests.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repository job starts on the parity doc, the promises lock and every test either one cites", () => {
  const repo = changeFilters(workflow("checks.yml")).repo;
  const locked = parseLock(readFileSync(join(REPO, LOCK), "utf8")).map((promise) => promise.file);
  const cited = citations(readFileSync(join(REPO, DOC), "utf8")).found.map((citation) => citation.file);
  assert.ok(locked.length > 50 && cited.length > 50, "the lock and the doc still name their tests");
  for (const path of [DOC, LOCK, ...locked, ...cited]) assert.ok(matched(repo, path), `a change to ${path} runs the repository job`);
});

test("Mac starts on the paths its jobs read, and its Swift tests run for the plugin sandbox, archive and import readers", () => {
  const text = workflow("mac.yml");
  const filters = changeFilters(text);
  assert.deepEqual(Object.keys(filters).sort(), ["app", "swift", "webui"]);
  assertTriggersMatchFilters(triggerPaths(text, "pull_request"), filters, ".github/workflows/mac.yml");
  assert.match(text, /^  push:\n    branches: \[main\]\n    paths: \*native$/m);
  for (const path of [
    "packages/shell/ios/PluginCore/PluginSandbox.swift",
    "packages/shell/ios/PluginProcess.swift",
    "packages/shell/plugin-tests/PluginSandboxEscapeTests.swift",
    "packages/import/ios/Core/ZipArchive.swift",
  ]) {
    assert.ok(existsSync(join(REPO, path)), `${path} exists`);
    assert.ok(matched(filters.swift, path), `a change to ${path} runs the Swift tests`);
  }
  const suites = filesUnder("packages/shell/plugin-tests", (name) => name.endsWith(".swift"));
  const read = new Set();
  for (const file of suites) {
    for (const [, path] of readFileSync(join(REPO, file), "utf8").matchAll(/"(?:\.\.\/)+((?:scripts|apps|docs)\/[A-Za-z0-9_./-]+)"/g)) read.add(path);
  }
  assert.ok(read.size >= 3, "the plugin tests still name the repository files they read");
  for (const path of read) assert.ok(matched(filters.swift, path), `a change to ${path}, which the plugin tests read, runs the Swift tests`);
  for (const name of ["app", "swift", "webui"]) {
    assert.ok(text.includes(`      ${name}: \${{ steps.filter.outcome != 'success' || steps.filter.outputs.${name} == 'true' }}`), `${name} falls back to running`);
    assert.match(text, new RegExp(`\\(needs\\.changes\\.result != 'success' \\|\\| needs\\.changes\\.outputs\\.${name} == 'true'\\)`), `${name} runs when the changes job failed`);
  }
});

test("the conventions check runs on every pull request and push to main, with no paths filter and no install", () => {
  const text = workflow("conventions.yml");
  assert.match(text, /^on:\n  pull_request:\n  push:\n    branches: \[main\]\n\n/m, "no paths filter, so a file in a new folder is checked too");
  assert.match(text, /\n        run: node apps\/browser\/src\/conventions\.test\.mjs\n/);
  assert.doesNotMatch(text, /pnpm install|npm ci|paths:/);
});

test("the weekly expiry run lists skips past their date in its summary, without an install", () => {
  const text = workflow("expiring-skips.yml");
  assert.match(text, /^  schedule:\n    - cron: "[^"]+"\n  workflow_dispatch:\n/m);
  assert.match(text, /\n        run: node apps\/browser\/src\/conventions\.test\.mjs --expired --summary "\$GITHUB_STEP_SUMMARY"\n/);
  assert.doesNotMatch(text, /pnpm install|npm ci/);
});

test("Deploy starts on main only for the paths one of its services deploys from", () => {
  const text = workflow("deploy.yml");
  assertTriggersMatchFilters(triggerPaths(text, "push"), changeFilters(text), ".github/workflows/deploy.yml");
});

test("the path globs these tests use read like GitHub's", () => {
  assert.ok(matched(["packages/*/src/**", "!packages/phone/**"], "packages/core/src/a.ts"));
  assert.ok(!matched(["packages/*/src/**", "!packages/phone/**"], "packages/phone/src/a.ts"));
  assert.ok(!matched(["packages/*/package.json"], "packages/core/src/package.json"));
  assert.ok(matched(["**/*.test.*"], "example.test.mjs"));
  assert.ok(matched(["**/*.test.*"], "apps/browser/src/a/b.test.mjs"));
  assert.ok(!matched(["**/*.test.*"], "apps/browser/src/a/b.mjs"));
  const repo = changeFilters(workflow("checks.yml")).repo;
  for (const path of ["apps/phone/android/app/src/test/java/com/ardia/browser/android/ShareSheetTest.kt", "apps/phone/test/release/a.test.sh", "engine/x/tests/test_a.py", "packages/shell/tests/ATests.swift"]) assert.ok(matched(repo, path), `a change to ${path} runs the repository job`);
  assert.equal(relative(REPO, dirname(fileURLToPath(import.meta.url))), "scripts/ci");
});
