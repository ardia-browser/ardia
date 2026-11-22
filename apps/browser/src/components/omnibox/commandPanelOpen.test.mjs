import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
const ts = createRequire(import.meta.url)("typescript");
const { setConsentPeriod } = await import("../../state/telemetry/consentPeriod.ts");
const { takeInlineCompletionCounts } = await import("../../state/telemetry/inlineCompletionCounts.ts");
const { PanelBox, openRelayoutWatch, OPEN_SETTLE_MS } = await import("./PanelBox.tsx");

const styleOf = (node) => [node.props.style].flat(Infinity).reduce((all, s) => ({ ...all, ...(s ?? {}) }), {});
const frame = { left: 8, top: 52, width: 361 };
const rows = { type: "rows", props: {} };

function firstFrame(props) {
  const box = mount(() => PanelBox({ frame, surface: {}, children: rows, ...props }));
  const first = box.value;
  box.unmount();
  return first;
}

function deepestRowsPath(node, path = []) {
  if (node === rows) return path;
  if (!node || typeof node !== "object") return null;
  for (const child of [node.props?.children].flat()) {
    const found = deepestRowsPath(child, [...path, node]);
    if (found) return found;
  }
  return null;
}

for (const clipRadius of [undefined, 12]) {
  test(`the command panel's first frame is its final frame, with every row and nothing scaled, moved or faded (clip ${clipRadius ?? "none"})`, () => {
    const first = firstFrame({ clipRadius });
    assert.deepEqual(styleOf(first), { position: "absolute", ...frame });
    const path = deepestRowsPath(first);
    assert.ok(path, "the rows are drawn on the first frame");
    for (const node of path) {
      const style = styleOf(node);
      assert.equal(style.transform, undefined, "no transform between the panel and its rows");
      assert.equal(style.opacity, undefined, "no fade between the panel and its rows");
    }
    if (clipRadius !== undefined) assert.equal(styleOf(path.at(-1)).borderRadius, clipRadius);
  });
}

test("every command panel frame is a PanelBox and CommandPanel animates nothing", () => {
  const file = new URL("./CommandPanel.tsx", import.meta.url);
  const source = ts.createSourceFile("CommandPanel.tsx", readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const omniboxParents = [];
  const animated = [];
  const visit = (node, frames) => {
    let inner = frames;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText(source);
      if (name === "Omnibox") omniboxParents.push(frames.at(-1) ?? null);
      inner = [...frames, name];
    }
    if (ts.isIdentifier(node) && node.text === "Animated") animated.push(node.getStart(source));
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(source, []);
  assert.ok(omniboxParents.length >= 4);
  for (const frames of omniboxParents) assert.equal(frames, "OutsidePressArea");
  const panelFrames = [];
  const outer = (node, frames) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "OutsidePressArea") panelFrames.push(frames.at(-1));
    let inner = frames;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) inner = [...frames, (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText(source)];
    ts.forEachChild(node, (child) => outer(child, inner));
  };
  outer(source, []);
  assert.deepEqual([...new Set(panelFrames)], ["PanelBox"]);
  assert.deepEqual(animated, [], "CommandPanel.tsx uses no Animated value");
});

test("an open whose panel changes width while it settles is counted once; rows coming and going never are", () => {
  setConsentPeriod(true, "command-panel-on");
  takeInlineCompletionCounts();
  let now = 0;
  const steady = openRelayoutWatch(() => now);
  steady({ width: 361, height: 230 });
  now = 25;
  steady({ width: 361, height: 70 });
  steady({ width: 361, height: 230 });
  assert.equal(takeInlineCompletionCounts().command_bar_open_relayouts, 0, "typing right after opening changes only the height");

  now = 0;
  const regrown = openRelayoutWatch(() => now);
  regrown({ width: 224, height: 230 });
  now = 25;
  regrown({ width: 361, height: 230 });
  regrown({ width: 300, height: 230 });
  assert.equal(takeInlineCompletionCounts().command_bar_open_relayouts, 1);

  now = 0;
  const resizedLater = openRelayoutWatch(() => now);
  resizedLater({ width: 361, height: 230 });
  now = OPEN_SETTLE_MS + 1;
  resizedLater({ width: 300, height: 230 });
  assert.equal(takeInlineCompletionCounts().command_bar_open_relayouts, 0);
});

test("an open that began while sharing was off is never counted, even if sharing comes on before it settles", () => {
  takeInlineCompletionCounts();
  setConsentPeriod(false, "command-panel-off");
  let now = 0;
  const watch = openRelayoutWatch(() => now);
  watch({ width: 224, height: 230 });
  setConsentPeriod(true, "command-panel-on");
  watch({ width: 361, height: 230 });
  assert.equal(takeInlineCompletionCounts().command_bar_open_relayouts, 0);
});

test("the panel's rows keep the same parent with or without a clip, so a placement change never remounts the bar", () => {
  const clipped = firstFrame({ clipRadius: 12 });
  const plain = firstFrame({});
  const holder = (node) => [node.props.children].flat().find((child) => deepestRowsPath(child));
  assert.equal(holder(clipped).type, holder(plain).type);
  assert.equal(deepestRowsPath(clipped).length, deepestRowsPath(plain).length);
});
