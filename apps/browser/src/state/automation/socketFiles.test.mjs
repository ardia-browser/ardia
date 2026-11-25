import assert from "node:assert/strict";
import { test } from "node:test";
import { HOSTILE_STRINGS } from "../../../../../scripts/security/hostile-inputs.mjs";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { ensureRoots } = await import("../bookmarks/bookmarks.ts");
const { localPathProblem, resetFileArmsForTests } = await import("./fileArms.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;

async function call(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 12, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  for (let i = 0; i < 50 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === 12); i++) await tick();
  const replies = stub.controlSocket.replies.slice(before).filter((r) => r.connection === 12);
  assert.equal(replies.length, 1, `one reply to ${method}`);
  return JSON.parse(replies[0].line);
}

const ok = async (method, params) => {
  const reply = await call(method, params);
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};

const native = stub.fileArmsNative;

async function setup() {
  resetFileArmsForTests();
  native.rows.length = 0;
  native.specs.length = 0;
  native.placed.length = 0;
  native.disarmed.length = 0;
  native.claims.length = 0;
  native.released.length = 0;
  native.disarmedAfter.length = 0;
  native.gate = null;
  native.refuse = null;
  native.place = null;
  native.supported = true;
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  useBrowser.setState((s) => ({ bookmarks: ensureRoots(s.bookmarks, "")[0] }));
  return S().createWindow({ url: "https://a.example/" });
}

const tabIn = (windowId) => S().windows[windowId].tabIds[0];
const download = (fields) => ({ url: "https://files.example/a.zip", filename: "a.zip", path: "/Users/me/Downloads/a.zip", state: "downloading", paused: false, received: 10, total: 100, speed: 5, mimeType: "application/zip", profile: "", ...fields });

test("files.armUpload arms the tab's next chooser natively and reports what it chose", async () => {
  const windowId = await setup();
  const tab = tabIn(windowId);
  const armed = await ok("files.armUpload", { tab, paths: ["/Users/me/report.pdf"] });
  assert.equal(armed.kind, "upload");
  assert.equal(armed.tab, tab);
  assert.equal(armed.state, "armed");
  assert.equal(armed.once, true);
  assert.deepEqual(native.specs[0], { id: armed.arm, kind: "upload", tab, window: windowId, paths: ["/Users/me/report.pdf"], once: true, seconds: 120 });
  const row = native.rows[0];
  row.state = "answered";
  row.answered = 1;
  row.landed = ["/Users/me/report.pdf"];
  const listed = await ok("files.arms", { arms: [armed.arm] });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].state, "answered");
  assert.deepEqual(listed.items[0].chosen, ["/Users/me/report.pdf"]);
});

