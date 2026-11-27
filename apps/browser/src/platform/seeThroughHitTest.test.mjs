import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const patch = readFileSync(new URL("../../../../patches/react-native-macos@0.81.9.patch", import.meta.url), "utf8");

function patchedFile(path) {
  const start = patch.indexOf(`diff --git a/${path} b/${path}`);
  assert.notEqual(start, -1, `the patch no longer changes ${path}`);
  const next = patch.indexOf("\ndiff --git ", start + 1);
  return patch
    .slice(start, next === -1 ? patch.length : next)
    .split("\n")
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" "))
    .map((line) => line.slice(1))
    .join("\n");
}

const method = (source, signature) => {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `no ${signature}`);
  return source.slice(start, source.indexOf("\n}\n", start) + 3);
};

const GUARD = "if (!self.ardiaKeepsHitsWhileClear && (self.alphaValue < 0.01 || self.layer.opacity < 0.01)) {";

test("a React view under 1% opacity takes no hits, so a faded-out overlay never eats a page's hover and clicks", () => {
  const hitTest = method(patchedFile("React/Base/macOS/RCTUIKit.m"), "- (NSView *)hitTest:(NSPoint)point\n{\n  if (!self.ardiaKeepsHitsWhileClear");
  const guard = hitTest.indexOf(GUARD);
  const local = hitTest.indexOf("// NSView's hitTest: receives a point in superview coordinates.");
  assert.ok(guard > 0 && local > guard, "the opacity check comes before any point conversion");
  assert.equal(hitTest.slice(guard, local), `${GUARD}\n    return nil;\n  }\n  `, "the check adds no comment of its own");
  assert.match(patchedFile("React/Base/RCTUIKit.h"), /@property \(nonatomic, assign\) BOOL ardiaKeepsHitsWhileClear;/);
});

test("Ardia's visual-only concealments keep their hits: the page identity hidden during a tab switch and the window root behind a launch picture", () => {
  const read = (path) => readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");
  const internal = read("packages/ardiacore/ios/ArdiaInternal.h");
  assert.match(internal, /inline void KeepHitsWhileClear\(NSView \*view, bool keep\) \{\s*if \(\[view respondsToSelector:NSSelectorFromString\(@"setArdiaKeepsHitsWhileClear:"\)\]\) \[view setValue:@\(keep\) forKey:@"ardiaKeepsHitsWhileClear"\];/);
  const reveal = read("packages/ardiacore/ios/ArdiaWebView+RevealInput.mm");
  assert.match(reveal, /ardia_host::KeepHitsWhileClear\(view, true\);\s*view\.alphaValue = 0;/);
  assert.match(reveal, /view\.alphaValue = \[hidden objectForKey:view\]\.doubleValue;\s*ardia_host::KeepHitsWhileClear\(view, false\);/);
  const covers = read("packages/ardiacore/ios/ArdiaEarlyWindowCovers.mm");
  assert.match(covers, /ardia_host::KeepHitsWhileClear\(root, true\);\s*root\.alphaValue = 0;/);
  assert.match(covers, /root\.alphaValue = 1;\s*ardia_host::KeepHitsWhileClear\(root, false\);/);
  const early = read("packages/ardiacore/ios/ArdiaEarlyWindow.mm");
  assert.match(early, /s\.root\.alphaValue = 1;\s*ardia_host::KeepHitsWhileClear\(s\.root, false\);/, "a root replaced while hidden gives its hits back too");
  for (const [file, source] of [["ArdiaWebView+RevealInput.mm", reveal], ["ArdiaEarlyWindowCovers.mm", covers], ["ArdiaEarlyWindow.mm", early]])
    assert.equal((source.match(/KeepHitsWhileClear\([^)]*, true\)/g) ?? []).length <= (source.match(/KeepHitsWhileClear\([^)]*, false\)/g) ?? []).length, true, `${file} clears every flag it sets`);
});
