import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
const now = Date.now();
Object.assign(stub.appInfo, { appVersion: "0.3.1", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false, processStart: now - 2000, bootTime: now - 60_000 });
stub.docs.set(
  "telemetry.json",
  JSON.stringify({ version: 1, sharing: true, installId: "install", decidedAt: 1, askDoneAt: 1, crashCursor: 0, lastVersion: "0.3.1", sessionOpen: true, lastLaunchAt: now - 1000, context: null }),
);
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const local = await import("./localStore.ts");
const { trackDrmDiagnostic } = await import("./protectedMedia.ts");
after(() => client.setSharing(false, "settings"));

const queued = async () => {
  await client.saveQueueNow();
  return JSON.parse(stub.docs.get("telemetry-queue.json") ?? "{}").events?.filter((e) => e.event === "protected_media") ?? [];
};
const kept = () => {
  local.flushLocal();
  return stub.telemetryLocal.records().filter((r) => r.event === "protected_media");
};
const track = (diagnostic) => trackDrmDiagnostic(diagnostic, client.consentToken());
const report = (over = {}) => ({ host: "v.qq.com", keySystem: "com.widevine.alpha", stage: "waitingforkey", code: 0, main: true, blockedHosts: [], ...over });
client.startClient();

test("a failed key-system request on Tencent Video is recorded as the site, the DRM family, the stage and a count, never a host name", async () => {
  track(report({ stage: "accessDenied", code: 9, blockedHosts: ["ad.qq.com", "cdn.example.net"] }));
  const [event] = await queued();
  assert.equal(event.properties.site, "v_qq_com");
  assert.equal(event.properties.family, "widevine");
  assert.equal(event.properties.stage, "accessDenied");
  assert.equal(event.properties.code, 9);
  assert.equal(event.properties.main, true);
  assert.equal(event.properties.blocked_hosts_n, 2);
  for (const name of ["host", "key_system", "blocked_hosts"]) assert.equal(name in event.properties, false, name);
  assert.equal(JSON.stringify(event).includes("ad.qq.com"), false);
  assert.equal(JSON.stringify(event).includes("cdn.example.net"), false);
});

test("a media error on a subdomain of a streaming site is recorded under that site, not under the subdomain", async () => {
  track(report({ host: "customer-123.v.qq.com", stage: "error", code: 4, keySystem: "", main: false, blockedHosts: ["customer-123.tracker.example"] }));
  const events = await queued();
  const event = events.find((e) => e.properties.stage === "error" && e.properties.code === 4);
  assert.equal(event.properties.site, "v_qq_com");
  assert.equal(event.properties.family, "none");
  assert.equal(event.properties.main, false);
  assert.equal(event.properties.blocked_hosts_n, 1);
  assert.equal(JSON.stringify(events).includes("customer-123"), false);
});

test("every built-in streaming site is sent as its own dotless name, which the property filter keeps as it is", async () => {
  const { PROTECTED_VIDEO_SITES } = await import("../engines/engines.ts");
  const { cleanProperties } = await import("./sanitize.ts");
  for (const domain of PROTECTED_VIDEO_SITES) {
    const slug = domain.replaceAll(".", "_");
    assert.deepEqual(cleanProperties({ site: slug }), { site: slug }, domain);
  }
});

test("the key system is sent as a family from a fixed list, and any other string as other", async () => {
  const before = (await queued()).length;
  const systems = [
    ["com.widevine.alpha", "widevine"],
    ["com.microsoft.playready.recommendation", "playready"],
    ["com.apple.fps.1_0", "fairplay"],
    ["org.w3.clearkey", "other"],
    ["user-123-private-token", "other"],
    ["", "none"],
  ];
  systems.forEach(([keySystem], i) => track(report({ stage: "accessDenied", code: 200 + i, keySystem })));
  const events = (await queued()).slice(before);
  assert.deepEqual(events.map((e) => e.properties.family), systems.map(([, family]) => family));
  assert.equal(JSON.stringify(events).includes("user-123"), false);
  assert.equal(JSON.stringify(events).includes("clearkey"), false);
});

test("a host that is not a streaming site records nothing", async () => {
  const before = (await queued()).length;
  track(report({ host: "example.com" }));
  track(report({ host: "mail.qq.com" }));
  track(report({ host: "v.qq.com.evil.example" }));
  assert.equal((await queued()).length, before);
});

