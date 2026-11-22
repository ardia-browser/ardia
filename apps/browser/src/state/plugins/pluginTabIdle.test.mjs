import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("../automation/controlSocket.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");

const FIXTURE = JSON.parse(readFileSync(new URL("../../../../../tests/fixtures/plugins/example/plugin.json", import.meta.url), "utf8"));
const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};
const host = stub.pluginHost;
const MIN = 60_000;
const frozen = Date.now();
let skew = 0;
Date.now = () => frozen + skew;
const SOCKET = 7101;
let nextId = 0;
after(() => {
  stub.emitControlClose(SOCKET);
  lifecycle.disablePlugin("example");
});

async function idleTabsAndPlugin() {
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  startPlugins();
  await settle();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name);
  const doc = { ...FIXTURE, hooks: [...FIXTURE.hooks, "tab.idle", "tab.resumed"] };
  host.folders = [{ name: "example", status: "ok", text: JSON.stringify(doc) }];
  await lifecycle.rescanPlugins(consentToken());
  assert.ok(lifecycle.requestPluginConsent("example"));
  assert.ok(lifecycle.enablePlugin("example", P().consent.hash));
  await settle();
  const w = S().createWindow({ url: "https://a.com/" });
  const [b, c] = ["b", "c"].map((u) => S().newTab(w, { url: `https://${u}.com/page?account=42#row`, background: true }));
  for (const id of [b, c]) S().updateTab(id, { lastActiveAt: Date.now() - 30 * MIN + 1_000 });
  return P().processes.example.run;
}

const order = [];
for (const [list, kind] of [[host.replies, "reply"], [host.events, "event"], [stub.controlSocket.replies, "socket"], [stub.controlSocket.broadcasts, "socket"]]) {
  const push = list.push.bind(list);
  list.push = (...items) => {
    for (const item of items) order.push({ kind, item });
    return push(...items);
  };
}

const idleLines = (from, kind) =>
  order
    .slice(from)
    .filter((o) => o.kind === kind)
    .map((o) => JSON.parse(o.item.line))
    .filter((e) => e.event === "tab.idle" || e.event === "tab.resumed")
    .map((e) => `${e.event} ${e.data.url} ${e.data.idle}`)
    .sort();

test("a plugin joining a watched threshold catches up after its reply, redacted, and the socket client hears the newly idle tabs once", async () => {
  const run = await idleTabsAndPlugin();
  stub.emitControlRequest({ connection: SOCKET, generation: stub.controlSocket.generation, line: JSON.stringify({ id: ++nextId, method: "subscribe", params: { events: ["tab.idle"], idle: { tab: [1800] }, fullUrls: true } }) });
  await settle();
  skew += 2_000;
  const from = order.length;
  stub.emitPluginLine({ name: "example", run, line: JSON.stringify({ id: ++nextId, method: "subscribe", params: { events: ["tab.idle", "tab.resumed"], idle: { tab: [1800] } } }) });
  const mine = order.slice(from).filter((o) => o.kind !== "socket");
  assert.equal(mine[0]?.kind, "reply", "the subscribe reply comes before any idle event");
  assert.equal(JSON.parse(mine[0].item.line).result?.ok, true);
  assert.deepEqual(idleLines(from, "event"), ["tab.idle https://b.com/page 1800", "tab.idle https://c.com/page 1800"]);
  assert.deepEqual(idleLines(from, "socket"), ["tab.idle https://b.com/page?account=42#row 1800", "tab.idle https://c.com/page?account=42#row 1800"], "the socket client hears each newly idle tab once, in full");
  await settle();
  assert.equal(idleLines(from, "event").length, 2, "nothing more arrives later");
});
