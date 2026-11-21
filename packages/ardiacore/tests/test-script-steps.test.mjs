import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;

const BINARY = /"\$\{TMPDIR:-\/tmp\}\/[^"]+"/g;
const withoutEnv = (step) => step.replace(/^(?:\w+=\S+ )+/, "");

export function stepProblems(script) {
  const steps = script.split(" && ");
  const compiled = new Set();
  const problems = [];
  steps.forEach((step, i) => {
    if (step.startsWith("clang++ ")) {
      const output = / -o ("[^"]+"|\S+)/.exec(step)?.[1];
      if (!output) return problems.push(`step ${i} compiles without -o: ${step}`);
      if (compiled.has(output)) problems.push(`step ${i} compiles ${output} a second time`);
      compiled.add(output);
      const next = steps[i + 1];
      if (next === undefined || withoutEnv(next) !== output) problems.push(`step ${i} builds ${output} but step ${i + 1} doesn't run it: ${next ?? "(end)"}`);
      return;
    }
    for (const binary of step.match(BINARY) ?? []) {
      if (!compiled.has(binary)) problems.push(`step ${i} runs ${binary}, which no earlier step compiled`);
      else if (withoutEnv(step) !== binary) problems.push(`step ${i} runs ${binary} with extra words: ${step}`);
    }
  });
  return problems;
}

test("every C++ test the test script compiles is run by the very next step, and nothing runs a binary it didn't compile", () => {
  assert.deepEqual(stepProblems(scripts.test), []);
});

test("the check catches a compile whose step was merged into the run of the binary before it", () => {
  const spliced = 'clang++ -std=c++20 -Wall -Werror tests/pointer-trace.test.cc -o "${TMPDIR:-/tmp}/ardiacore-pointer-trace-test" && "${TMPDIR:-/tmp}/ardiacore-pointer-trace-test" tests/paint-probe.test.cc -o "${TMPDIR:-/tmp}/ardiacore-paint-probe-test" && "${TMPDIR:-/tmp}/ardiacore-paint-probe-test"';
  const problems = stepProblems(spliced);
  assert.ok(problems.some((p) => p.includes("runs \"${TMPDIR:-/tmp}/ardiacore-paint-probe-test\", which no earlier step compiled")), problems.join("\n"));
  assert.ok(problems.some((p) => p.includes("with extra words")), problems.join("\n"));
});

test("the check catches a compile that is never run and a run of a binary built later", () => {
  assert.ok(stepProblems('clang++ tests/a.test.cc -o "${TMPDIR:-/tmp}/a" && node --test x.mjs').some((p) => p.includes("doesn't run it")));
  assert.ok(stepProblems('"${TMPDIR:-/tmp}/a" && clang++ tests/a.test.cc -o "${TMPDIR:-/tmp}/a" && "${TMPDIR:-/tmp}/a"').some((p) => p.includes("no earlier step compiled")));
  assert.deepEqual(stepProblems('clang++ tests/a.test.cc -o "${TMPDIR:-/tmp}/a" && TSAN_OPTIONS=halt_on_error=1 "${TMPDIR:-/tmp}/a"'), []);
});

test("test:portable lists each test file once, and every one it lists exists", () => {
  const files = scripts["test:portable"].split(" ").filter((word) => word.endsWith(".mjs"));
  assert.deepEqual(files.filter((file, i) => files.indexOf(file) !== i), []);
  assert.deepEqual(files.filter((file) => !existsSync(`${root}/${file}`)), []);
});
