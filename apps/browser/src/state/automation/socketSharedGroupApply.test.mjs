import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { pinKeyOf } = await import("../browser/model.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { bindFolder, unbindFolder } = await import("../sharedFolders/store.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;

async function call(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 41, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, params }) });
  for (let i = 0; i < 200 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === 41); i++) await tick();
  const replies = stub.controlSocket.replies.slice(before).filter((r) => r.connection === 41);
  assert.equal(replies.length, 1, `one reply to ${method}`);
  return JSON.parse(replies[0].line);
}

async function setup() {
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const windowId = S().createWindow({ url: "https://home.example/" });
  const one = S().newTab(windowId, { url: "https://one.example/", background: true });
  const two = S().newTab(windowId, { url: "https://two.example/", background: true });
  const loose = S().newTab(windowId, { url: "https://loose.example/", background: true });
  const shared = S().groupTabs([one, two], { pinned: true, name: "Team" });
  const inner = S().newNestedGroup(shared);
  S().updateGroup(inner, { name: "Inner" });
  const profileId = S().groups[shared].profileId;
  const key = pinKeyOf(S().groups[shared]);
  bindFolder(profileId, key, "/scratch/Ardia Shared/Team", { device: 1, inode: 2 });
  return { windowId, one, two, loose, shared, inner, done: () => unbindFolder(profileId, key) };
}

const snapshot = (w) => JSON.stringify({ tabs: S().windows[w].tabIds, groups: Object.values(S().groups).map((g) => [g.id, g.name, g.parentId, g.tabIds]), titles: Object.values(S().tabs).map((t) => [t.id, t.customTitle ?? null]) });

test("socket apply refuses any change to a shared folder group's membership, order, titles or nesting", async () => {
  const { windowId, one, two, loose, shared, inner, done } = await setup();
  try {
    const before = snapshot(windowId);
    const changes = [
      ["move a tab into it", { op: "tab.move", tabs: [loose], group: shared }],
      ["move a tab in beside a member", { op: "tab.move", tabs: [loose], after: one }],
      ["move a tab out of it", { op: "tab.move", tabs: [one], group: null }],
      ["reorder inside it", { op: "tab.move", tabs: [one], after: two }],
      ["rename a member", { op: "tab.rename", tab: one, title: "Renamed" }],
      ["rename the group", { op: "group.update", group: shared, name: "Other" }],
      ["rename a nested group", { op: "group.update", group: inner, name: "Other" }],
      ["open a tab into it", { op: "open", urls: ["https://new.example/"], group: shared }],
      ["nest a new group in it", { op: "group.create", tabs: [loose], parent: shared }],
      ["move a nested group out", { op: "group.move", group: inner, parent: null }],
      ["ungroup a nested group", { op: "group.ungroup", group: inner }],
      ["close a member", { op: "tab.close", tabs: [two] }],
      ["unpin a member", { op: "tab.unpin", tabs: [one] }],
    ];
    for (const [what, op] of changes) {
      const reply = await call("apply", { ops: [op] });
      const error = reply.error ?? reply.result?.error;
      assert.equal(error?.code, "refused", `${what}: ${JSON.stringify(reply)}`);
      assert.match(error.message, /shared folder groups change only from the sidebar/, what);
      assert.equal(snapshot(windowId), before, `${what} changed nothing`);
    }
    const tiles = await call("pins.createFolder", { tabs: [one, loose] });
    assert.equal(tiles.error?.code, "refused", JSON.stringify(tiles));
    assert.equal(snapshot(windowId), before, "a tile folder took no member");
    const sharedKey = pinKeyOf(S().groups[shared]);
    const routed = await call("airTraffic.addRule", { when: { kind: "any" }, open: "tab", profile: S().groups[shared].profileId, group: sharedKey });
    assert.equal(routed.error?.code, "refused", JSON.stringify(routed));
    const fine = await call("apply", { ops: [{ op: "tab.mute", tabs: [one] }, { op: "tab.move", tabs: [loose], before: shared }, { op: "group.update", group: shared, color: "blue" }] });
    assert.equal(fine.result?.ok, true, `muting a member, placing a tab beside the folder and recolouring it still work: ${JSON.stringify(fine)}`);
  } finally {
    done();
  }
});
