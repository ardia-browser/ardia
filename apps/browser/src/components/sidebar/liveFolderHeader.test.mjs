import assert from "node:assert/strict";
import { test } from "node:test";
const geometry = await import("./geometry.ts");

test("a live folder's header starts at its box's edge, as a group's does, so their icons and titles line up (#3003)", () => {
  assert.equal(geometry.LIVE_FOLDER_BOX_PAD + geometry.LIVE_FOLDER_HEADER_MARGIN, 0);
});

test("a live folder's warning sits in the header's far-right slot, where hovering shows the refresh button instead", async () => {
  const { readFileSync } = await import("node:fs");
  const ts = (await import("node:module")).createRequire(import.meta.url)("typescript");
  const text = readFileSync(new URL("./LiveFolderBlock.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("LiveFolderBlock.tsx", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const found = [];
  const visit = (n) => {
    if (ts.isJsxElement(n) && n.openingElement.getText(file).includes("REFRESH_SLOT")) found.push(n);
    ts.forEachChild(n, visit);
  };
  visit(file);
  assert.equal(found.length, 1);
  const slot = found[0].getText(file);
  assert.match(slot, /exclamationmark\.triangle\.fill/, "the warning isn't in the refresh slot");
  const rest = slot.slice(slot.indexOf("opacity: restOpacity"));
  assert.ok(rest.indexOf("exclamationmark.triangle.fill") > rest.indexOf("<Badge"), "the warning comes after the count, at the far right");
  assert.ok(slot.indexOf("exclamationmark.triangle.fill") < slot.indexOf("REFRESH_OVER"), "the refresh button that fades in on hover covers the warning's place");
  const warning = rest.slice(rest.lastIndexOf("<Pressable", rest.indexOf("exclamationmark.triangle.fill")), rest.indexOf("exclamationmark.triangle.fill"));
  assert.match(warning, /accessibilityRole="button"/, "assistive tech can still press the warning");
  assert.match(warning, /onAccessibilityTap=\{\(\) => fixLiveFolderError\(/, "pressing it runs the warning's fix");
  const header = text.slice(text.indexOf("function FolderHeader"), text.indexOf("function RefreshButton"));
  assert.equal(header.split("exclamationmark.triangle.fill").length - 1, 1, "only one warning in the header");
});
