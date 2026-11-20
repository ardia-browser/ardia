import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, controlOn, tick } = await import("./fixtures/socketHarness.mjs");
const { pinKeyOf } = await import("../browser/model.ts");
const { bindFolder, unbindFolder } = await import("../sharedFolders/store.ts");
const { changesSharedFolders } = await import("./socketSharedChokePoint.ts");
const stub = await import("../../test-native/index.ts");

after(() => S().updateSettings({ cliControl: false }));

let nextId = 0;
async function send(method, params, waitTicks = 400) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 91, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  for (let i = 0; i < waitTicks; i++) {
    const reply = stub.controlSocket.replies.slice(before).map((r) => JSON.parse(r.line)).find((r) => r.id === id);
    if (reply) return reply;
    await tick();
  }
  return null;
}
const errorOf = (reply) => reply?.error ?? reply?.result?.error ?? null;

let bound = null;
async function fixture() {
  if (bound) unbindFolder(...bound);
  S().hydrate({});
  await controlOn();
  const windowId = S().createWindow({ url: "https://home.example/" });
  const one = S().newTab(windowId, { url: "https://one.example/", background: true });
  const two = S().newTab(windowId, { url: "https://two.example/", background: true });
  const blank = S().newTab(windowId, { url: "", background: true });
  const loose = S().newTab(windowId, { url: "https://loose.example/", background: true });
  const shared = S().groupTabs([one, two, blank], { pinned: true, name: "Team" });
  const inner = S().newNestedGroup(shared);
  S().updateGroup(inner, { name: "Inner" });
  const profileId = S().groups[shared].profileId;
  const key = pinKeyOf(S().groups[shared]);
  bindFolder(profileId, key, "/scratch/Ardia Shared/Team", { device: 1, inode: 3 });
  bound = [profileId, key];
  return { windowId, one, blank, loose, shared, inner, profileId, innerKey: pinKeyOf(S().groups[inner]) };
}

test("Codex's four socket paths into a shared folder group are refused and change nothing; muting a member still works", async () => {
  let f;
  for (const [what, method, params] of [
    ["run moveTabDown", "run", (x) => ({ command: "moveTabDown", tab: x.one })],
    ["run togglePin", "run", (x) => ({ command: "togglePin", tab: x.one })],
    ["splits.create pulling a loose tab in", "splits.create", (x) => ({ tabs: [x.loose, x.one] })],
    ["tabs.navigate on a blank member", "tabs.navigate", (x) => ({ tab: x.blank, url: "https://new.example/" })],
  ]) {
    f = await fixture();
    const before = S();
    const reply = await send(method, params(f));
    assert.equal(errorOf(reply)?.code, "refused", `${what}: ${JSON.stringify(reply)}`);
    assert.match(errorOf(reply).message, /shared folder groups change only from the sidebar/, what);
    assert.equal(changesSharedFolders(before, S()), false, `${what} left the folder as it was`);
  }
  f = await fixture();
  const rule = await send("airTraffic.addRule", { when: { kind: "any" }, open: "tab", profile: f.profileId, group: f.innerKey });
  assert.equal(errorOf(rule)?.code, "refused", `a rule into a nested group: ${JSON.stringify(rule)}`);
  const muted = await send("apply", { ops: [{ op: "tab.mute", tabs: [f.one] }] });
  assert.equal(errorOf(muted), null, JSON.stringify(muted));
  assert.equal(S().tabs[f.one].muted, true);
});

test("run closeTabGroup on a shared folder's group, or a group inside it, is refused and the group stays", async () => {
  for (const member of [(x) => x.one, (x) => S().groups[x.inner].tabIds[0]]) {
    const f = await fixture();
    S().activate(member(f));
    const reply = await send("run", { command: "closeTabGroup", window: f.windowId });
    assert.equal(errorOf(reply)?.code, "refused", JSON.stringify(reply));
    assert.ok(S().groups[f.shared] && S().groups[f.inner], "both groups stay");
  }
});

test("closeGroup checks its guard after each await and writes nothing once it fails", async () => {
  const { closeGroup } = await import("../browser/actions.ts");
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://home.example/" });
  const a = S().newTab(windowId, { url: "https://a.example/", background: true });
  const group = S().groupTabs([a], { name: "Plain" });
  await closeGroup(group, () => false);
  assert.ok(S().groups[group], "the group stays when the guard fails after the await");
  await closeGroup(group);
  assert.ok(!S().groups[group], "the group closes when nothing guards it");
});
