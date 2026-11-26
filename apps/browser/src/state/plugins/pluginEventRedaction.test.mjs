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

test("a state event's address is http or https only, never a file, internal, plugin or credentialed page", async () => {
  const { pluginStateUrl } = await import("./pluginEventRedaction.ts");
  const short = { full: false, urls: true };
  const full = { full: true, urls: true };
  for (const url of [
    "file:///Users/me/taxes.pdf",
    "ardia://history",
    "ardia://settings",
    "ardia://vault",
    "chrome://settings/passwords",
    "chrome://password-manager/passwords",
    "about:blank",
    "about:settings",
    "data:text/html,<b>x</b>",
    "javascript:alert(1)",
    "blob:https://a.example/123",
    "view-source:https://a.example/",
    "ardia-plugin://other/page",
    "https://user:hunter2@login.example/",
    "https://:pw@login.example/",
    "https://login.example\u0000/",
    "",
  ]) {
    assert.equal(pluginStateUrl(url, short), null, url);
    assert.equal(pluginStateUrl(url, full), null, url);
  }
  assert.equal(pluginStateUrl("https://a.example/x?y=1#z", { full: true, urls: false }), null);
  assert.equal(pluginStateUrl("https://bank.example/s?account=42#row", short), "https://bank.example/s");
  assert.equal(pluginStateUrl("https://bank.example/s?account=42#row", full), "https://bank.example/s?account=42");
  for (const secret of ["access_token=abc", "api_key=1", "password=x", "sessionid=9", "code=123", "X-Amz-Signature=f", "auth=t"]) {
    assert.equal(pluginStateUrl(`https://a.example/cb?ok=1&${secret}#f`, full), "https://a.example/cb", secret);
  }
});

test("a query name is decoded before it is judged, and a query that can't be decoded is cut whole", async () => {
  const { pluginStateUrl, hasSecretParam } = await import("./pluginEventRedaction.ts");
  const full = { full: true, urls: true };
  for (const query of ["%74oken=secret", "%61pi_key=x", "%2574oken=y", "a=1&%73ession=z", "pass%77ord=1", "q=%E0%A4%A", "%E0%A4%A=1", "x+token=1"]) {
    assert.equal(hasSecretParam(query), true, query);
    assert.equal(pluginStateUrl(`https://a.example/cb?${query}#f`, full), "https://a.example/cb", query);
  }
  for (const query of ["page=2", "q=a+b%20c", "lang=%C3%A9"]) {
    assert.equal(hasSecretParam(query), false, query);
    assert.equal(pluginStateUrl(`https://a.example/cb?${query}#f`, full), `https://a.example/cb?${query}`, query);
  }
});
