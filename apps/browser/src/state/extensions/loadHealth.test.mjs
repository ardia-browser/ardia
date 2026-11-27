import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("../telemetry/client.ts");
const local = await import("../telemetry/localStore.ts");
const { LOAD_HEALTH_DOC, loadChange, reportExtensionsLoaded } = await import("./loadHealth.ts");

client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

let seen = 0;
async function loadedEvents() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  const events = queue ? JSON.parse(queue).events.filter((e) => e.event === "extensions_loaded").map((e) => e.properties) : [];
  const fresh = events.slice(seen);
  seen = events.length;
  return fresh;
}

const freshModule = () => import(`./loadHealth.ts?saved=${Math.random()}`);
const savedDoc = () => JSON.parse(stub.docs.get(LOAD_HEALTH_DOC));

const health = { a: { dropped: 0, enabled: 3, disabled: {} } };
stub.extensionAnswers.loadHealth = async (profile) => {
  const answer = health[profile];
  if (!answer) throw new Error(`no health for ${profile}`);
  return answer;
};

test("a reset list that keeps last launch's entries counts none of them as new", () => {
  assert.deepEqual(loadChange({ dropped: 6, enabled: 0 }, 6), { dropped_new: 0, enabled_last_launch: 0 });
  assert.deepEqual(loadChange({ dropped: 0, enabled: 3 }, 6), { dropped_new: 6, enabled_last_launch: 3 });
  assert.deepEqual(loadChange(null, 6), { dropped_new: 0, enabled_last_launch: -1 });
});

test("the first report on a data folder has no last launch, and records this one under the current consent for the next", async () => {
  stub.docs.delete(LOAD_HEALTH_DOC);
  reportExtensionsLoaded("a");
  await settle();
  const [event] = await loadedEvents();
  assert.equal(event.dropped, 0);
  assert.equal(event.enabled, 3);
  assert.equal(event.dropped_new, 0);
  assert.equal(event.enabled_last_launch, -1);
  assert.deepEqual(savedDoc(), { version: 2, consent: client.consentToken(), profiles: { a: { dropped: 0, enabled: 3 } } });
});

test("a launch that lost every extension reports how many were enabled the launch before and how many are newly dropped", async () => {
  stub.docs.set(LOAD_HEALTH_DOC, JSON.stringify({ version: 2, consent: client.consentToken(), profiles: { b: { dropped: 1, enabled: 3 } } }));
  const fresh = await freshModule();
  health.b = { dropped: 7, enabled: 0, disabled: {} };
  fresh.reportExtensionsLoaded("b");
  await settle();
  const [event] = await loadedEvents();
  assert.equal(event.dropped, 7);
  assert.equal(event.dropped_new, 6);
  assert.equal(event.enabled_last_launch, 3);
  assert.deepEqual(savedDoc().profiles.b, { dropped: 7, enabled: 0 });
});

test("an unreadable or newer document, one from before consent was recorded, or one from another consent period reads as no last launch and is replaced", async () => {
  const docs = [
    "{",
    JSON.stringify({ version: 9, consent: client.consentToken(), profiles: { c: { dropped: 0, enabled: 2 } } }),
    JSON.stringify({ version: 2, consent: client.consentToken(), profiles: { c: { dropped: -1, enabled: "2" } } }),
    JSON.stringify({ version: 1, profiles: { c: { dropped: 0, enabled: 2 } } }),
    JSON.stringify({ version: 2, consent: "an-earlier-period", profiles: { c: { dropped: 0, enabled: 2 } } }),
  ];
  for (const saved of docs) {
    stub.docs.set(LOAD_HEALTH_DOC, saved);
    const fresh = await freshModule();
    health.c = { dropped: 2, enabled: 1, disabled: {} };
    fresh.reportExtensionsLoaded("c");
    await settle();
    const [event] = await loadedEvents();
    assert.equal(event.dropped_new, 0, saved);
    assert.equal(event.enabled_last_launch, -1, saved);
    assert.deepEqual(savedDoc(), { version: 2, consent: client.consentToken(), profiles: { c: { dropped: 2, enabled: 1 } } });
  }
});

test("a launch while sharing is off keeps no baseline, so the next shared launch reports nothing from it", async () => {
  stub.docs.delete(LOAD_HEALTH_DOC);
  client.setSharing(false, "settings");
  health.d = { dropped: 0, enabled: 4, disabled: {} };
  (await freshModule()).reportExtensionsLoaded("d");
  await settle();
  assert.equal(stub.docs.has(LOAD_HEALTH_DOC), false);
  client.setSharing(true, "settings");
  health.d = { dropped: 5, enabled: 0, disabled: {} };
  (await freshModule()).reportExtensionsLoaded("d");
  await settle();
  seen = 0;
  const [event] = (await loadedEvents()).filter((e) => e.dropped === 5);
  assert.equal(event.enabled_last_launch, -1);
  assert.equal(event.dropped_new, 0);
});

test("a load that began in one consent period and answers in the next writes no baseline for either", async () => {
  stub.docs.delete(LOAD_HEALTH_DOC);
  let answer;
  health.e = new Promise((resolve) => (answer = resolve));
  stub.extensionAnswers.loadHealth = async (profile) => health[profile];
  (await freshModule()).reportExtensionsLoaded("e");
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  answer({ dropped: 0, enabled: 2, disabled: {} });
  await settle();
  assert.equal(stub.docs.has(LOAD_HEALTH_DOC), false);
});

test("a load that began in one consent period and answers in the next keeps that period's baseline out of the local diagnostics", async () => {
  stub.extensionAnswers.loadHealth = async (profile) => health[profile];
  const earlier = client.consentToken();
  stub.docs.set(LOAD_HEALTH_DOC, JSON.stringify({ version: 2, consent: earlier, profiles: { f: { dropped: 1, enabled: 6 } } }));
  let answer;
  health.f = new Promise((resolve) => (answer = resolve));
  (await freshModule()).reportExtensionsLoaded("f");
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  answer({ dropped: 4, enabled: 0, disabled: {} });
  await settle();
  local.flushLocal();
  const [record] = stub.telemetryLocal.records().filter((r) => r.event === "extensions_loaded" && r.properties?.dropped === 4);
  assert.ok(record, "the load is kept locally");
  assert.equal(record.properties.enabled_last_launch, -1);
  assert.equal(record.properties.dropped_new, 0);
  assert.equal(JSON.stringify(stub.telemetryLocal.records()).includes('"enabled_last_launch":6'), false);
});