test("files.armUpload refuses bad paths before the native layer sees them", async () => {
  const windowId = await setup();
  const tab = tabIn(windowId);
  for (const path of ["relative.txt", "/a/../etc/passwd", "/a/./b", "/a\u0000b", "/a\nb", `/${"x".repeat(1100)}`]) {
    const reply = await call("files.armUpload", { tab, paths: [path] });
    assert.equal(reply.error?.code, "bad_request", path.slice(0, 40));
  }
  assert.equal(native.specs.length, 0, "nothing reached the native arm");
  assert.equal((await call("files.armUpload", { tab: "nope", paths: ["/tmp/x"] })).error.code, "no_window");
  assert.equal((await call("files.armUpload", { tab, paths: [] })).error.code, "bad_request");
  assert.equal((await call("files.armUpload", { tab, paths: ["/tmp/x"], seconds: 601 })).error.code, "bad_request");
  native.refuse = { reason: "missing", path: "/tmp/gone.txt" };
  const missing = await call("files.armUpload", { tab, paths: ["/tmp/gone.txt"] });
  assert.equal(missing.error.code, "bad_request");
  assert.match(missing.error.message, /doesn't exist/);
  native.refuse = { reason: "noTab" };
  assert.equal((await call("files.armUpload", { tab, paths: ["/tmp/x"] })).error.code, "no_window");
});

test("an upload arm for a private window's tab is refused", async () => {
  await setup();
  const privateWindow = S().createWindow({ url: "https://p.example/", kind: "private" });
  const privateTab = S().windows[privateWindow]?.tabIds[0];
  assert.ok(privateTab, "the private window has a tab");
  assert.equal((await call("files.armUpload", { tab: privateTab, paths: ["/tmp/x"] })).error.code, "no_window");
  assert.equal(native.specs.length, 0);
});

test("files.armDownload moves the next download of the tab's profile to the path and reports it", async () => {
  const windowId = await setup();
  const tab = tabIn(windowId);
  S().upsertDownload(download({ id: "old", state: "downloading" }));
  const armed = await ok("files.armDownload", { tab, path: "/Users/me/Desktop/invoice.zip" });
  assert.equal(armed.kind, "download");
  assert.equal(armed.path, "/Users/me/Desktop/invoice.zip");
  stub.emitDownload(download({ id: "old", state: "finished", received: 100 }));
  await tick();
  assert.equal(native.placed.length, 0, "a download that started before the arm isn't taken");
  stub.emitDownload(download({ id: "d9", state: "downloading" }));
  stub.emitDownload(download({ id: "d9", state: "finished", received: 100 }));
  for (let i = 0; i < 10 && !native.placed.length; i++) await tick();
  await tick();
  assert.deepEqual(native.placed, [[armed.arm, "d9", "/Users/me/Downloads/a.zip"]]);
  const listed = await ok("files.arms", {});
  const row = listed.items.find((r) => r.arm === armed.arm);
  assert.equal(row.state, "finished");
  assert.deepEqual(row.downloads, [{ downloadId: "d9", state: "finished", path: "/Users/me/Desktop/invoice.zip", bytes: 42 }]);
  stub.emitDownload(download({ id: "d10", state: "downloading" }));
  stub.emitDownload(download({ id: "d10", state: "finished" }));
  await tick();
  assert.equal(native.placed.length, 1, "a once arm takes one download");
});

test("files.armDownload skips private downloads and reports a failed move", async () => {
  await setup();
  const armed = await ok("files.armDownload", { path: "/Users/me/Desktop/x.zip" });
  stub.emitDownload(download({ id: "p1", offTheRecord: true }));
  stub.emitDownload(download({ id: "p1", offTheRecord: true, state: "finished" }));
  await tick();
  assert.equal(native.placed.length, 0);
  native.place = () => ({ ok: false, reason: "exists" });
  stub.emitDownload(download({ id: "d1" }));
  stub.emitDownload(download({ id: "d1", state: "finished" }));
  for (let i = 0; i < 10 && !native.placed.length; i++) await tick();
  await tick();
  const row = (await ok("files.arms", { arms: [armed.arm] })).items[0];
  assert.equal(row.state, "failed");
  assert.equal(row.downloads[0].reason, "exists");
});

test("files.disarm clears arms, a closed tab ends its arm, and control off clears everything", async () => {
  const windowId = await setup();
  const tab = tabIn(windowId);
  const one = await ok("files.armUpload", { tab, paths: ["/tmp/a"] });
  const sameWindow = await call("files.armUpload", { tab, paths: ["/tmp/c"] });
  assert.equal(sameWindow.error?.code, "refused", "a second upload arm in the same window is refused");
  assert.match(sameWindow.error.message, new RegExp(one.arm));
  await ok("files.armDownload", { path: "/tmp/folder", once: false });
  assert.deepEqual(await ok("files.disarm", { arms: [one.arm] }), { cleared: 1 });
  assert.deepEqual(native.disarmed.at(-1), [[one.arm], false]);
  const two = await ok("files.armUpload", { tab, paths: ["/tmp/b"] });
  S().closeTab(tab);
  await tick();
  assert.ok(native.disarmed.some(([ids, purge]) => Array.isArray(ids) && ids.includes(two.arm) && purge), "closing the tab disarms its upload and drops its copies");
  const callsBefore = stub.controlSocket.calls.length;
  const disarmsBefore = native.disarmed.length;
  S().updateSettings({ cliControl: false });
  assert.deepEqual(stub.controlSocket.calls.slice(callsBefore), ["cutOff"], "the cut-off comes first, in the same turn");
  assert.deepEqual(native.disarmed[disarmsBefore], [null, true], "every native arm is cleared in that same turn");
  assert.equal(native.disarmedAfter[disarmsBefore], "cutOff", "right after the cut-off");
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(native.disarmed.some(([ids, purge]) => ids === null && purge), "turning control off clears every arm");
  S().updateSettings({ cliControl: true });
  for (let i = 0; i < 5; i++) await tick();
});

test("two upload arms for one window racing each other: the native registry lets exactly one in", async () => {
  const windowId = await setup();
  const tab = tabIn(windowId);
  const before = stub.controlSocket.replies.length;
  const ids = [++nextId, ++nextId];
  for (const [i, id] of ids.entries()) stub.emitControlRequest({ connection: 12, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method: "files.armUpload", params: { tab, paths: [`/tmp/${i}`] } }) });
  for (let i = 0; i < 100 && stub.controlSocket.replies.slice(before).filter((r) => r.connection === 12).length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  const results = stub.controlSocket.replies.slice(before).filter((r) => r.connection === 12).map((r) => JSON.parse(r.line));
  assert.equal(results.length, 2);
  assert.equal(results.filter((r) => !r.error).length, 1, JSON.stringify(results));
  const refused = results.find((r) => r.error);
  assert.equal(refused.error.code, "refused");
  assert.match(refused.error.message, new RegExp(results.find((r) => !r.error).result.arm));
  assert.equal(native.specs.length, 2, "both requests reached the native registry");
});

