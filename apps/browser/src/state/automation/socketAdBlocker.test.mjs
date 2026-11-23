import assert from "node:assert/strict";
import { after, test } from "node:test";
import { embedded, HOSTILE_VALUES, LINE_TERMINATORS } from "../../../../../scripts/security/hostile-inputs.mjs";
const { S, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const stub = await import("../../test-native/index.ts");

const blocker = stub.contentBlockerSites;
const reset = () => {
  blocker.enabled = true;
  blocker.unsupported = false;
  blocker.unready = false;
  blocker.followerFails = false;
  blocker.allowed.clear();
  blocker.written.length = 0;
  blocker.removed.length = 0;
};

after(() => {
  reset();
  S().updateSettings({ cliControl: false });
});

const { call, ok } = socketClient(321);
const SINK_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

test("a site added to the ad blocker's trusted list is listed, and taking it out removes only that entry", async () => {
  await freshWindow();
  reset();
  assert.deepEqual(await ok("sites.adBlocker", {}), { enabled: true, allowedSites: [] });
  assert.deepEqual(await ok("sites.allowAds", { site: "WWW.AppLovin.com" }), { site: "www.applovin.com", trusted: true, covers: "www.applovin.com and its subdomains", enabled: true, allowedSites: ["www.applovin.com"] });
  await ok("sites.allowAds", { site: "dash.ironsrc.com" });
  assert.deepEqual((await ok("sites.adBlocker", {})).allowedSites, ["dash.ironsrc.com", "www.applovin.com"]);
  assert.deepEqual(await ok("sites.blockAds", { site: "www.applovin.com" }), { site: "www.applovin.com", removed: true, trusted: false, enabled: true, allowedSites: ["dash.ironsrc.com"] });
  assert.deepEqual(blocker.removed, ["www.applovin.com"], "the exact-remove sink got only that entry");
});

test("blockAds takes out only an entry the list shows, and names the broader entry that covers a site", async () => {
  await freshWindow();
  reset();
  await ok("sites.allowAds", { site: "applovin.com" });
  await ok("sites.allowAds", { site: "shop.applovin.com" });
  assert.deepEqual(await ok("sites.blockAds", { site: "shop.applovin.com" }), { site: "shop.applovin.com", removed: true, trusted: true, coveredBy: "applovin.com", enabled: true, allowedSites: ["applovin.com"] }, "the parent still lets it through, and the answer says so");
  blocker.written.length = 0;
  blocker.removed.length = 0;
  const covered = await call("sites.blockAds", { site: "www.applovin.com" });
  assert.equal(covered.error?.code, "refused");
  assert.match(covered.error.message, /applovin\.com is, and covers it/);
  assert.equal((await call("sites.blockAds", { site: "other.example" })).error?.code, "refused");
  assert.deepEqual(blocker.written, [], "nothing was added");
  assert.deepEqual(blocker.removed, ["www.applovin.com", "other.example"], "the exact remove was asked, so other profiles get brought in line, and it removed nothing");
  assert.deepEqual([...blocker.allowed], ["applovin.com"]);
});

test("a removal another open profile didn't follow fails with a retry hint, and the retry reaches the native call again", async () => {
  await freshWindow();
  reset();
  blocker.allowed.add("applovin.com");
  blocker.followerFails = true;
  const partial = await call("sites.blockAds", { site: "applovin.com" });
  assert.equal(partial.error?.code, "failed");
  assert.match(partial.error.message, /another open profile hasn't followed yet; run blockAds again/);
  const failedAgain = await call("sites.blockAds", { site: "applovin.com" });
  assert.equal(failedAgain.error?.code, "failed", "a retry the follower fails again still says to retry");
  assert.match(failedAgain.error.message, /run blockAds again/);
  blocker.followerFails = false;
  const retry = await call("sites.blockAds", { site: "applovin.com" });
  assert.equal(retry.error?.code, "refused", "the default profile no longer lists it");
  assert.deepEqual(blocker.removed, ["applovin.com", "applovin.com", "applovin.com"], "every retry still asked the native call, which brings the other profiles in line");
});

test("a public suffix or IP address is refused, since it would trust sites run by others", async () => {
  await freshWindow();
  reset();
  for (const site of ["co.uk", "github.io", "s3.amazonaws.com", "com", "0.1", "127.0.0.1", "192.168.0.1", "localhost"]) {
    const reply = await call("sites.allowAds", { site });
    assert.equal(reply.error?.code, "bad_request", site);
  }
  for (const site of ["user.github.io", "shop.co.uk", "example.com", "bucket.s3.amazonaws.com", "amazonaws.com", "wiki.intranet.corp"]) await ok("sites.allowAds", { site });
  assert.deepEqual(blocker.written, ["user.github.io", "shop.co.uk", "example.com", "bucket.s3.amazonaws.com", "amazonaws.com", "wiki.intranet.corp"], "a name under an unknown top-level domain is one site, as Chromium counts it");
});

test("with the ad blocker off in Settings, the trusted list still changes and the answer says it's off", async () => {
  await freshWindow();
  reset();
  blocker.enabled = false;
  assert.deepEqual(await ok("sites.allowAds", { site: "applovin.com" }), { site: "applovin.com", trusted: true, covers: "applovin.com and its subdomains", enabled: false, allowedSites: ["applovin.com"] });
});

test("an Ardia whose host can't check a site or take one entry out refuses both, and nothing reaches the blocker", async () => {
  await freshWindow();
  reset();
  blocker.allowed.add("applovin.com");
  blocker.unsupported = true;
  for (const method of ["sites.allowAds", "sites.blockAds"]) {
    const reply = await call(method, { site: "applovin.com" });
    assert.equal(reply.error?.code, "refused", method);
    assert.match(reply.error.message, /Site Controls/, method);
  }
  assert.deepEqual(blocker.written, []);
  assert.deepEqual([...blocker.allowed], ["applovin.com"]);
});

test("an ad blocker state Ardia couldn't read fails the call instead of answering from an empty list", async () => {
  await freshWindow();
  reset();
  blocker.allowed.add("applovin.com");
  blocker.unready = true;
  assert.equal((await call("sites.adBlocker", {})).error?.code, "failed");
  assert.equal((await call("sites.blockAds", { site: "applovin.com" })).error?.code, "failed");
  assert.deepEqual(blocker.removed, []);
});

test("only a plain host name reaches the ad blocker's trusted list, for adding and taking out: every hostile input is refused before the sink", async () => {
  await freshWindow();
  reset();
  const shapes = HOSTILE_VALUES.flatMap(({ id, value }) => (typeof value === "string" ? embedded(value, "example.com", ".example.com").map((v) => ({ id, value: v })) : [{ id, value }]));
  const invalid = ["*.example.com", "example.com/path", "https://example.com", "example.com:8080", "example.com#x", "@@||example.com^", "||example.com^", "/^(?:ardia-blocking-off|)/", "", " example.com", "exa mple.com", "exämple.com", "com", "example.com."];
  for (const site of invalid) {
    for (const method of ["sites.allowAds", "sites.blockAds"]) assert.equal((await call(method, { site })).error?.code, "bad_request", `${method} ${JSON.stringify(site)}`);
  }
  for (const extra of invalid) shapes.push({ id: `extra.${extra}`, value: extra });
  for (const { id, value } of shapes) {
    const reply = await call("sites.allowAds", { site: value });
    if (reply.error) continue;
    assert.equal(typeof value, "string", id);
  }
  assert.ok(blocker.written.length > 0, "some shapes are plain hosts once lowercased");
  for (const host of blocker.written) {
    assert.ok(!LINE_TERMINATORS.test(host), `a line break reached the sink: ${JSON.stringify(host)}`);
    assert.match(host, SINK_HOST, `the sink got ${JSON.stringify(host)}`);
  }
  blocker.removed.length = 0;
  for (const { value } of shapes) await call("sites.blockAds", { site: value });
  for (const host of blocker.removed) {
    assert.ok(!LINE_TERMINATORS.test(host), `a line break reached the remove sink: ${JSON.stringify(host)}`);
    assert.match(host, SINK_HOST, `the remove sink got ${JSON.stringify(host)}`);
  }
});
