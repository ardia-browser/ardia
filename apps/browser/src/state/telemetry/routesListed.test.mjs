import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { noteRoutesListed, takeInlineCompletionCounts } = await import("./inlineCompletionCounts.ts");
after(() => client.setSharing(false, "settings"));

const routesListed = () => takeInlineCompletionCounts().command_bar_routes_listed;

async function sentRoutes() {
  await client.saveQueueNow();
  const events = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events;
  return events.filter((e) => e.event === "usage_counts").map((e) => e.properties.command_bar_routes_listed ?? 0);
}

test("command bar lists that show several routes of one site apart are counted and reset once taken", () => {
  client.loadChoice();
  client.setSharing(true, "settings");
  takeInlineCompletionCounts();
  noteRoutesListed();
  noteRoutesListed();
  assert.equal(routesListed(), 2);
  assert.equal(routesListed(), 0);
});

test("a route list is counted only while the consent period it was seen in is still the current one", () => {
  client.loadChoice();
  client.setSharing(true, "settings");
  const seen = client.consentToken();
  takeInlineCompletionCounts();
  noteRoutesListed(seen);
  assert.equal(routesListed(), 1, "seen and counted in the same period");
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  noteRoutesListed(seen);
  assert.equal(routesListed(), 0, "seen in an earlier period: not counted in this one");
  noteRoutesListed(client.consentToken());
  assert.equal(routesListed(), 1, "seen in this period");
  client.setSharing(false, "settings");
  noteRoutesListed(client.consentToken());
  assert.equal(routesListed(), 0, "sharing off: nothing counted");
});

test("route lists counted before sharing was turned off and on again are not in the next report", async () => {
  client.loadChoice();
  client.setSharing(true, "settings");
  takeInlineCompletionCounts();
  noteRoutesListed(client.consentToken());
  noteRoutesListed(client.consentToken());
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  usage.sessionEnding();
  assert.ok((await sentRoutes()).every((n) => n === 0), "the earlier period's two lists were dropped at the boundary");
  assert.equal(routesListed(), 0, "and nothing is left waiting for the next hourly report");
});

test("a route list seen while sharing is on is sent in the next report", async () => {
  client.loadChoice();
  client.setSharing(true, "settings");
  takeInlineCompletionCounts();
  noteRoutesListed(client.consentToken());
  usage.sessionEnding();
  assert.equal((await sentRoutes()).at(-1), 1);
});
