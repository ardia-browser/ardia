import assert from "node:assert/strict";
import { after, test } from "node:test";

const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { reloadHooks, useHookRules } = await import("./hookRules.ts");
const { approveRule, resetApprovalsForTests } = await import("./approvals.ts");
const { approvalFor } = await import("./hookPolicy.ts");
const { startDecideHooks } = await import("./decideHooks.ts");
const { openExternalUrls } = await import("../littleArdia/actions.ts");
const airTraffic = await import("../airTraffic/store.ts");
const { takeAirTrafficCounts } = await import("../telemetry/airTrafficCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");

const S = () => useBrowser.getState();
after(() => S().updateSettings({ cliControl: false }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;

function call(method, params, connection) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, params }) });
  return JSON.parse(stub.controlSocket.replies.slice(before).find((r) => r.connection === connection).line);
}

test("a link opened with sharing off isn't counted by an air traffic rule when its tab.opening hook answers after sharing turns on", async () => {
  const hooks = [{ name: "prog", on: "tab.opening", run: ["~/bin/decide"] }];
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  resetApprovalsForTests();
  stub.configFolder.files.set("hooks.json", JSON.stringify({ hooks }));
  reloadHooks();
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  startDecideHooks();
  approveRule(approvalFor(useHookRules.getState().hooks[0]).key);
  const runner = 900;
  call("subscribe", { events: ["tab.opened"], hooks }, runner);
  airTraffic.resetAirTrafficForTests({ rules: [{ id: "r", enabled: true, from: null, when: { kind: "any" }, profileId: null, open: "tab" }], fallback: null });
  S().createWindow({ url: "https://a.example/" });
  takeAirTrafficCounts();
  setConsentPeriod(false, null);
  const from = stub.controlSocket.broadcasts.length;
  openExternalUrls(["https://news.example/"], undefined, { bundleId: "com.apple.mail", appName: "Mail" });
  const request = stub.controlSocket.broadcasts.slice(from).map((b) => JSON.parse(b.line)).find((l) => l.decide && l.event === "tab.opening");
  assert.ok(request, "the tab.opening hook was asked");
  setConsentPeriod(true, "link-gate-after");
  assert.deepEqual(call("answer", { decide: request.decide, answer: {} }, runner).result, { ok: true });
  for (let i = 0; i < 10; i++) await tick();
  assert.ok(Object.values(S().tabs).some((t) => t.url === "https://news.example/"), "the link opened");
  assert.equal(takeAirTrafficCounts().air_traffic_rule_links, 0);
});
