import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { check, citations, DOC, ROOT } from "./parity-tests.mjs";

const doc = readFileSync(join(ROOT, "docs/dia-feature-parity.md"), "utf8");

test("every test docs/dia-feature-parity.md cites is a file in the repo, cited by its path", () => {
  const { found, problems } = check(ROOT, doc);
  assert.ok(found.length >= 100, "the doc still cites its tests");
  assert.deepEqual(problems, []);
});

test("a citation names its row, and a test name after # must be a test in that file", () => {
  const root = mkdtempSync(join(tmpdir(), "parity-"));
  mkdirSync(join(root, "apps/a"), { recursive: true });
  writeFileSync(join(root, "apps/a/peek.test.mjs"), 'test("back ends the Peek", () => {});\n');
  const text = [
    "## 3. Tabs",
    "| Peek | ✓ | ✅ | `apps/a/peek.test.mjs#back ends the Peek` and `apps/a/peek.test.mjs` |",
    "| Back | ✓ | ✅ | `apps/a/peek.test.mjs#back closes the tab` |",
    "Verified by `apps/a/gone.test.mjs`.",
  ].join("\n");
  const { found, problems } = check(root, text);
  assert.deepEqual(
    found.map(({ row, file, test: name }) => [row, file, name]),
    [
      ["Peek", "apps/a/peek.test.mjs", "back ends the Peek"],
      ["Peek", "apps/a/peek.test.mjs", null],
      ["Back", "apps/a/peek.test.mjs", "back closes the tab"],
      ["3. Tabs", "apps/a/gone.test.mjs", null],
    ],
  );
  assert.deepEqual(problems, [`${DOC}:3: \`apps/a/peek.test.mjs\` has no test called "back closes the tab"`, `${DOC}:4: \`apps/a/gone.test.mjs\` is not a file in the repo; cite the test by its repo path`]);
});

test("a test file named by its bare name, outside a code span, inside other code or as a Swift class fails", () => {
  const { problems } = citations(
    [
      "| Row | `peek.test.mjs` |",
      "| Row | covered by state/windows/windowClose.test.mjs; |",
      "| Row | `import-flow-test.mjs arc` |",
      "| Row | `WindowDragPacingTests` |",
      "| Row | `usage_counts.peek_opens` and `WindowMove.swift` |",
      "| Row | `test_window_corners.py` |",
    ].join("\n"),
  );
  assert.equal(problems.length, 3);
  assert.match(problems[0], /:2: state\/windows\/windowClose\.test\.mjs is outside a code span/);
  assert.match(problems[1], /:3: .* holds a test file among other text/);
  assert.match(problems[2], /:4: .* names a Swift test class/);
  assert.match(check(ROOT, "| Row | `peek.test.mjs` |").problems[0], /not a file in the repo/);
  assert.match(check(ROOT, "| Row | `test_window_corners.py` |").problems[0], /not a file in the repo/);
  assert.deepEqual(check(ROOT, "| Row | `engine/ardiacore-linux/tests/test_window_corners.py` |").problems, []);
  const outside = mkdtempSync(join(tmpdir(), "parity-outside-"));
  mkdirSync(join(outside, "checkout/apps"), { recursive: true });
  writeFileSync(join(outside, "escape.test.mjs"), "");
  assert.match(check(join(outside, "checkout"), "| Row | `apps/../../escape.test.mjs` |").problems[0], /not a file in the repo/);
  assert.deepEqual(citations("| Row | ``apps/a/peek.test.mjs#a `quoted` name`` |").found.map((citation) => citation.test), ["a `quoted` name"]);
  assert.deepEqual(citations("| Row | ``apps/a/peek.test.mjs#a `quoted` name`` |").problems, []);
});

test("the windowDragPacing JS test the doc used to cite is gone and its row cites the Swift tests that replaced it", () => {
  assert.doesNotMatch(doc, /`windowDragPacing\.test\.mjs`/);
  const row = citations(doc).found.filter((citation) => citation.row === "Drag window from chrome, double‑click to zoom");
  assert.ok(row.some((citation) => citation.file === "packages/shell/tests/WindowDragPacingTests.swift"), "the drag-window row cites the Swift pacing tests");
});
