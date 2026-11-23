import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { add, check, formatLock, LOCK, parseLock, ROOT, update } from "./promises.mjs";
import { findTests, hashOf, pickTest } from "./test-source.mjs";

const hashes = (path, source) => Object.fromEntries(findTests(path, source).map((found) => [found.path, hashOf(found)]));

const JS = `import { test, describe } from "node:test";
test("keeps the pins", () => {
  const pins = [1, 2, 3];
  assert.deepEqual(pins.filter((pin) => pin > 1), [2, 3]);
});
describe("a group", () => {
  it('drops nothing', async () => {
    const text = \`a \${"b"} c\`;
    assert.match(text, /a b c/);
  });
});
`;

test("whitespace, comments, trailing commas and quote style don't change a test's hash", () => {
  const reformatted = `import { test, describe } from "node:test";
test('keeps the pins', () => {
  const pins = [1, 2, 3,];
  assert.deepEqual(
    pins.filter((pin) => pin > 1),
    [2, 3],
  );
});
describe("a group", () => {
  it("drops nothing", async () => {
    const text = \`a \${'b'} c\`;
    assert.match(text, /a b c/);
  });
});
`;
  assert.deepEqual(hashes("x.test.mjs", reformatted), hashes("x.test.mjs", JS));
});

test("a change to a test's body, its name or the call it makes changes the hash, and leaves the other tests alone", () => {
  const before = hashes("x.test.mjs", JS);
  const changed = hashes("x.test.mjs", JS.replace("pin > 1", "pin > 0"));
  assert.notEqual(changed["keeps the pins"], before["keeps the pins"]);
  assert.equal(changed["a group › drops nothing"], before["a group › drops nothing"]);
  assert.notEqual(hashes("x.test.mjs", JS.replace("test(", "test.skip("))["keeps the pins"], before["keeps the pins"]);
  assert.equal(hashes("x.test.mjs", JS.replace('test("keeps the pins"', 'test("keeps pins"'))["keeps the pins"], undefined);
});

test("what a test runs under counts: its loop, its describe, the condition around it", () => {
  const hash = (source, name) => hashOf(findTests("x.test.mjs", source).find((found) => found.path === name));
  const loop = 'for (const order of ["first", "second"]) {\n  test(`closes ${order}`, () => { close(order); });\n}\n';
  assert.notEqual(hash(loop.replace('["first", "second"]', "[]"), "closes ${order}"), hash(loop, "closes ${order}"));
  const group = 'describe("g", () => {\n  test("t", () => { f(); });\n});\n';
  assert.notEqual(hash(group.replace("describe(", "describe.skip("), "g › t"), hash(group, "g › t"));
  const guarded = 'if (process.platform === "darwin") {\n  test("t", () => { f(); });\n}\n';
  assert.notEqual(hash(guarded.replace("darwin", "linux"), "t"), hash(guarded, "t"));
  assert.equal(hash(`import a from "./a.mjs";\n${loop}`, "closes ${order}"), hash(`import b from "./b.mjs";\n\n${loop}`, "closes ${order}"));
});

test("a skipped assertion, a regex after a condition and an elision all change the hash", () => {
  const hash = (body) => hashOf(findTests("x.test.mjs", `test("x", () => { ${body} });`)[0]);
  assert.notEqual(hash("if (wrong) return; assert.equal(actual, expected);"), hash("if (wrong) return assert.equal(actual, expected);"));
  assert.notEqual(hash("if (wrong) return\nassert.equal(actual, expected);"), hash("if (wrong) return assert.equal(actual, expected);"));
  assert.notEqual(hash('if (ready) /[)]/.test(")"); assert.equal(1, 1);'), hash('if (ready) /[)]/.test(")"); assert.equal(1, 2);'));
  assert.notEqual(hash("f([,]);"), hash("f([]);"));
  assert.equal(hash("f([1, 2,]);"), hash("f([1, 2]);"));
  assert.equal(hash("const n = (a + b) / 2; f(n);"), hash("const n = (a + b) / 2;\nf(n);"));
});

