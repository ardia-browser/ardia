import assert from "node:assert/strict";
import { after, test } from "node:test";
import { useBrowser } from "../browser/store.ts";
import { newTabLingeringOver } from "./card.ts";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures.ts";
import { PLATFORM_FEATURES as linux } from "../../lib/platformFeatures.linux.ts";
import { PLATFORM_FEATURES as windows } from "../../lib/platformFeatures.windows.ts";

const original = PLATFORM_FEATURES.newTabWaitsForFirstFrame;
const holdsColdPages = PLATFORM_FEATURES.holdsColdPagesUntilPainted;
PLATFORM_FEATURES.holdsColdPagesUntilPainted = false;
after(() => {
  PLATFORM_FEATURES.newTabWaitsForFirstFrame = original;
  PLATFORM_FEATURES.holdsColdPagesUntilPainted = holdsColdPages;
});

for (const waits of [false, true]) {
  test(`a New Tab lingers only when the host can put it behind the first page frame (${waits})`, () => {
    PLATFORM_FEATURES.newTabWaitsForFirstFrame = waits;
    useBrowser.getState().hydrate({});
    const windowId = useBrowser.getState().createWindow({ url: "https://example.com/" });
    const page = useBrowser.getState().windows[windowId].tabIds[0];
    const empty = useBrowser.getState().newTab(windowId);
    useBrowser.getState().activate(page);
    assert.equal(newTabLingeringOver(windowId, empty, page, [page]), waits ? empty : undefined);
    assert.equal(newTabLingeringOver(windowId, empty, page, []), undefined);
    useBrowser.getState().updateTab(page, { engine: "webkit" });
    assert.equal(newTabLingeringOver(windowId, empty, page, [page]), undefined);
  });
}

test("Linux does not keep a New Tab over its page, while existing native hosts retain their policy", () => {
  assert.equal(linux.newTabWaitsForFirstFrame, false);
  assert.equal(windows.newTabWaitsForFirstFrame, true);
  assert.equal(original, true);
});