test("a prompted download that took the arm first keeps a slow automatic download from claiming it", async () => {
  await setup();
  const armed = await ok("files.armDownload", { path: "/Users/me/Desktop/out.zip" });
  const stagedPath = native.answerSavePanel(armed.arm);
  assert.ok(stagedPath, "the save panel took the armed arm");
  stub.emitDownload(download({ id: "slow", path: "/Users/me/Downloads/slow.zip" }));
  stub.emitDownload(download({ id: "asked", path: stagedPath }));
  stub.emitDownload(download({ id: "slow", path: "/Users/me/Downloads/slow.zip", state: "finished" }));
  stub.emitDownload(download({ id: "asked", path: stagedPath, state: "finished" }));
  for (let i = 0; i < 10 && !native.placed.length; i++) await tick();
  await tick();
  assert.deepEqual(native.placed, [[armed.arm, "asked", stagedPath]], "only the prompted download is placed");
  const row = (await ok("files.arms", { arms: [armed.arm] })).items[0];
  assert.deepEqual(row.downloads.map((d) => d.downloadId), ["asked"]);
});

test("an automatic download that claimed the arm first leaves no arm for a later save panel", async () => {
  await setup();
  const armed = await ok("files.armDownload", { path: "/Users/me/Desktop/out.zip" });
  stub.emitDownload(download({ id: "auto", path: "/Users/me/Downloads/auto.zip" }));
  await tick();
  assert.equal(native.answerSavePanel(armed.arm), null, "the panel finds the arm already claimed");
  stub.emitDownload(download({ id: "auto", path: "/Users/me/Downloads/auto.zip", state: "finished" }));
  for (let i = 0; i < 10 && !native.placed.length; i++) await tick();
  assert.deepEqual(native.placed, [[armed.arm, "auto", "/Users/me/Downloads/auto.zip"]]);
});

test("closing a tab mid-download still drops its arm natively", async () => {
  const windowId = await setup();
  const tab = tabIn(windowId);
  const armed = await ok("files.armDownload", { tab, path: "/Users/me/Desktop/inflight.zip" });
  stub.emitDownload(download({ id: "inflight", path: "/Users/me/Downloads/inflight.zip" }));
  await tick();
  S().closeTab(tab);
  await tick();
  assert.ok(native.disarmed.some(([ids, purge]) => Array.isArray(ids) && ids.includes(armed.arm) && purge), "the claimed arm's tab closing still disarms it");
});

test("a download without a path yet isn't claimed", async () => {
  await setup();
  await ok("files.armDownload", { path: "/Users/me/Desktop/later.zip" });
  stub.emitDownload(download({ id: "nopath", path: "" }));
  await tick();
  assert.equal(native.claims.length, 0);
});