test("a guard or suite option that stops a test registering changes its hash, an unrelated statement before it doesn't", () => {
  const hash = (source, name) => hashOf(pickTest(findTests("x.test.mjs", source), name).test);
  const group = 'describe("s", () => {\n  test("t", () => { f(); });\n});\n';
  assert.notEqual(hash(group.replace('describe("s", ', 'describe("s", { skip: true }, '), "s › t"), hash(group, "s › t"));
  assert.notEqual(hash('if (false) test("t", () => { f(); });', "t"), hash('test("t", () => { f(); });', "t"));
  const plain = 'test("t", () => { f(); });';
  assert.notEqual(hash(`if (false)\n  ${plain}`, "t"), hash(plain, "t"));
  assert.notEqual(hash(`for (const o of [])\n  ${plain}`, "t"), hash(`for (const o of [1])\n  ${plain}`, "t"));
  assert.notEqual(hash(`if (a) g();\nelse\n  ${plain}`, "t"), hash(`if (!a) g();\nelse\n  ${plain}`, "t"));
  assert.equal(hash(`if (false) { f(1); } else ${plain}`, "t"), hash(`if (false) { f(2); } else ${plain}`, "t"));
  assert.notEqual(hash(`if (a) { f(); } else if (!b) { g(); } else {\n  ${plain}\n}`, "t"), hash(`if (a) { f(); } else if (b) { g(); } else {\n  ${plain}\n}`, "t"));
  assert.notEqual(hash(`false &&\n  ${plain}`, "t"), hash(`true &&\n  ${plain}`, "t"));
  assert.notEqual(hash(`switch (x) {\n  case 1:\n    g();\n    ${plain}\n}`, "t"), hash(`switch (x) {\n  case 2:\n    g();\n    ${plain}\n}`, "t"));
  const suite = (skip) => `describe("s", { skip: ${skip} },\n  function () {\n    test("t", () => { f(); });\n  });`;
  assert.notEqual(hash(suite(true), "s › t"), hash(suite(false), "s › t"));
  const leading = (skip) => `describe("s", { skip: ${skip} }\n, () => { test("t", () => { f(); }); });`;
  assert.notEqual(hash(leading(true), "s › t"), hash(leading(false), "s › t"));
  assert.notEqual(hash(`for await (const x of [])\n  ${plain}`, "t"), hash(`for await (const x of [1])\n  ${plain}`, "t"));
  assert.notEqual(hash(`if (false) if (false) {} else { ${plain} }`, "t"), hash(`if (true) if (false) {} else { ${plain} }`, "t"));
  assert.notEqual(hash(`switch (1) { case 3: case 2: void 0; ${plain} }`, "t"), hash(`switch (1) { case 1: case 2: void 0; ${plain} }`, "t"));
  assert.notEqual(hash(`switch (2) { case false ? 1 : 3: void 0; ${plain} }`, "t"), hash(`switch (2) { case false ? 1 : 2: void 0; ${plain} }`, "t"));
  assert.equal(hash(`({})?.case; true ? 1 : 0;\n${plain}`, "t"), hash(`({})?.kind; true ? 1 : 0;\n${plain}`, "t"));
  assert.equal(hash(`do f(); while (false)\n${plain}`, "t"), hash(`do f(); while (0)\n${plain}`, "t"));
  assert.notEqual(hash(`while (!a)\n  ${plain}`, "t"), hash(`while (a)\n  ${plain}`, "t"));
  assert.notEqual(hash(`switch (2) { case 1: f()\ncase 3: f(); ${plain} }`, "t"), hash(`switch (2) { case 1: f()\ncase 2: f(); ${plain} }`, "t"));
  assert.notEqual(hash(`false ? {}\n  : ${plain}`, "t"), hash(`true ? {}\n  : ${plain}`, "t"));
  assert.notEqual(hash(`switch (x) { case 3: prepare(); case 2: ${plain} }`, "t"), hash(`switch (x) { case 1: prepare(); case 2: ${plain} }`, "t"));
  assert.equal(hash(`switch (x) { case 3: prepare(); break; case 2: ${plain} }`, "t"), hash(`switch (x) { case 1: prepare(); break; case 2: ${plain} }`, "t"));
  assert.notEqual(hash('describe(\n  "s",\n  { skip: true },\n  () => {\n    test("t", () => { f(); });\n  },\n);', "s › t"), hash('describe(\n  "s",\n  () => {\n    test("t", () => { f(); });\n  },\n);', "s › t"));
  assert.equal(hash(`import a from "a"\nimport "node:path"\n${group}`, "s › t"), hash(`import a from "a"\n${group}`, "s › t"));
  const loop = 'for (const o of [1]) {\n  test(`t ${o}`, () => { f(o); });\n}\n';
  assert.equal(hash(`const other = 1\n${loop}`, "t ${o}"), hash(loop, "t ${o}"));
  assert.equal(hash(group.replace("  test(", '  test("u", () => {});\n  test('), "s › t"), hash(group, "s › t"));
  const swift = (text) => hashOf(findTests("x.swift", text)[0]);
  const marked = "@Test func `t`() { f() }\n";
  assert.notEqual(swift(`#if false\n${marked}#endif\n`), swift(marked));
  assert.notEqual(swift(`#if /* why */ false\n${marked}#endif\n`), swift(`#if /* why */ true\n${marked}#endif\n`));
  assert.equal(swift(`import Testing\nimport struct Foundation.Date\n@Suite struct S {\n${marked}}\n`), swift(`import Testing\n@Suite struct S {\n${marked}}\n`));
  assert.notEqual(swift(`@Suite(.disabled())\nstruct S {\n${marked}}\n`), swift(`@Suite\nstruct S {\n${marked}}\n`));
});

