import assert from "node:assert/strict";
import { after, test } from "node:test";
globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../telemetry/client.ts");
client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));
const { openDownload, isArchive } = await import("./openDownload.ts");
const { takeDownloadsPanelCounts } = await import("../telemetry/downloadsPanelCounts.ts");

function fakeMac(files) {
  const present = new Set(files);
  const calls = [];
  return {
    calls,
    deps: {
      open: async (path) => (calls.push(["open", path]), present.has(path)),
      reveal: async (path) => (calls.push(["reveal", path]), true),
      exists: (path) => present.has(path),
      wait: async () => {
        for (const file of files) if (/\.zip$/.test(file)) present.add(file.replace(/\.zip$/, ""));
      },
    },
  };
}

test("archives are told apart from other downloads", () => {
  for (const name of ["a.zip", "a.ZIP", "a.tar.gz", "a.tgz", "a.tar.xz", "a.gz"]) assert.ok(isArchive(`/d/${name}`), name);
  for (const name of ["a.dmg", "a.pdf", "zip", "a.zip.pdf"]) assert.ok(!isArchive(`/d/${name}`), name);
});

test("opening a downloaded zip shows it in Finder once, where Archive Utility unpacks it, and never brings Finder back later (#785)", async () => {
  takeDownloadsPanelCounts();
  const mac = fakeMac(["/d/Report.zip"]);
  assert.equal(await openDownload("/d/Report.zip", mac.deps), true);
  assert.deepEqual(mac.calls, [["open", "/d/Report.zip"], ["reveal", "/d/Report.zip"]], "one reveal, at the moment of the click; closing that Finder window is left alone");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mac.calls.length, 2, "nothing is revealed after the click");
  assert.deepEqual(takeDownloadsPanelCounts(), { downloads_panel_press_closes: 0, downloads_panel_held_opens: 0, download_archives_opened: 1, linux_downloads_panel_inside_presses: 0 });
});

test("other files only open, and a missing archive isn't revealed", async () => {
  const mac = fakeMac(["/d/a.pdf"]);
  await openDownload("/d/a.pdf", mac.deps);
  assert.equal(await openDownload("/d/gone.zip", mac.deps), false);
  assert.deepEqual(mac.calls, [["open", "/d/a.pdf"], ["open", "/d/gone.zip"]]);
});
