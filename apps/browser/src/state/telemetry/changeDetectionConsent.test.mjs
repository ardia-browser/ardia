import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
await import("./workCounts.ts");
const { useBrowser } = await import("../browser/store.ts");
const { changeDetection, takeChangeDetectionCounts } = await import("../browser/changes.ts");
after(() => client.setSharing(false, "settings"));

test("tab-change detection counts from before sharing went off never reach a later consent period", () => {
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com" });
  const tab = S().windows[w].tabIds[0];
  client.setSharing(true, "settings");
  takeChangeDetectionCounts();
  S().updateTab(tab, { title: "counted" });
  S().activate(S().newTab(w, { url: "https://b.com" }));
  assert.ok(changeDetection.linked > 0, "the edits were counted while sharing was on");
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  assert.deepEqual(takeChangeDetectionCounts(), { record_changes_linked: 0, record_changes_scanned: 0, record_changes_scanned_entries: 0 });
});
