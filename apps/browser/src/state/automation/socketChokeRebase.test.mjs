import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, controlOn, tick } = await import("./fixtures/socketHarness.mjs");
const { useBrowser } = await import("../browser/store.ts");
const { pinKeyOf } = await import("../browser/model.ts");
const { bindFolder, unbindFolder } = await import("../sharedFolders/store.ts");
const { syncWriteHooks } = await import("../sharedFolders/syncWriteHooks.ts");
const { SocketOrigin } = await import("./socketSharedChokePoint.ts");
const stub = await import("../../test-native/index.ts");

after(() => S().updateSettings({ cliControl: false }));

let nextId = 0;
function emit(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 93, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  return (async () => {
    for (let i = 0; i < 400; i++) {
      const reply = stub.controlSocket.replies.slice(before).map((r) => JSON.parse(r.line)).find((r) => r.id === id);
      if (reply) return reply;
      await tick();
    }
    throw new Error(`no reply to ${method}`);
  })();
}

let bound = null;
async function fixture() {
  if (bound) unbindFolder(...bound);
  S().hydrate({});
  await controlOn();
  const windowId = S().createWindow({ url: "https://home.example/" });
  const one = S().newTab(windowId, { url: "https://one.example/", background: true });
  const two = S().newTab(windowId, { url: "https://two.example/", background: true });
  const loose = S().newTab(windowId, { url: "https://loose.example/", background: true });
  const other = S().newTab(windowId, { url: "https://other.example/", background: true });
  const shared = S().groupTabs([one, two], { pinned: true, name: "Team" });
  const profileId = S().groups[shared].profileId;
  const key = pinKeyOf(S().groups[shared]);
  bindFolder(profileId, key, "/scratch/Ardia Shared/Team", { device: 1, inode: 5 });
  bound = [profileId, key];
  return { windowId, one, two, loose, other, shared };
}

const swapMembers = (f) => useBrowser.setState((s) => ({ tabs: { ...s.tabs, [f.one]: { ...s.tabs[f.one], url: "https://changed.example/", pinnedUrl: "https://changed.example/" } } }));
const linkOf = (f) => S().tabs[f.one].pinnedUrl || S().tabs[f.one].url;
const moveUnrelated = (f) => useBrowser.setState((s) => ({ tabs: { ...s.tabs, [f.other]: { ...s.tabs[f.other], customTitle: "Moved meanwhile" } } }));

test("a read-only request is never refused for a change something else made while it ran, and nothing is undone", async () => {
  const f = await fixture();
  queueMicrotask(() => (moveUnrelated(f), swapMembers(f)));
  const reply = await emit("windows");
  assert.ok(!reply.error, JSON.stringify(reply.error));
  assert.equal(S().tabs[f.other].customTitle, "Moved meanwhile");
  assert.equal(linkOf(f), "https://changed.example/", "the read-only request undid nothing");
});

test("a refused request puts back only the shared folder's tree; an unrelated change made in the same stretch survives", async () => {
  const f = await fixture();
  const origin = new SocketOrigin();
  origin.segment();
  moveUnrelated(f);
  swapMembers(f);
  const answer = origin.settle({ ok: true }, (message) => ({ refused: message }));
  assert.ok(answer.refused, JSON.stringify(answer));
  assert.equal(linkOf(f), "https://one.example/", "the shared folder's tree is back");
  assert.equal(S().tabs[f.other].customTitle, "Moved meanwhile", "the unrelated change survived");
});

test("the shared-folder engine's own merge during an open check is neither undone nor blamed on the socket", async () => {
  const f = await fixture();
  queueMicrotask(() => syncWriteHooks.around(() => swapMembers(f)));
  const reply = await emit("apply", { ops: [{ op: "tab.mute", tabs: [f.loose] }] });
  assert.ok(!(reply.error ?? reply.result?.error), JSON.stringify(reply));
  assert.equal(linkOf(f), "https://changed.example/", "the engine's merge stays");
  assert.equal(S().tabs[f.loose].muted, true);
});

test("a guard called after the request answered opens no check", async () => {
  const f = await fixture();
  const origin = new SocketOrigin();
  origin.segment();
  origin.settle({ ok: true }, (m) => ({ error: m }));
  origin.segment();
  swapMembers(f);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(linkOf(f), "https://changed.example/", "nothing was rolled back");
  assert.equal(origin.vetoed, false);
});

test("every method in the catalogue says whether it changes anything, so the choke point knows which to check", async () => {
  const { methodsCatalog } = await import("./socketCatalog.ts");
  const { registerSocketAreas } = await import("./socketAreas.ts");
  registerSocketAreas();
  const unclassified = methodsCatalog().filter((m) => typeof m.mutates !== "boolean").map((m) => m.name);
  assert.deepEqual(unclassified, []);
});

test("reviewer repro: a sidebar link edit queued alongside an apply on a loose tab is neither undone nor blamed", async () => {
  const { foreignWriteHooks } = await import("../browser/foreignWriteHooks.ts");
  const f = await fixture();
  queueMicrotask(() => foreignWriteHooks.around(() => swapMembers(f)));
  const pending = emit("apply", { ops: [{ op: "tab.mute", tabs: [f.loose] }] });
  queueMicrotask(() => foreignWriteHooks.around(() => swapMembers(f)));
  const reply = await pending;
  assert.ok(!(reply.error ?? reply.result?.error), JSON.stringify(reply));
  assert.equal(linkOf(f), "https://changed.example/", "the sidebar's edit stays");
  assert.equal(S().tabs[f.loose].muted, true);
});

test("reviewer repro: an engine merge during an open check never absorbs the socket's own change", async () => {
  const f = await fixture();
  const origin = new SocketOrigin();
  origin.segment();
  swapMembers(f);
  syncWriteHooks.around(() => moveUnrelated(f));
  const answer = origin.settle({ ok: true }, (message) => ({ refused: message }));
  assert.ok(answer.refused, `the socket's change is still refused: ${JSON.stringify(answer)}`);
  assert.equal(linkOf(f), "https://one.example/", "the socket's change is undone");
  assert.equal(S().tabs[f.other].customTitle, "Moved meanwhile", "the engine's write stays");
});

test("reviewer repro: a person's closeTabGroup that lands while a socket apply's check is open stands, and the apply succeeds", async () => {
  const { runCommand } = await import("../commands/commands.ts");
  const { guardGroupClose } = await import("../groups/closeGuard.ts");
  const f = await fixture();
  let release;
  guardGroupClose(() => new Promise((resolve) => (release = resolve)));
  try {
    S().activate(f.one);
    runCommand({ command: "closeTabGroup", arg: null, windowId: f.windowId });
    for (let i = 0; i < 5 && !release; i++) await tick();
    assert.ok(release, "the close is waiting on its guard");
    release(true);
    const origin = new SocketOrigin();
    origin.segment();
    S().setMuted([f.loose], true);
    for (let i = 0; i < 5; i++) await tick();
    const answer = origin.settle({ ok: true }, (message) => ({ refused: message }));
    assert.deepEqual(answer, { ok: true }, "the apply isn't blamed for the person's close");
    assert.equal(S().groups[f.shared], undefined, "the person's close stands");
    assert.equal(S().tabs[f.loose].muted, true);
  } finally {
    guardGroupClose(async () => true);
  }
});