test("a regex opening an interpolation or after x++ is read right, and async before a line break counts", () => {
  const hash = (body) => hashOf(findTests("x.test.mjs", `test("t", async () => { ${body} });`)[0]);
  assert.notEqual(hash('const s = `${/[)]/.test(")")}`; g(1);'), hash('const s = `${/[)]/.test(")")}`; g(2);'));
  assert.notEqual(hash("let x = 8; assert.equal(x++ / 2, 4);"), hash("let x = 8; assert.equal(x++ / 2, 5);"));
  assert.notEqual(hash("const of = 4; assert.equal(of / 2, 2);"), hash("const of = 4; assert.equal(of / 2, 3);"));
  assert.equal(findTests("x.test.mjs", 'test("t", () => { for (const x of /a/.exec(s)) f(x); });').length, 1);
  assert.notEqual(hash("async\nfunction f() {} await f();"), hash("async function f() {} await f();"));
  assert.notEqual(hash("if (w) return\r assert.ok(1);"), hash("if (w) return assert.ok(1);"));
  assert.notEqual(hash("if (w) return\u2028assert.ok(1);"), hash("if (w) return assert.ok(1);"));
  assert.equal(findTests("x.test.mjs", 'test("t", () => { const s = "a\\\nb"; f(s); });').length, 1);
});

test("a test is found by its name with its whitespace changed, as a template title reformatted", () => {
  const tests = findTests("x.test.mjs", "test(`runs ${n + 1}`, () => {});");
  assert.equal(pickTest(tests, "runs ${n+1}").test?.name, "runs ${n + 1}");
  assert.match(pickTest(findTests("x.test.mjs", 'test("open tabs", () => {});'), "opentabs").error, /no test called/);
  assert.equal(findTests("x.test.mjs", 'test("opens\\x20tabs \\u{1F600}", () => {});')[0].name, "opens tabs \u{1F600}");
  assert.deepEqual(findTests("x.swift", "@Test func `t`() { f() }\nprotocol Probe { func testRead() }\n").map((found) => found.name), ["t"]);
});

test("tests are found inside loops and describe blocks, by a template title and past regex and template braces", () => {
  const source = `for (const side of ["left", "right"]) {
  test(\`\${side} sidebar: the field follows\`, () => {
    const pattern = /[{}()]/g;
    const label = \`}\${side}{\`;
    assert.ok(pattern.test(label));
  });
}
suite("outer", () => {
  describe("inner", () => {
    test("twice", () => {});
  });
  test("twice", () => {});
});
t.test("a subtest", () => {});
`;
  assert.deepEqual(findTests("x.test.mjs", source).map((found) => found.path), ["${side} sidebar: the field follows", "outer › inner › twice", "outer › twice"]);
});

test("JSX in a .tsx test is read as one element, its text and its type-parameter arrows included", () => {
  const source = `const deferred = <T,>(): Deferred<T> => ({ promise: null as unknown as Promise<T> });
it("shows the toast", () => {
  const tree = render(<View style={{ flex: 1 }}>
    <Text>Don't {count > 1 ? <Badge n={count} /> : "none"} go</Text>
  </View>);
  expect(tree.find("x")).toBe(/a/.test("a"));
});
test("after the element", () => {});
`;
  assert.deepEqual(findTests("x.render.test.tsx", source).map((found) => found.name), ["shows the toast", "after the element"]);
  const before = hashes("x.render.test.tsx", source)["shows the toast"];
  assert.equal(hashes("x.render.test.tsx", source.replace("<View style", "<View\n      style"))["shows the toast"], before);
  assert.notEqual(hashes("x.render.test.tsx", source.replace("Don't", "Do not"))["shows the toast"], before);
  assert.notEqual(hashes("x.render.test.tsx", source.replace("Don't {count", "Don't  {count"))["shows the toast"], before);
  assert.notEqual(hashes("x.render.test.tsx", source.replace("flex: 1", "flex: 2"))["shows the toast"], before);
  assert.equal(hashes("x.render.test.tsx", source.replace("</Text>\n  </View>", "</Text></View>"))["shows the toast"], before);
});

