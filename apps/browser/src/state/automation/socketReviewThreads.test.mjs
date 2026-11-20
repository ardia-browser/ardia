import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, controlOn, tick } = await import("./fixtures/socketHarness.mjs");
const { useBrowser } = await import("../browser/store.ts");
const { pinKeyOf } = await import("../browser/model.ts");
const { bindFolder, unbindFolder } = await import("../sharedFolders/store.ts");
const { SocketOrigin } = await import("./socketSharedChokePoint.ts");
const { tryAddAirTrafficRule, currentAirTraffic } = await import("../airTraffic/store.ts");
const { useAirTraffic } = await import("../airTraffic/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { toggleReader, readerState } = await import("../reader/reader.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
const stub = await import("../../test-native/index.ts");

after(() => S().updateSettings({ cliControl: false }));

let nextId = 0;
async function send(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 99, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  for (let i = 0; i < 400; i++) {
    const reply = stub.controlSocket.replies.slice(before).map((r) => JSON.parse(r.line)).find((r) => r.id === id);
    if (reply) return reply;
    await tick();
  }
  throw new Error(`no reply to ${method}`);
}
const errorOf = (reply) => reply?.error ?? reply?.result?.error ?? null;

let bound = null;
async function fixture() {
  if (bound) unbindFolder(...bound);
  S().hydrate({});
  useAirTraffic.setState((st) => ({ config: { ...st.config, rules: [] } }));
  await controlOn();
  const windowId = S().createWindow({ url: "https://home.example/" });
  const tab = (url, w = windowId) => S().newTab(w, { url, background: true });
  const one = tab("https://one.example/");
  const two = tab("https://two.example/");
  const plainMember = tab("https://plain.example/");
  const loose = tab("https://loose.example/");
  const shared = S().groupTabs([one, two], { pinned: true, name: "Team" });
  const plain = S().groupTabs([plainMember], { name: "Plain" });
  const elsewhere = S().createProfile({ name: "Elsewhere" });
  const w2 = S().createWindow({ url: "https://second.example/", profileId: elsewhere });
  const otherTeam = S().groupTabs([S().newTab(w2, { url: "https://w2.example/", background: true })], { name: "Team" });
  const profileId = S().groups[shared].profileId;
  const key = pinKeyOf(S().groups[shared]);
  bindFolder(profileId, key, "/scratch/Ardia Shared/Team", { device: 1, inode: 11 });
  bound = [profileId, key];
  return { windowId, w2, one, two, plainMember, loose, shared, plain, otherTeam, profileId, key };
}

test("opening into an ordinary group that shares a shared folder's name in another profile works, and naming the shared one by name still can't rename it", async () => {
  const f = await fixture();
  const opened = await send("apply", { ops: [{ op: "open", urls: ["https://into.example/"], group: { name: "Team" }, window: f.w2 }] });
  assert.equal(opened.result?.ok, true, JSON.stringify(opened));
  S().setFocusedWindow(f.windowId);
  const renamed = await send("apply", { ops: [{ op: "group.update", group: { name: "Team" }, name: "Renamed" }] });
  assert.equal(errorOf(renamed)?.code, "refused", JSON.stringify(renamed));
  assert.equal(S().groups[f.shared].name, "Team");
});

test("a refused split puts the ordinary group's member back in its group", async () => {
  const f = await fixture();
  const reply = await send("splits.create", { tabs: [f.one, f.plainMember] });
  assert.equal(errorOf(reply)?.code, "refused", JSON.stringify(reply));
  assert.ok(S().groups[f.plain]?.tabIds.includes(f.plainMember), "the ordinary group keeps its member");
});

test("a refused change keeps a tab activated alongside it when that tab is still there", async () => {
  const f = await fixture();
  S().activate(f.one);
  const origin = new SocketOrigin();
  origin.segment();
  useBrowser.setState((s) => ({ tabs: { ...s.tabs, [f.two]: { ...s.tabs[f.two], url: "https://changed.example/", pinnedUrl: "https://changed.example/" } } }));
  S().activate(f.loose);
  const answer = origin.settle({ ok: true }, (message) => ({ refused: message }));
  assert.ok(answer.refused);
  const w = S().windows[f.windowId];
  assert.equal(w.activeTabIds[w.profileId], f.loose);
});

test("run closeTab on a shared member while the panel is open only closes the panel", async () => {
  const f = await fixture();
  S().activate(f.one);
  S().openPanel(f.windowId, "https://one.example/");
  const reply = await send("run", { command: "closeTab", window: f.windowId });
  assert.ok(!errorOf(reply), JSON.stringify(reply));
  assert.ok(S().tabs[f.one], "the member is still open");
});

test("an Air Traffic rule whose group is gone can still be turned off, and one into a shared folder can't be turned on", async () => {
  const f = await fixture();
  const plainKey = pinKeyOf(S().groups[f.plain]);
  const added = tryAddAirTrafficRule({ enabled: true, from: null, when: { kind: "any" }, profileId: f.profileId, open: "tab", groupKey: plainKey });
  S().ungroup(f.plain);
  const off = await send("airTraffic.updateRule", { id: added.id, enabled: false });
  assert.ok(!errorOf(off), JSON.stringify(off));
  const intoShared = tryAddAirTrafficRule({ enabled: false, from: null, when: { kind: "any" }, profileId: f.profileId, open: "tab", groupKey: f.key });
  const on = await send("airTraffic.updateRule", { id: intoShared.id, enabled: true });
  assert.equal(errorOf(on)?.code, "refused", JSON.stringify(on));
  assert.equal(currentAirTraffic().rules.find((r) => r.id === intoShared.id).enabled, false);
});

test("profiles.delete doesn't delete a profile that gained a shared folder while its question was open", async () => {
  await fixture();
  const side = S().createProfile({ name: "Side" });
  const sideWindow = S().createWindow({ url: "https://side.example/", profileId: side });
  const sideGroup = S().groupTabs([S().newTab(sideWindow, { url: "https://s.example/", background: true })], { pinned: true, name: "Side Team" });
  const dialogs = shellNativeModules.ArdiaDialogs;
  const confirm = dialogs.confirm;
  dialogs.confirm = async () => {
    bindFolder(side, pinKeyOf(S().groups[sideGroup]), "/scratch/Ardia Shared/Side", { device: 1, inode: 12 });
    return { confirmed: true, suppressed: false };
  };
  try {
    await send("profiles.delete", { profile: side });
    assert.ok(S().profiles[side], "the profile is still there");
  } finally {
    dialogs.confirm = confirm;
    unbindFolder(side, pinKeyOf(S().groups[sideGroup]));
  }
});

test("a reader toggle whose request is gone still records what the page shows, and skips only the look write", async () => {
  const f = await fixture();
  const tabId = S().newTab(f.windowId, { url: "https://article.example/story" });
  const size = S().settings.readerTextSize;
  webviews.set(tabId, { evaluate: async () => ({ active: true, look: { size: size === "large" ? "small" : "large", font: "sans" } }) });
  try {
    await toggleReader(tabId, () => false);
    assert.equal(readerState(tabId).active, true, "the reader state follows the page");
    assert.equal(S().settings.readerTextSize, size, "the look wasn't written");
  } finally {
    webviews.delete(tabId);
  }
});

test("offscreen keeps the store in step with a move that already happened, even if the client left meanwhile", async () => {
  const f = await fixture();
  globalThis.acTestCliOwns = () => ({ owned: true, shown: false });
  globalThis.acTestCliMoveOffscreen = () => (S().updateSettings({ cliControl: false }), { ok: true });
  try {
    await send("offscreen", { tab: f.loose }).catch(() => null);
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(S().tabs[f.loose], undefined, "the moved tab left the store");
  } finally {
    delete globalThis.acTestCliOwns;
    delete globalThis.acTestCliMoveOffscreen;
  }
});

test("the Air Traffic fallback can't be pointed into a shared folder", async () => {
  const f = await fixture();
  const before = currentAirTraffic().fallback;
  const reply = await send("airTraffic.setFallback", { profile: f.profileId, group: f.shared, open: "tab" });
  assert.equal(errorOf(reply)?.code, "refused", JSON.stringify(reply));
  assert.deepEqual(currentAirTraffic().fallback, before);
});
