import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { dismissDownloadsByPress, setDownloadsOpen, toggleDownloadsOpen } = await import("../windows/actions.ts");
const { takeDownloadsPanelCounts } = await import("../telemetry/downloadsPanelCounts.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const download = (id, extra = {}) => ({
  id, url: `https://dl.example/${id}`, filename: id, path: `/tmp/${id}`, state: "downloading", paused: false, received: 0, total: 1, speed: 0, mimeType: "", profile: "", ...extra,
});

function oneWindow() {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const w = S().createWindow({ url: "https://a.example/" });
  S().setFocusedWindow(w);
  setDownloadsOpen(w, false);
  takeDownloadsPanelCounts();
  return w;
}
const isOpen = (w) => !!S().windowUi[w]?.downloadsOpen;

test("a new download leaves the Downloads panel closed, as Dia's button does", () => {
  const w = oneWindow();
  S().upsertDownload(download("one"));
  S().upsertDownload(download("two"));
  S().upsertDownload({ ...download("one"), state: "finished" });
  assert.equal(S().downloads.length, 2);
  assert.equal(isOpen(w), false);
});

test("a download held for Keep or Discard opens the panel once", () => {
  const w = oneWindow();
  S().upsertDownload(download("insecure", { url: "http://dl.example/x", dangerous: true }));
  assert.equal(isOpen(w), true);
  setDownloadsOpen(w, false);
  S().upsertDownload(download("insecure", { url: "http://dl.example/x", dangerous: true, received: 1 }));
  assert.equal(isOpen(w), false, "an update to the same held download doesn't reopen it");
  assert.equal(takeDownloadsPanelCounts().downloads_panel_held_opens, 1);
});

test("a press outside closes the panel, and the Downloads button's own press doesn't reopen it", () => {
  const w = oneWindow();
  toggleDownloadsOpen(w);
  assert.equal(isOpen(w), true);
  dismissDownloadsByPress(w);
  assert.equal(isOpen(w), false);
  toggleDownloadsOpen(w);
  assert.equal(isOpen(w), false, "the press that closed it from outside lands on the button");
  toggleDownloadsOpen(w);
  assert.equal(isOpen(w), true, "the next press opens it");
  dismissDownloadsByPress(w);
  dismissDownloadsByPress(w);
  assert.equal(takeDownloadsPanelCounts().downloads_panel_press_closes, 2, "only a press that closed it counts");
});
