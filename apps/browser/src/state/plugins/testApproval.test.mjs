import assert from "node:assert/strict";
import { test } from "node:test";

const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { approveForTests, testApprovedNames } = await import("./testApproval.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");

const host = stub.pluginHost;
const P = () => usePlugins.getState();
const DOC = { manifest: 2, name: "scratch", title: "Scratch", main: "dist/index.js", permissions: { storage: true }, contributes: { commands: [{ name: "go", title: "Go" }] } };

test("names come from a comma or space separated list and only valid plugin names count", () => {
  assert.deepEqual([...testApprovedNames("notes, scratch tool-1 ,Bad,../x")], ["notes", "scratch", "tool-1"]);
  assert.equal(testApprovedNames(null).size, 0);
});

test("a listed local plugin is approved and turned on, again after its manifest changes, never an unlisted one", async () => {
  useBrowser.getState().hydrate({});
  startPlugins();
  host.folders = [
    { name: "scratch", status: "ok", text: JSON.stringify(DOC) },
    { name: "other", status: "ok", text: JSON.stringify({ ...DOC, name: "other" }) },
  ];
  await lifecycle.rescanPlugins(consentToken());
  assert.deepEqual(approveForTests(new Set(["scratch"])), ["scratch"]);
  assert.equal(P().records.scratch.enabled, true);
  assert.equal(P().records.scratch.approved, P().listings.scratch.hash);
  assert.equal(P().records.other?.enabled ?? false, false);
  assert.equal(P().consent, null);
  assert.deepEqual(approveForTests(new Set(["scratch"])), [], "already approved");
  host.folders = [{ name: "scratch", status: "ok", text: JSON.stringify({ ...DOC, version: "1.0.1" }) }];
  await lifecycle.rescanPlugins(consentToken());
  assert.deepEqual(approveForTests(new Set(["scratch"])), ["scratch"]);
  assert.equal(P().records.scratch.approved, P().listings.scratch.hash);
});

test("a plugin with problems or one another sheet is asking about is left alone", async () => {
  host.folders = [
    { name: "scratch", status: "ok", text: JSON.stringify({ ...DOC, contributes: { commands: [{ name: "go" }] } }) },
    { name: "other", status: "ok", text: JSON.stringify({ ...DOC, name: "other" }) },
  ];
  await lifecycle.rescanPlugins(consentToken());
  assert.ok(P().listings.scratch.problems.length);
  assert.ok(lifecycle.requestPluginConsent("other"));
  assert.deepEqual(approveForTests(new Set(["scratch"])), []);
  lifecycle.dismissPluginConsent("other");
});