test("a granted key-system request, a video asking for keys and a stage nobody listed are not problems: they record nothing and use up neither the repeat check nor the 30", async () => {
  const before = (await queued()).length;
  for (let code = 700; code < 760; code++) {
    track(report({ stage: "access", code }));
    track(report({ stage: "encrypted", code }));
    track(report({ stage: "other", code }));
  }
  assert.equal((await queued()).length, before);
  assert.deepEqual(kept().filter((r) => r.properties.code >= 700 && r.properties.code < 760), []);
  track(report({ stage: "accessDenied", code: 700 }));
  track(report({ stage: "waitingforkey", code: 700 }));
  track(report({ stage: "error", code: 700 }));
  const events = (await queued()).slice(before);
  assert.deepEqual(events.map((e) => e.properties.stage), ["accessDenied", "waitingforkey", "error"]);
});

test("nothing but a site name from the fixed list, a family and numbers is stored: no URLs, paths or queries", async () => {
  const before = (await queued()).length;
  track(report({ host: "https://v.qq.com/x/cover/abc?token=secret" }));
  track(report({ host: "v.qq.com/path" }));
  assert.equal((await queued()).length, before);
  track(report({ stage: "waitingforkey", code: 300, keySystem: "com.widevine.alpha?token=secret", blockedHosts: ["https://ad.qq.com/p?q=1", "ad.qq.com/x", "ok.example.com"] }));
  const events = await queued();
  const event = events.find((e) => e.properties.stage === "waitingforkey" && e.properties.code === 300);
  assert.equal(event.properties.family, "widevine");
  assert.equal(event.properties.blocked_hosts_n, 1);
  assert.equal(JSON.stringify(events).includes("secret"), false);
  assert.equal(JSON.stringify(events).includes("/x/cover"), false);
  assert.equal(JSON.stringify(events).includes("ok.example.com"), false);
});

test("a record is kept once, however often it repeats", async () => {
  const before = (await queued()).length;
  track(report({ stage: "accessDenied", code: 21 }));
  track(report({ stage: "accessDenied", code: 21 }));
  assert.equal((await queued()).length, before + 1);
});

test("the same record with blocked requests is a new one, however the hosts are named or ordered", async () => {
  const before = (await queued()).length;
  track(report({ stage: "accessDenied", code: 22 }));
  track(report({ stage: "accessDenied", code: 22, blockedHosts: ["ad.qq.com", "cdn.example.net"] }));
  track(report({ stage: "accessDenied", code: 22, blockedHosts: ["cdn.example.net", "ad.qq.com"] }));
  track(report({ stage: "accessDenied", code: 22, blockedHosts: ["one.example.org", "two.example.org"] }));
  const events = (await queued()).slice(before);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.properties.blocked_hosts_n), [0, 2]);
});

test("two hosts of one site that send the same record are one record", async () => {
  const before = (await queued()).length;
  track(report({ host: "a.v.qq.com", stage: "accessDenied", code: 23 }));
  track(report({ host: "b.v.qq.com", stage: "accessDenied", code: 23 }));
  assert.equal((await queued()).length, before + 1);
});

test("a session keeps at most 30", async () => {
  for (let code = 400; code < 460; code++) track(report({ stage: "error", code }));
  assert.equal((await queued()).length, 30);
});

test("with sharing off nothing is queued or kept on this Mac, and what was reported then uses up neither the repeat check nor the 30", async () => {
  client.setSharing(false, "settings");
  stub.telemetryLocal.reset();
  track(report({ host: "www.netflix.com", stage: "accessDenied", code: 1, blockedHosts: ["customer-123.tracker.example"] }));
  for (let code = 500; code < 560; code++) track(report({ host: "www.netflix.com", stage: "error", code }));
  assert.equal((await queued()).some((e) => e.properties.site === "netflix_com"), false);
  assert.deepEqual(kept(), []);
  client.setSharing(true, "settings");
  track(report({ host: "www.netflix.com", stage: "accessDenied", code: 1, blockedHosts: ["customer-123.tracker.example"] }));
  const events = (await queued()).filter((e) => e.properties.site === "netflix_com");
  assert.equal(events.length, 1);
  assert.equal(events[0].properties.blocked_hosts_n, 1);
});

test("a report that carries a consent from before sharing was turned off and on again uses up nothing", async () => {
  client.setSharing(true, "settings");
  const stale = client.consentToken();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  for (let code = 600; code < 660; code++) trackDrmDiagnostic(report({ stage: "error", code }), stale);
  assert.equal((await queued()).some((e) => e.properties.code >= 600), false);
  track(report({ stage: "error", code: 600 }));
  assert.equal((await queued()).filter((e) => e.properties.code === 600).length, 1);
});
