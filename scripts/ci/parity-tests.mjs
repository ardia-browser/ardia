#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findTests, languageOf, pickTest } from "./test-source.mjs";

const HELP = `Checks the tests docs/dia-feature-parity.md cites. A row cites a test as a code span holding
its repo path, \`apps/browser/src/state/peek/peek.test.mjs\`, or one test in it,
\`apps/browser/src/state/peek/peek.test.mjs#test name\`. Every cited file must exist and every
cited test must be in it; a test file named any other way (a bare name, outside a code span)
fails the check.

  scripts/ci/parity-tests.mjs          check the doc
  scripts/ci/parity-tests.mjs --list   print each row's tests: row, file, test (tab-separated)`;

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DOC = "docs/dia-feature-parity.md";

const TEST_FILE = String.raw`(?:[A-Za-z0-9_.@-]+\/)*(?:[A-Za-z0-9_.@-]+(?:\.test\.[A-Za-z0-9]+|-test\.mjs|Tests\.swift)|test_[A-Za-z0-9_]+\.py)`;
const CITED = new RegExp(`^(${TEST_FILE})(?:#(.+))?$`);
const LOOSE = new RegExp(`(?<![A-Za-z0-9_./@-])${TEST_FILE}(?![A-Za-z0-9_])`, "g");
const BARE_SWIFT = /^[A-Z][A-Za-z0-9]*Tests$/;

const CODE_SPAN = /(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;

function spansOf(line) {
  return [...line.matchAll(CODE_SPAN)].map((match) => {
    const body = match[2];
    return /^ .* $/.test(body) && body.trim() ? body.slice(1, -1) : body;
  });
}

function rowOf(line) {
  if (!line.startsWith("|")) return null;
  const cell = line.split("|")[1]?.trim();
  return cell && !/^-+$/.test(cell) ? cell : null;
}

export function citations(text) {
  const found = [];
  const problems = [];
  let heading = null;
  text.split("\n").forEach((line, index) => {
    if (/^#{1,6} /.test(line)) heading = line.replace(/^#+ /, "");
    const at = `${DOC}:${index + 1}`;
    const row = rowOf(line) ?? heading;
    for (const span of spansOf(line)) {
      const cited = CITED.exec(span);
      if (cited) found.push({ at, row, file: cited[1], test: cited[2] ?? null });
      else if (BARE_SWIFT.test(span)) problems.push(`${at}: \`${span}\` names a Swift test class; cite its file's repo path`);
      else if (new RegExp(TEST_FILE).test(span)) problems.push(`${at}: \`${span}\` holds a test file among other text; give it its own code span`);
    }
    for (const [loose] of line.replace(CODE_SPAN, "").matchAll(LOOSE)) problems.push(`${at}: ${loose} is outside a code span; cite it as \`<repo path>\``);
  });
  return { found, problems };
}

export function check(root, text) {
  const { found, problems } = citations(text);
  const cache = new Map();
  for (const { at, file, test } of found) {
    const path = join(root, file);
    const inside = (target) => {
      const offset = relative(realpathSync(root), realpathSync(target));
      return offset && !offset.startsWith("..") && !isAbsolute(offset);
    };
    if (!file.includes("/") || isAbsolute(file) || resolve(root, file) !== path || !existsSync(path) || !statSync(path).isFile() || !inside(path)) {
      problems.push(`${at}: \`${file}\` is not a file in the repo; cite the test by its repo path`);
      continue;
    }
    if (!test) continue;
    if (!languageOf(file)) {
      problems.push(`${at}: \`${file}\` can't be searched for "${test}"; cite the file alone`);
      continue;
    }
    if (!cache.has(file)) cache.set(file, findTests(file, readFileSync(path, "utf8")));
    const picked = pickTest(cache.get(file), test);
    if (picked.error) problems.push(`${at}: \`${file}\` has ${picked.error}`);
  }
  return { found, problems };
}

function main(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const { found, problems } = check(ROOT, readFileSync(join(ROOT, DOC), "utf8"));
  if (args.includes("--list")) {
    for (const { row, file, test } of found) console.log([row ?? "", file, test ?? ""].join("\t"));
    return 0;
  }
  for (const problem of problems) console.error(problem);
  if (!problems.length) console.log(`${found.length} test citations in ${DOC} resolve`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
