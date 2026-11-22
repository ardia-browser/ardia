import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("./SidebarPage.tsx", import.meta.url), "utf8");
const pill = readFileSync(new URL("./SelectedRowPill.tsx", import.meta.url), "utf8");

test("the list clips the scroll glow and the player in one view, and the scroll view undoes the player's clip itself", () => {
  assert.match(page, /const clipUnedged = useMemo\(\(\) => Animated\.add\(unedge, playerMotion\.listClip\), \[unedge, playerMotion\.listClip\]\);/);
  assert.match(page, /<Animated\.View style=\{\{ flex: 1, overflow: "hidden", transform: \[\{ translateY: clipUnedged \}\] \}\}>/);
  assert.match(page, /style=\{\{ flex: 1, transform: \[\{ translateY: playerMotion\.listUnclip \}\] \}\}/);
  assert.doesNotMatch(page, /translateY: unedge \}\] \}\}>\n\s*<Animated\.View style=\{\{ flex: 1, overflow: "hidden", transform: \[\{ translateY: playerMotion\.listClip/);
});

test("the pill undoes the glow's shift in its own layer, which mounts only while it shows", () => {
  assert.match(page, /<SelectedRowPill windowId=\{windowId\} tracker=\{selectedRow\} lift=\{edgeLift\} unedge=\{unedge\}/);
  assert.match(pill, /transform: \[\{ translateY: unedge \}\] \}\]\}>/);
  assert.match(pill, /if \(!shown\) return null;/);
});
