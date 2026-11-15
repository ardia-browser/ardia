import assert from "node:assert/strict";
import test from "node:test";
import { resolveHostModule } from "./hostModules.ts";
import { BOOKMARKS_EXPORT_CALL, BOOKMARKS_FILE_NAME, exportBookmarksToDownloads } from "./hostBookmarksExport.ts";

const tree = {
  bar: { id: "bar", k: "f", t: "Bookmarks bar", a: 1_700_000_000_000, c: [{ id: "a", k: "u", t: "Ardia", u: "https://ardia.dev/", a: 1_710_000_000_000 }] },
  other: { id: "other", k: "f", t: "Other bookmarks", a: 1_700_000_000_000, c: [{ id: "b", k: "u", t: "Loose", u: "https://loose.example/", a: 1_711_000_000_000 }] },
};

function rig({ capabilities = ["bookmarks.tree", "favicons.get"], listed = [[{ state: "downloading", path: "" }], [{ state: "finished", path: "/home/u/Downloads/Ardia Bookmarks.html" }]], icons = { pages: { "https://ardia.dev/": { png: "AAAA", icon: "https://ardia.dev/favicon.ico" }, "https://loose.example/": { png: "not base64!", icon: "" } } } } = {}) {
  const calls = [];
  const saved = [];
  const released = [];
  let time = 0;
  let polls = 0;
  const host = {
    bootstrap: { windowId: "w1", profileId: "default", capabilities },
    invoke: async () => { throw new Error("no native method"); },
    call: async (name, profile, args) => {
      calls.push([name, profile, JSON.parse(args)]);
      if (name === "bookmarks.tree") return JSON.stringify(tree);
      if (name === "favicons.get") { if (icons === null) throw new Error("no icons"); return JSON.stringify(icons); }
      if (name === "downloads.list") {
        const page = listed[Math.min(polls++, listed.length - 1)] ?? [];
        return JSON.stringify([{ url: "blob:other", state: "finished", path: "/elsewhere" }, ...page.map((entry) => ({ url: "blob:export-1", ...entry }))]);
      }
      return JSON.stringify({ error: "This call is unavailable on Linux" });
    },
    onEvent: () => () => {},
  };
  const platform = {
    download(html, name) { saved.push({ html, name }); return { url: `blob:export-${saved.length}`, release: () => released.push(saved.length) }; },
    wait: async (ms) => { time += ms; },
    now: () => time,
  };
  return { host, platform, calls, saved, released, elapsed: () => time };
}

test("an export builds the HTML from the profile's tree and icons, downloads it and answers the saved path", async () => {
  const { host, platform, calls, saved, released } = rig();
  assert.equal(await exportBookmarksToDownloads(host, "Work", platform), "/home/u/Downloads/Ardia Bookmarks.html");
  assert.deepEqual(calls.slice(0, 2), [["bookmarks.tree", "Work", {}], ["favicons.get", "Work", { pages: ["https://ardia.dev/", "https://loose.example/"], icons: [], size: 16 }]]);
  assert.ok(calls.slice(2).every(([name, profile]) => name === "downloads.list" && profile === "default"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, BOOKMARKS_FILE_NAME);
  assert.ok(saved[0].html.startsWith("<!DOCTYPE NETSCAPE-Bookmark-file-1>\r\n"));
  assert.ok(saved[0].html.includes('<DT><A HREF="https://ardia.dev/" ADD_DATE="1710000000" ICON="data:image/png;base64,AAAA">Ardia</A>'));
  assert.ok(saved[0].html.includes('<DT><A HREF="https://loose.example/" ADD_DATE="1711000000">Loose</A>'));
  assert.deepEqual(released, [1]);
});

test("an export still saves when icons can't be read", async () => {
  const { host, platform, saved } = rig({ icons: null });
  assert.equal(await exportBookmarksToDownloads(host, "", platform), "/home/u/Downloads/Ardia Bookmarks.html");
  assert.equal(saved[0].html.includes("ICON="), false);
});

test("a cancelled save answers no path, a failed one rejects, and one that never starts gives up", async () => {
  const cancelled = rig({ listed: [[], [{ state: "cancelled", path: "" }]] });
  assert.equal(await exportBookmarksToDownloads(cancelled.host, "", cancelled.platform), null);
  assert.deepEqual(cancelled.released, [1]);
  const failed = rig({ listed: [[{ state: "failed", path: "" }]] });
  await assert.rejects(exportBookmarksToDownloads(failed.host, "", failed.platform), /couldn't be written/);
  assert.deepEqual(failed.released, [1]);
  const never = rig({ listed: [[]] });
  assert.equal(await exportBookmarksToDownloads(never.host, "", never.platform), null);
  assert.ok(never.elapsed() > 120_000 && never.elapsed() < 125_000);
  const stuck = rig({ listed: [[{ state: "downloading", path: "" }]] });
  assert.equal(await exportBookmarksToDownloads(stuck.host, "", stuck.platform), null);
  assert.ok(stuck.elapsed() > 60_000 && stuck.elapsed() < 65_000);
});

test("a profile without a bookmarks tree rejects before anything is saved", async () => {
  const { host, platform, saved } = rig();
  host.call = async () => JSON.stringify({ bar: null });
  await assert.rejects(exportBookmarksToDownloads(host, "", platform), /no bookmarks/);
  assert.equal(saved.length, 0);
});

test("the shared bookmarks.exportHtml call is served locally until the engine routes it, and other bookmark calls pass through", async () => {
  const local = rig();
  const call = resolveHostModule(local.host, "ArdiaBookmarks", "call");
  assert.deepEqual(JSON.parse(await call("tree", "Work", "{}")), tree);
  assert.deepEqual(local.calls, [["bookmarks.tree", "Work", {}]]);
  const routed = rig({ capabilities: ["bookmarks.tree", BOOKMARKS_EXPORT_CALL] });
  routed.host.call = async (name, profile, args) => { routed.calls.push([name, profile, JSON.parse(args)]); return JSON.stringify("/chosen/Bookmarks.html"); };
  assert.equal(JSON.parse(await resolveHostModule(routed.host, "ArdiaBookmarks", "call")("exportHtml", "Work", "{}")), "/chosen/Bookmarks.html");
  assert.deepEqual(routed.calls, [["bookmarks.exportHtml", "Work", {}]]);
});