test("Swift tests are XCTest test methods and @Test functions, raw strings and interpolation included", () => {
  const source = `import XCTest
final class PacingTests: XCTestCase {
  func testAFrameWaits() throws {
    let note = #"a "quoted" \\#(value) note"#
    XCTAssertEqual(pacing.frame(now: 1), CGPoint(x: "\\(a + ")")".count, y: 0))
  }
  private func helper() {}
}
@Test(arguments: ["a.example"])
func \`listed hosts require HTTPS\`(host: String) {
  #expect(Preload.requires(host))
}
`;
  const found = findTests("PacingTests.swift", source);
  assert.deepEqual(found.map((item) => item.name), ["testAFrameWaits", "listed hosts require HTTPS"]);
  const swiftHash = (text, name) => hashOf(findTests("PacingTests.swift", text).find((item) => item.name === name));
  assert.notEqual(swiftHash(source.replace('@Test(arguments: ["a.example"])', '@Test(.disabled(), arguments: ["a.example"])'), "listed hosts require HTTPS"), swiftHash(source, "listed hosts require HTTPS"));
  assert.notEqual(swiftHash(source.replace('["a.example"]', "[]"), "listed hosts require HTTPS"), swiftHash(source, "listed hosts require HTTPS"));
  assert.notEqual(swiftHash(`@Suite(.disabled())\nstruct Hosts {\n${source}}\n`, "testAFrameWaits"), swiftHash(`struct Hosts {\n${source}}\n`, "testAFrameWaits"));
  const reindented = source.replace(/\n {2,}/g, "\n");
  assert.deepEqual(hashes("PacingTests.swift", reindented), hashes("PacingTests.swift", source));
});

function scratch(files) {
  const root = mkdtempSync(join(tmpdir(), "promises-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("the check names a promise whose test changed, was renamed or whose file is gone, and --update records the new hash", () => {
  const root = scratch({ "a/x.test.mjs": JS });
  const promises = add(root, add(root, [], 12, "a/x.test.mjs", "keeps the pins"), 7, "a/x.test.mjs", "drops nothing");
  const sorted = parseLock(formatLock(promises));
  assert.deepEqual(sorted.map((promise) => promise.issue), [7, 12]);
  assert.deepEqual(check(root, sorted), []);

  writeFileSync(join(root, "a/x.test.mjs"), JS.replace("pin > 1", "pin >= 2"));
  const [changed] = check(root, sorted);
  assert.match(changed, /#12 a\/x\.test\.mjs › "keeps the pins": the test changed/);
  assert.match(changed, /--update 12/);
  const updated = update(root, sorted, 12);
  assert.deepEqual(check(root, updated), []);
  assert.equal(updated.find((promise) => promise.issue === 7).hash, sorted.find((promise) => promise.issue === 7).hash);

  writeFileSync(join(root, "a/x.test.mjs"), JS.replace('"keeps the pins"', '"keeps its pins"'));
  assert.match(check(root, updated)[0], /no test called "keeps the pins"/);
  assert.throws(() => update(root, updated, 12), /fix its file or name/);

  writeFileSync(join(root, "a/x.test.mjs"), "");
  assert.equal(check(root, updated).length, 2);
  assert.match(check(scratch({}), updated)[0], /the file is gone/);
});

test("the lock is one header and one sorted, tab-separated line per promise, with no test locked twice", () => {
  assert.throws(() => parseLock("issue\thash\n"), /header/);
  assert.throws(() => parseLock("issue\thash\tfile\ttest\n12\tnothex\ta.test.mjs\tx\n"), /16 hex digits/);
  assert.throws(() => parseLock("issue\thash\tfile\ttest\n#12\t0123456789abcdef\ta.test.mjs\tx\n"), /a number/);
  const root = scratch({ "a/x.test.mjs": JS });
  const one = add(root, [], 12, "a/x.test.mjs", "keeps the pins");
  assert.throws(() => add(root, one, 13, "a/x.test.mjs", "keeps the pins"), /locked already/);
  assert.throws(() => add(root, one, 13, "a/x.test.mjs", "is not there"), /no test called/);
  assert.throws(() => add(root, one, 13, "a/x.spec.ts", "keeps the pins"), /only test files/);
  const unsorted = [{ ...one[0], issue: 30 }, { ...one[0], issue: 4, test: "a group › drops nothing", hash: hashes("x.test.mjs", JS)["a group › drops nothing"] }];
  assert.match(check(root, unsorted).join("\n"), /is sorted by issue/);
});

test("every promise in the lock still holds", () => {
  const promises = parseLock(readFileSync(join(ROOT, LOCK), "utf8"));
  assert.ok(promises.length >= 100, "the lock still holds the seeded promises");
  assert.deepEqual(check(ROOT, promises), []);
});

test("the command line checks the lock and says how to use it", () => {
  const script = fileURLToPath(new URL("./promises.mjs", import.meta.url));
  assert.match(execFileSync(process.execPath, [script], { encoding: "utf8" }), /promises hold/);
  assert.match(execFileSync(process.execPath, [script, "--help"], { encoding: "utf8" }), /--update <issue>/);
});
