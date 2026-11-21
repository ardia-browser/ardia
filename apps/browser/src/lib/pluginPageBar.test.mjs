import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { readManifest, contributionsOf } = await import("./pluginManifest.ts");
const { pluginSchema } = await import("./pluginSchema.ts");
const { HOST_ACTION_NAMES, isLocalOrigin, pageBarConsent, switchOrigin } = await import("./pluginPageBar.ts");

const FIXTURE = readFileSync(new URL("../../../../tests/fixtures/plugins/developer-mode/plugin.json", import.meta.url), "utf8");
const base = () => JSON.parse(FIXTURE);
const problems = (doc) => readManifest(JSON.stringify(doc)).problems;

test("the developer mode manifest declares a site switch and a page bar of host actions", () => {
  const { manifest, problems: found } = readManifest(FIXTURE);
  assert.deepEqual(found, []);
  assert.deepEqual(manifest.siteSwitches, [{ key: "on", title: "Developer Mode", icon: "hammer" }]);
  assert.deepEqual(manifest.pageBar.when, { siteSwitch: "on", localAddresses: "localAddresses" });
  assert.deepEqual(manifest.pageBar.buttons, ["siteControls", "address", "copyLink", "|", "console", "network", "inspect", "|", "extensions", "split"]);
  assert.deepEqual(contributionsOf(manifest), ["settings", "siteSwitches", "pageBar"]);
});

test("a page bar's references must point at what the plugin declares", () => {
  const bar = (when, extra = {}) => ({ ...base(), pageBar: { ...base().pageBar, when, ...extra } });
  assert.ok(problems(bar({ siteSwitch: "off" })).includes("plugin.json: pageBar.when.siteSwitch must name one of this plugin's siteSwitches"));
  assert.ok(problems(bar({ siteSwitch: "on", localAddresses: "missing" })).includes("plugin.json: pageBar.when.localAddresses must name one of this plugin's toggle rows"));
  const textRow = { ...base(), settings: { rows: [{ key: "localAddresses", title: "x", type: "text", default: "" }] } };
  assert.ok(problems(textRow).includes("plugin.json: pageBar.when.localAddresses must name one of this plugin's toggle rows"));
  assert.ok(problems(bar({ siteSwitch: "on" }, { buttons: ["devtools.console"] })).some((p) => p.includes("pageBar.buttons[0] must be |")));
  assert.ok(problems(bar({ siteSwitch: "on" }, { buttons: ["copyLink", "copyLink"] })).includes("plugin.json: pageBar.buttons has copyLink twice"));
  assert.ok(problems(bar({ siteSwitch: "on" }, { buttons: Array(17).fill("|") })).includes("plugin.json: pageBar.buttons must be a list of 1 to 16"));
  assert.ok(problems(bar({ siteSwitch: "on" }, { buttons: ["|"] })).includes("plugin.json: pageBar.buttons needs at least one action besides |"));
  assert.ok(problems(bar({ siteSwitch: "on" }, { look: "plain" })).includes("plugin.json: pageBar.look must be stripes"));
  assert.ok(problems({ ...base(), siteSwitches: undefined }).includes("plugin.json: pageBar.when.siteSwitch must name one of this plugin's siteSwitches"));
  const five = Array.from({ length: 5 }, (_, i) => ({ key: `s${i}`, title: "S" }));
  assert.ok(problems({ ...base(), siteSwitches: five }).includes("plugin.json: siteSwitches must be a list of at most 4"));
  assert.ok(problems({ ...base(), siteSwitches: [{ key: "on", title: "A" }, { key: "on", title: "B" }] }).includes("plugin.json: siteSwitches has two switches named on"));
  assert.ok(problems({ ...base(), siteSwitches: [{ key: "on", title: "A", extra: 1 }] }).includes("plugin.json: siteSwitches[0].extra isn't a key of siteSwitches[0]"));
});

test("the schema and the consent copy come from the same action table", () => {
  const schema = pluginSchema([], { untabbedEvents: [], approvedSettings: [] }).properties;
  assert.deepEqual(schema.pageBar.properties.buttons.items.enum, [...HOST_ACTION_NAMES, "|"]);
  assert.deepEqual(schema.pageBar.properties.when.required, ["siteSwitch"]);
  assert.equal(schema.siteSwitches.maxItems, 4);
  const { manifest } = readManifest(FIXTURE);
  const lines = pageBarConsent(manifest.siteSwitches, manifest.pageBar).map((l) => l.text);
  assert.deepEqual(lines, [
    "Adds a Developer Mode switch to Site Controls, for each site",
    "Shows a striped bar on sites where Developer Mode is on, with buttons to open Site Controls, edit the address, copy the page address, open the Console, open the Network panel, inspect an element, run your extensions and add a split",
    "With one of its settings on, a local address you type in (like localhost) turns Developer Mode on for that site",
  ]);
});

test("site switches are kept per canonical origin", () => {
  assert.equal(switchOrigin("http://LOCALHOST.:80/x?y#z"), "http://localhost");
  assert.equal(switchOrigin("https://example.com:443/"), "https://example.com");
  assert.equal(switchOrigin("http://localhost:5173/a"), "http://localhost:5173");
  assert.equal(switchOrigin("http://[::1]:8318/"), "http://[::1]:8318");
  assert.equal(switchOrigin("http://user:pw@example.com/"), null);
  assert.equal(switchOrigin("ardia://settings"), null);
  assert.equal(switchOrigin("file:///tmp/x.html"), null);
  for (const local of ["http://localhost:1", "http://app.localhost", "http://127.0.0.1:18318", "http://127.1.2.3", "http://0.0.0.0:3000", "http://[::1]:8080"]) assert.ok(isLocalOrigin(switchOrigin(local)), local);
  for (const remote of ["http://192.168.1.4:18318", "https://localhost.example.com", "http://10.0.0.1"]) assert.ok(!isLocalOrigin(switchOrigin(remote)), remote);
});
