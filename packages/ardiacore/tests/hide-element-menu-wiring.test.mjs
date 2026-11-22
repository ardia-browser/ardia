import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const pageScript = read("../ios/page_script.js");
const pageMessages = read("../ios/ArdiaWebView+PageMessages.mm");
const contextMenu = read("../ios/ArdiaWebView+ContextMenu.mm");
const ubo = read("../scripts/ubo.sh");

test("no page event can start Hide Element: the page script has no listener and the native side takes no page message for it", () => {
  assert.doesNotMatch(pageScript, /ardia-hide-element/);
  assert.doesNotMatch(pageScript, /send\("hideElement"/);
  assert.doesNotMatch(pageMessages, /@"hideElement"/);
});

test("Hide Element from the page menu goes through the blocker's own record, in the main page as in frames", () => {
  const clicked = ubo.slice(ubo.indexOf("const onEntryClicked = function(details, tab) {\\n\"\n"), ubo.indexOf("patch(\"js/contextmenu.js\",\n      \"const menuEntries"));
  assert.match(clicked, /µb\.ardiaHideElementFrameClick = \{ tabId: tab\.id, pageUrl: tab\.url, frameId: details\.frameId, at: Date\.now\(\) \};/);
  assert.doesNotMatch(clicked, /executeScript|dispatchEvent/);
  assert.match(contextMenu, /return resolve\(\{tabId: click\.tabId, pageUrl: click\.pageUrl, frameId: click\.frameId\}\);/);
  assert.match(contextMenu, /runContextMenu:\(NSDictionary<NSString \*, id> \*\)menu \{\n  NSArray \*items = Field<NSArray>\(menu, @"items"\) \?: @\[\];\n  \[self noteContextMenuPoint\];/);
  assert.ok(Number(/^UBO_PATCH="(\d+)"$/m.exec(ubo)?.[1]) >= 31, "cached vendor copies re-patch past the menu change");
});

test("a pick counts only with a real click or Return in that page, on the document it started on", () => {
  assert.match(contextMenu, /NSEventMaskLeftMouseUp \| NSEventMaskKeyDown/);
  assert.match(contextMenu, /event\.keyCode == kReturnKeyCode \|\| event\.keyCode == kEnterKeyCode/);
  assert.match(contextMenu, /_tab\.committedDocumentCount == _elementPick\.documents/);
  assert.match(contextMenu, /armed == _elementPick\.armed && _elementPick\.input/);
});