test("a prompted download goes to the arm whose staging folder it saved into, even when another arm ranks first", async () => {
  const windowId = await setup();
  const tab = tabIn(windowId);
  const ranked = await ok("files.armDownload", { tab, path: "/Users/me/Desktop/a.zip" });
  const owner = await ok("files.armDownload", { path: "/Users/me/Elsewhere/b.zip" });
  const stagedPath = native.answerSavePanel(owner.arm);
  assert.ok(stagedPath);
  stub.emitDownload(download({ id: "prompted", path: stagedPath }));
  stub.emitDownload(download({ id: "prompted", path: stagedPath, state: "finished" }));
  for (let i = 0; i < 10 && !native.placed.length; i++) await tick();
  await tick();
  assert.deepEqual(native.placed, [[owner.arm, "prompted", stagedPath]]);
  assert.ok(native.claims.some(([arm, id]) => arm === ranked.arm && id === "prompted"), "the higher-ranked arm was asked first");
  const rows = (await ok("files.arms", {})).items;
  assert.equal(rows.find((r) => r.arm === ranked.arm).state, "armed", "the other arm wasn't spent");
  assert.deepEqual(rows.find((r) => r.arm === owner.arm).downloads.map((d) => d.downloadId), ["prompted"]);
});

test("control going off while an arm is still staging leaves nothing armed", async () => {
  const windowId = await setup();
  let open;
  native.gate = new Promise((resolve) => (open = resolve));
  const pending = call("files.armUpload", { tab: tabIn(windowId), paths: ["/tmp/a"] });
  await tick();
  S().updateSettings({ cliControl: false });
  open();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(native.rows.filter((r) => r.state === "armed").length, 0, "the native registry refused the stale registration");
  S().updateSettings({ cliControl: true });
  for (let i = 0; i < 5; i++) await tick();
  void pending;
});

test("a tab closing while its arm is still staging disarms it and says so", async () => {
  const windowId = await setup();
  await ok("apply", { ops: [{ op: "open", urls: ["https://second.example/"], window: windowId }] });
  const tab = S().windows[windowId].tabIds.find((t) => S().tabs[t].url.includes("second.example"));
  let open;
  native.gate = new Promise((resolve) => (open = resolve));
  const id = 900000 + nextId++;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 12, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method: "files.armUpload", params: { tab, paths: ["/tmp/a"] } }) });
  await tick();
  S().closeTab(tab);
  open();
  for (let i = 0; i < 20 && !stub.controlSocket.replies.slice(before).some((r) => JSON.parse(r.line).id === id); i++) await tick();
  const reply = JSON.parse(stub.controlSocket.replies.slice(before).find((r) => JSON.parse(r.line).id === id).line);
  assert.equal(reply.error?.code, "no_window");
  const armId = native.specs.at(-1).id;
  assert.ok(native.disarmed.some(([ids, purge]) => Array.isArray(ids) && ids.includes(armId) && purge), "the new arm was disarmed with its copies");
});

test("every shared hostile string sent as a path to the real handlers is refused before the native sink unless it is a plain absolute path", async () => {
  const windowId = await setup();
  const tab = tabIn(windowId);
  let refused = 0;
  for (const { value } of HOSTILE_STRINGS) {
    for (const [method, params] of [["files.armUpload", { tab, paths: [value] }], ["files.armDownload", { path: value }]]) {
      const before = native.specs.length;
      const reply = await call(method, params);
      const reached = native.specs.length > before;
      if (localPathProblem(value) !== null) {
        assert.ok(reply.error, `${method} ${JSON.stringify(value).slice(0, 60)} is refused`);
        assert.equal(reached, false, `${method} ${JSON.stringify(value).slice(0, 60)} never reaches the native sink`);
        refused++;
      } else if (reached) {
        assert.deepEqual(native.specs.at(-1).paths, [value], "only the exact plain path reaches the sink");
      }
      native.rows.length = 0;
    }
  }
  assert.ok(refused > 10, "the corpus exercised the guard");
  const before = native.specs.length;
  await ok("files.armUpload", { tab, paths: ["/Users/me/plain.txt"] });
  assert.equal(native.specs.length, before + 1, "positive control: a plain path reaches the sink");
});

test("files.arms says when a placed download's source couldn't be removed", async () => {
  await setup();
  const armed = await ok("files.armDownload", { path: "/Users/me/Desktop/left.zip" });
  native.place = () => ({ ok: true, path: "/Users/me/Desktop/left.zip", bytes: 7, sourceLeft: true });
  stub.emitDownload(download({ id: "left", path: "/Volumes/Other/left.zip" }));
  stub.emitDownload(download({ id: "left", path: "/Volumes/Other/left.zip", state: "finished" }));
  for (let i = 0; i < 10 && !native.placed.length; i++) await tick();
  await tick();
  const row = (await ok("files.arms", { arms: [armed.arm] })).items[0];
  assert.equal(row.downloads[0].sourceLeft, true);
});

