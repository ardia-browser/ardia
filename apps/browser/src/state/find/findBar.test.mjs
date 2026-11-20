import assert from "node:assert/strict";
import { test } from "node:test";
import { closeFind, findStep, openFind, submitRepeatsKey } from "./actions.ts";
import { noteFind, takeFindCounts } from "../telemetry/findCounts.ts";
import { useBrowser } from "../browser/store.ts";
import { setConsentPeriod } from "../telemetry/consentPeriod.ts";

setConsentPeriod(true, "find-bar-test");

test("a submit right after the Enter keydown it came from doesn't step again, a later one does", () => {
  assert.equal(submitRepeatsKey(1000, 1000), true);
  assert.equal(submitRepeatsKey(1000, 1100), true);
  assert.equal(submitRepeatsKey(1000, 1300), false);
  assert.equal(submitRepeatsKey(0, 5000), false);
});

test("find opens and steps are counted and reset once taken", () => {
  takeFindCounts();
  noteFind("opened");
  noteFind("stepped");
  noteFind("stepped");
  assert.deepEqual(takeFindCounts(), { find_opens: 1, find_steps: 2 });
  assert.deepEqual(takeFindCounts(), { find_opens: 0, find_steps: 0 });
});

test("an open is counted when the bar goes from closed to open, whichever key opened it", () => {
  useBrowser.getState().hydrate({});
  const windowId = useBrowser.getState().createWindow({ url: "https://a.com" });
  const tab = useBrowser.getState().windows[windowId].tabIds[0];
  takeFindCounts();
  openFind(tab);
  openFind(tab);
  assert.deepEqual(takeFindCounts(), { find_opens: 1, find_steps: 0 }, "Ctrl+F on an open bar only focuses it");
  closeFind(tab);
  findStep(tab, false);
  findStep(tab, true);
  assert.deepEqual(takeFindCounts(), { find_opens: 1, find_steps: 0 }, "F3 with no search opens the bar once and steps nothing");
  closeFind(tab);
  openFind(tab);
  assert.deepEqual(takeFindCounts(), { find_opens: 1, find_steps: 0 });
});
