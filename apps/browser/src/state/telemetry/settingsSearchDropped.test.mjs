import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { setSettingsQuery, dropSettingsSearch, settingsSearchHost } = await import("../settings/searchState.ts");
const { openSiteSettings } = await import("../settings/settingsWindows.ts");
after(() => client.setSharing(false, "settings"));

async function sent(field) {
  usage.emitWindowUsage(client.consentToken());
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "usage_counts").at(-1)?.properties?.[field] ?? 0;
}
const dropped = () => sent("settings_searches_dropped");

test("a search dropped by opening Settings at a place is counted only while sharing is on", async () => {
  client.setSharing(true, "onboarding");
  setSettingsQuery("theme");
  openSiteSettings("https://example.com", "default");
  setSettingsQuery("cookies");
  openSiteSettings("https://example.org", "default");
  assert.equal(await dropped(), 2);

  client.setSharing(false, "settings");
  setSettingsQuery("theme");
  openSiteSettings("https://example.com", "default");
  client.setSharing(true, "onboarding");
  assert.equal(await dropped(), 0, "a search dropped with sharing off is never counted");
});

test("a search dropped with a token from before sharing went off isn't counted", async () => {
  client.setSharing(true, "onboarding");
  const before = client.consentToken();
  client.setSharing(false, "settings");
  setSettingsQuery("theme");
  dropSettingsSearch(before);
  client.setSharing(true, "onboarding");
  assert.equal(await dropped(), 0);
});

test("a search left in Settings when it closes is counted as closed, only while sharing is on (#3227)", async () => {
  client.setSharing(true, "onboarding");
  setSettingsQuery("theme");
  settingsSearchHost()();
  settingsSearchHost()();
  assert.equal(await sent("settings_searches_closed"), 1, "closing with a search counts once; closing with none counts nothing");

  client.setSharing(false, "settings");
  setSettingsQuery("theme");
  settingsSearchHost()();
  client.setSharing(true, "onboarding");
  assert.equal(await sent("settings_searches_closed"), 0, "a search closed with sharing off is never counted");
});