test("spaces.list pages", async () => {
  await setup();
  S().createProfile({ name: "Work" });
  S().createProfile({ name: "Home" });
  const first = await ok("spaces.list", { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.total >= 3);
  assert.equal(first.nextOffset, 1);
  const rest = await ok("spaces.list", { offset: 1 });
  assert.equal(rest.items.length, first.total - 1);
  assert.equal(rest.nextOffset, null);
});

test("an old download re-announced after the arm (a profile loading its history) never takes it", async () => {
  await setup();
  const armed = await ok("files.armDownload", { path: "/Users/me/Desktop/new.zip" });
  stub.emitDownload(download({ id: "history", path: "/Users/me/Downloads/old.zip", state: "finished", startTime: armed.armedAt - 86_400_000 }));
  stub.emitDownload(download({ id: "just-before", path: "/Users/me/Downloads/before.zip", state: "finished", startTime: armed.armedAt - 1000 }));
  stub.emitDownload(download({ id: "a-ms-before", path: "/Users/me/Downloads/ms.zip", state: "finished", startTime: Math.floor(armed.armedAt) - 1 }));
  await tick();
  assert.equal(native.claims.length, 0, "a download that started before the arm, even by a second or a millisecond, isn't offered to it");
  stub.emitDownload(download({ id: "fresh", path: "/Users/me/Downloads/fresh.zip", startTime: Math.floor(armed.armedAt) }));
  await tick();
  assert.deepEqual(native.claims.map(([arm, id]) => [arm, id]), [[armed.arm, "fresh"]]);
});

test("a cancelled or failed claimed download releases its native claim and places nothing", async () => {
  await setup();
  const armed = await ok("files.armDownload", { path: "/Users/me/Desktop/gone.zip" });
  stub.emitDownload(download({ id: "gone", path: "/Users/me/Downloads/gone.zip" }));
  await tick();
  stub.emitDownload(download({ id: "gone", path: "/Users/me/Downloads/gone.zip", state: "cancelled" }));
  await tick();
  assert.deepEqual(native.released, [[armed.arm, "gone", "cancelled"]]);
  assert.equal(native.placed.length, 0);
  const row = (await ok("files.arms", { arms: [armed.arm] })).items[0];
  assert.equal(row.downloads[0].state, "cancelled");
});

test("a fast download whose first event with a path is finished goes to the arm, never also to a hooks.json folder rule", async () => {
  await setup();
  const { startDownloadHooks, resetDownloadHooksForTests } = await import("./downloadHooks.ts");
  const { reloadHooks } = await import("./hookRules.ts");
  stub.configFolder.files.set("hooks.json", JSON.stringify({ hooks: [{ name: "all", on: "download.deciding", folder: "~/Downloads/Sorted" }] }));
  reloadHooks();
  resetDownloadHooksForTests();
  const moves = [];
  startDownloadHooks({ move: async (path, folder) => (moves.push([path, folder]), { ok: true, path }), approveFolders: () => {} });
  const armed = await ok("files.armDownload", { path: "/Users/me/Desktop/fast.zip" });
  stub.emitDownload(download({ id: "fast", path: "", state: "downloading", received: 0 }));
  stub.emitDownload(download({ id: "fast", path: "/Users/me/Downloads/fast.zip", state: "finished", received: 100 }));
  for (let i = 0; i < 20 && !native.placed.length; i++) await tick();
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(native.placed, [[armed.arm, "fast", "/Users/me/Downloads/fast.zip"]], "the arm placed it");
  assert.deepEqual(moves, [], "the folder rule never moved it");
  stub.emitDownload(download({ id: "other", path: "", state: "downloading", received: 0 }));
  stub.emitDownload(download({ id: "other", path: "/Users/me/Downloads/other.zip", state: "finished", received: 100 }));
  for (let i = 0; i < 20 && !moves.length; i++) await tick();
  assert.deepEqual(moves, [["/Users/me/Downloads/other.zip", "~/Downloads/Sorted"]], "positive control: an unarmed download still follows the rule");
  resetDownloadHooksForTests();
  stub.configFolder.files.delete("hooks.json");
  reloadHooks();
});

test("a prompted download whose first event with a path is already cancelled releases its staging and reports cancelled", async () => {
  await setup();
  const armed = await ok("files.armDownload", { path: "/Users/me/Desktop/never.zip" });
  const stagedPath = native.answerSavePanel(armed.arm);
  assert.ok(stagedPath);
  stub.emitDownload(download({ id: "never", path: stagedPath, state: "cancelled", startTime: armed.armedAt + 10 }));
  await tick();
  assert.deepEqual(native.claims.map(([arm, id]) => [arm, id]), [[armed.arm, "never"]], "it is claimed by the arm whose staging it used");
  assert.deepEqual(native.released, [[armed.arm, "never", "cancelled"]], "and its claim is released at once");
  assert.equal(native.placed.length, 0);
  const row = (await ok("files.arms", { arms: [armed.arm] })).items[0];
  assert.equal(row.state, "cancelled");
  assert.deepEqual(row.downloads.map((d) => [d.downloadId, d.state]), [["never", "cancelled"]]);
  stub.emitDownload(download({ id: "elsewhere", path: "/Users/me/Downloads/elsewhere.zip", state: "failed", startTime: armed.armedAt + 20 }));
  await tick();
  assert.equal(native.claims.filter(([, id]) => id === "elsewhere").length, 0, "a failed download outside any staging folder never claims an arm");
});

async function withClockAhead(ms, work) {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await work();
  } finally {
    Date.now = realNow;
  }
}

