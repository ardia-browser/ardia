import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, socketClient, freshWindow, tick } = await import("./fixtures/socketHarness.mjs");
const { runMethod } = await import("./controlSocket.ts");
const { COMMANDS } = await import("../commands/commandCatalog.ts");
const { useLifecycle } = await import("../tabs/sleepingTabs.ts");
const { webviews } = await import("../../platform/webviews.ts");
const stub = await import("../../test-native/index.ts");

after(() => S().updateSettings({ cliControl: false }));

test("a background instance runs no command at all; a visible one still does", async () => {
  const { windowId, tab } = await freshWindow("https://one.example/");
  const two = S().newTab(windowId, { url: "https://two.example/" });
  S().activate(tab);
  for (const command of Object.keys(COMMANDS)) {
    const reply = runMethod({ command, window: windowId }, true);
    assert.equal(reply.error?.code, "refused", command);
    assert.match(reply.error.message, /run isn't available in background instances; use the dedicated methods/);
  }
  assert.equal(S().windows[windowId].activeTabIds[S().windows[windowId].profileId], tab, "nextTab didn't activate the lazy tab");
  assert.ok(!runMethod({ command: "nextTab", window: windowId }, false).error, "a visible instance still runs it");
  assert.equal(S().windows[windowId].activeTabIds[S().windows[windowId].profileId], two);
});

test("a wake stopped partway still reports the tabs it already changed", async () => {
  const { windowId } = await freshWindow();
  const loaded = S().newTab(windowId, { url: "https://first.example/", background: true });
  S().updateTab(loaded, { page: { kind: "asleep" } });
  const second = S().newTab(windowId, { url: "https://second.example/", background: true });
  useLifecycle.setState((l) => ({ discarded: { ...l.discarded, [second]: true } }));
  let attached;
  webviews.set(second, { isAttached: () => new Promise((resolve) => (attached = resolve)), reload: () => Promise.resolve() });
  try {
    const client = socketClient(271);
    const waking = client.fire("apply", { ops: [{ op: "tab.wake", tabs: [loaded, second] }] });
    for (let i = 0; i < 50 && !attached; i++) await tick();
    assert.ok(attached);
    stub.emitControlClose(271);
    attached(true);
    const reply = await waking;
    assert.equal(reply.result.ok, false);
    assert.deepEqual(reply.result.error.changed?.tabs, [loaded], JSON.stringify(reply.result.error));
  } finally {
    webviews.delete(second);
    useLifecycle.setState({ discarded: {} });
  }
});
