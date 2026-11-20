import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "plugin-event-redaction-test");

const FIXTURE = JSON.parse(readFileSync(new URL("../../../../../tests/fixtures/plugins/example/plugin.json", import.meta.url), "utf8"));
const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};
const host = stub.pluginHost;
let nextId = 0;
after(() => lifecycle.disablePlugin("example"));

async function enabledWith(permissions) {
  S().hydrate({});
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name);
  for (const key of ["starts", "stops", "replies", "events", "removed"]) host[key].length = 0;
  const doc = { ...FIXTURE, hooks: [...FIXTURE.hooks, "history.removed"], permissions: [...new Set([...(FIXTURE.permissions ?? []), ...permissions])] };
  host.folders = [{ name: "example", status: "ok", text: JSON.stringify(doc) }];
  await lifecycle.rescanPlugins(consentToken());
  assert.ok(lifecycle.requestPluginConsent("example"));
  assert.ok(lifecycle.enablePlugin("example", P().consent.hash));
  await settle();
  return P().processes.example.run;
}

async function removalsSeen(run) {
  const id = ++nextId;
  stub.emitPluginLine({ name: "example", run, line: JSON.stringify({ id, method: "subscribe", params: { events: ["*"] } }) });
  await settle();
  const from = host.events.length;
  stub.chromeHistoryEvent({ kind: "deleted", profile: "", all: false, urls: ["https://bank.example/statement?account=42#row", "https://plain.example/"] });
  await settle();
  return host.events.slice(from).map((e) => JSON.parse(e.line)).filter((e) => e.event === "history.removed");
}

test("history.removed reaches a plugin without queries or fragments unless it holds fullUrls", async () => {
  const plain = await removalsSeen(await enabledWith([]));
  assert.equal(plain.length, 1);
  assert.deepEqual(plain[0].data.urls, ["https://bank.example/statement", "https://plain.example/"]);
  lifecycle.disablePlugin("example");
  const full = await removalsSeen(await enabledWith(["fullUrls"]));
  assert.deepEqual(full[0].data.urls, ["https://bank.example/statement?account=42#row", "https://plain.example/"]);
});