test("closing a tab 11 minutes after its upload was answered still drops the copies the page was given", async () => {
  const windowId = await setup();
  await ok("apply", { ops: [{ op: "open", urls: ["https://uploads.example/"], window: windowId }] });
  const tab = S().windows[windowId].tabIds.find((t) => S().tabs[t].url.includes("uploads.example"));
  const armed = await ok("files.armUpload", { tab, paths: ["/Users/me/report.pdf"] });
  const row = native.rows.find((r) => r.id === armed.arm);
  row.state = "answered";
  row.answered = 1;
  row.landed = ["/Users/me/report.pdf"];
  await ok("files.arms", {});
  await withClockAhead(11 * 60_000, async () => {
    await ok("files.arms", {});
    S().closeTab(tab);
    await tick();
  });
  assert.ok(native.disarmed.some(([ids, purge]) => Array.isArray(ids) && ids.includes(armed.arm) && purge), "the tab closing still disarms the answered arm and drops its copies");
});

test("a staged download whose first path event arrives 13 minutes after a 2-minute arm answered its save panel is still claimed and placed", async () => {
  await setup();
  const armed = await ok("files.armDownload", { path: "/Users/me/Desktop/slow.zip" });
  const stagedPath = native.answerSavePanel(armed.arm);
  assert.ok(stagedPath);
  await ok("files.arms", {});
  await withClockAhead(13 * 60_000, async () => {
    await ok("files.arms", {});
    stub.emitDownload(download({ id: "slow-start", path: stagedPath, startTime: armed.armedAt + 500 }));
    stub.emitDownload(download({ id: "slow-start", path: stagedPath, state: "finished", startTime: armed.armedAt + 500 }));
    for (let i = 0; i < 20 && !native.placed.length; i++) await tick();
  });
  assert.deepEqual(native.placed, [[armed.arm, "slow-start", stagedPath]]);
});

test("file methods refuse where the platform can't answer panels", async () => {
  const windowId = await setup();
  native.supported = false;
  const reply = await call("files.armUpload", { tab: tabIn(windowId), paths: ["/tmp/a"] });
  assert.equal(reply.error.code, "refused");
  assert.deepEqual(await ok("files.arms", {}), { items: [] });
  native.supported = true;
});

test("localPathProblem refuses every hostile string that isn't a plain absolute path", () => {
  let accepted = 0;
  for (const { value } of HOSTILE_STRINGS) {
    const problem = localPathProblem(value);
    if (problem === null) {
      accepted++;
      assert.ok(value.startsWith("/"), JSON.stringify(value).slice(0, 80));
      assert.doesNotMatch(value, /[\0\r\n]/);
      assert.ok(!value.split("/").includes(".."));
    }
  }
  assert.equal(localPathProblem("/Users/me/file.txt"), null, "a plain path passes");
  for (const value of [null, undefined, 1, {}, [], "", "~/x", "../x", "/a/../b", "/a b".replace(" ", "\n")]) assert.notEqual(localPathProblem(value), null, String(value));
});

test("spaces.list counts each profile's tabs and groups and leaves private windows out", async () => {
  const windowId = await setup();
  const tab = tabIn(windowId);
  S().createWindow({ url: "https://p.example/", kind: "private" });
  const listed = await ok("spaces.list");
  const space = listed.items.find((s) => s.id === S().windows[windowId].profileId);
  assert.ok(space);
  assert.equal(space.profileId, space.id);
  assert.equal(space.active, true);
  assert.equal(space.tabCount, Object.values(S().tabs).filter((t) => t.profileId === space.id && S().windows[t.windowId]?.kind !== "private").length);
  assert.ok(space.windowIds.includes(windowId));
  assert.equal(typeof space.groupCount, "number");
  assert.ok(tab);
});

test("tabGroups.list lists groups with their tabs and filters by space", async () => {
  const windowId = await setup();
  const profileId = S().windows[windowId].profileId;
  const made = await ok("apply", { ops: [{ op: "group.create", urls: ["https://c.example/", "https://d.example/"], name: "Research", window: windowId }] });
  assert.ok(made.ok, JSON.stringify(made));
  const listed = await ok("tabGroups.list", {});
  const group = listed.items.find((g) => g.title === "Research");
  assert.ok(group, JSON.stringify(listed));
  assert.equal(group.spaceId, profileId);
  assert.equal(group.windowId, windowId);
  assert.deepEqual(group.tabIds, group.tabs.map((t) => t.id));
  assert.ok(group.tabs.every((t) => typeof t.url === "string" && typeof t.title === "string" && typeof t.active === "boolean"));
  assert.equal((await ok("tabGroups.list", { space: profileId })).items.length, listed.items.length);
  assert.equal((await call("tabGroups.list", { space: "nope" })).error.code, "no_window");
});

test("bookmarks.search filters by folder and names each hit's folders", async () => {
  await setup();
  const tree = await ok("bookmarks.tree");
  const work = await ok("bookmarks.addFolder", { title: "Work", parent: tree.other.id });
  const deep = await ok("bookmarks.addFolder", { title: "Specs", parent: work.id });
  const link = await ok("bookmarks.add", { url: "https://spec.example/", title: "Spec", parent: deep.id });
  await ok("bookmarks.add", { url: "https://elsewhere.example/", title: "Spec too" });
  const inWork = await ok("bookmarks.search", { folder: work.id, query: "spec" });
  assert.deepEqual(inWork.items.map((n) => n.id).sort(), [deep.id, link.id].sort());
  const hit = inWork.items.find((n) => n.id === link.id);
  assert.deepEqual(hit.folderPath, [tree.other.title, "Work", "Specs"]);
  assert.equal((await call("bookmarks.search", { folder: link.id })).error.code, "bad_request");
});

test("tabGroups.list clips huge tab URLs and caps a group's tabs so one group fits on a line", async () => {
  const windowId = await setup();
  const urls = Array.from({ length: 6 }, (_, i) => `https://huge.example/${i}`);
  const made = await ok("apply", { ops: [{ op: "group.create", urls, name: "Huge", window: windowId }] });
  assert.ok(made.ok);
  const group = Object.values(S().groups).find((g) => g.name === "Huge");
  const long = `https://huge.example/${"x".repeat(200_000)}`;
  useBrowser.setState((s) => ({ tabs: Object.fromEntries(Object.entries(s.tabs).map(([id, t]) => [id, group.tabIds.includes(id) ? { ...t, url: long, title: "t".repeat(5000) } : t])) }));
  const reply = await call("tabGroups.list", { limit: 1 });
  assert.ok(!reply.error, JSON.stringify(reply.error));
  const row = reply.result.items.find((g) => g.title === "Huge");
  assert.ok(row);
  assert.ok(row.tabs.every((t) => t.url.length <= 2048 && t.title.length <= 512 && t.clipped.includes("url") && t.clipped.includes("title")));
  assert.ok(JSON.stringify(reply).length < 1024 * 1024);
});
