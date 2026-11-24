import assert from "node:assert/strict";
import { test } from "node:test";
import { HOSTILE_STRINGS } from "../../../../../scripts/security/hostile-inputs.mjs";
const stub = await import("../../test-native/index.ts");
const { appInfo, officialLegacyHash } = await import("../../test-native/shell.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins, activeManifest } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { manifestHash } = await import("./appChecks.ts");
const { officialPlugins, officialUpdateVerdict, resetOfficialUpdatesForTests } = await import("./official.ts");
const { autoUpdateNote } = await import("./officialView.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
const { readPluginRecords, parsePluginRecords, pluginRecordsJson } = await import("./savedState.ts");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const AFTER_UPDATE = [["skills", "install", "--auto"], ["skills", "refresh"], ["computer", "refresh"]];
const PY_040 = JSON.stringify({
  $schema: "ardia_cli/schemas/plugin.schema.json", manifest: 1, name: "cli", title: "Command Line", description: "Drive Ardia from your terminal or an agent.", version: "0.4.0",
  icon: "terminal.fill", alwaysOn: true, official: true, permissions: ["control"], programs: [{ name: "ardia", path: "bin/ardia", afterUpdate: AFTER_UPDATE }],
});
const bun = (version, extra = {}, contributes = {}) =>
  JSON.stringify({
    manifest: 2, name: "cli", title: "Command Line", description: "Drive Ardia from your terminal or an agent.", version, requires: "0.2.48", icon: "terminal.fill",
    keywords: ["command line", "terminal"], alwaysOn: true, official: true, main: "dist/main.js", permissions: { control: true },
    contributes: {
      commands: [{ name: "show-status", title: "Command Line: Show Status", icon: "terminal", view: "status", keywords: ["ardia"] }],
      programs: [{ name: "ardia", path: "bin/ardia", claim: true, example: "ardia tabs", afterUpdate: AFTER_UPDATE }],
      ...contributes,
    },
    telemetry: { title: "The ardia command", items: ["Each command's name"] },
    ...extra,
  });
const BUN_060 = bun("0.6.0");
const PINNED = { name: "cli", version: "0.6.0", folderId: `official-${"6".repeat(64)}` };
const LEGACY_040 = { name: "cli", status: "ok", official: true, legacy: true, folderId: "bundled", text: PY_040 };
const PY_RECEIPT = manifestHash(PY_040, "bundled");
const candidateOf = (text, folderId = PINNED.folderId) => ({ folderId, text, legacyHash: officialLegacyHash(text), version: "0.6.0" });
const RECORDS = (approved, extra = {}) => JSON.stringify({ version: 1, plugins: { cli: { enabled: true, approved, values: {}, applied: {}, installed: true, ...extra } } });

appInfo.appVersion = "0.2.49";
setConsentPeriod(true, "test-epoch");
lifecycle.PROMOTION_RETRY.delayMs = 20;
host.pinned = [PINNED];
host.officialArtifacts = {};
host.officialFetchResults = { cli: { ok: false, code: "offline", reason: "offline" } };
host.folders = [];
stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: {} }));
S().hydrate({ settings: { cliControl: true } });
startPlugins();
await settle();

async function launch(records, folders) {
  usePlugins.setState({ records: {}, candidates: {}, fetches: {}, consent: null });
  stub.docs.set("plugins.json", records);
  usePlugins.setState({ records: readPluginRecords() });
  host.folders = folders;
  host.promotes.length = 0;
  host.links.length = 0;
  resetOfficialUpdatesForTests();
  takePluginCounts();
  await lifecycle.rescanPlugins(consentToken());
  await settle();
}

test("an update with the same surface switches by itself, with a note that doesn't claim new code", async () => {
  const bun050 = bun("0.5.0");
  const store050 = `official-${"5".repeat(64)}`;
  await launch(RECORDS(manifestHash(bun050, store050)), [{ name: "cli", status: "ok", official: true, legacy: true, folderId: store050, text: bun050, candidate: candidateOf(BUN_060) }]);
  assert.deepEqual(host.promotes.map((p) => p.approved), [manifestHash(BUN_060, PINNED.folderId)]);
  assert.deepEqual(P().records.cli.updated, { from: "0.5.0", to: "0.6.0", added: [] });
});

test("a Python CLI 0.4.0 approved in 0.2.47 switches to the Bun CLI 0.6.0 by itself: same permissions, so no sheet", async () => {
  await launch(RECORDS(PY_RECEIPT), [{ ...LEGACY_040, candidate: candidateOf(BUN_060) }]);
  const approved = manifestHash(BUN_060, PINNED.folderId);
  assert.equal(P().consent, null, "nothing is asked");
  assert.deepEqual(host.promotes, [{ name: "cli", folderId: PINNED.folderId, approved }]);
  assert.equal(P().listings.cli.folderId, PINNED.folderId);
  assert.equal(P().listings.cli.legacy, undefined);
  assert.ok(activeManifest(P(), "cli"));
  assert.equal(host.links.at(-1)?.folderId, PINNED.folderId, "the new ardia goes on PATH");
  const record = P().records.cli;
  assert.equal(record.approved, approved);
  assert.equal(record.previous, PY_RECEIPT, "the 0.2.47 receipt stays for a rollback");
  assert.equal(record.installed, true);
  assert.deepEqual([record.updated.from, record.updated.to, record.updated.runtime], ["0.4.0", "0.6.0", true], "the note says it added code");
  assert.ok(record.updated.added.some((line) => line.includes("Command Line: Show Status")), "the note says what's new");
  assert.equal(S().settings.cliControl, true, "control is left as it was");
  assert.deepEqual(parsePluginRecords(stub.docs.get("plugins.json")).cli.updated, record.updated, "the note is saved");
  assert.equal(officialPlugins(P(), true, () => false)[0].update, null, "no Update… left to click");
  const counts = takePluginCounts();
  assert.equal(counts.official_updates_auto, 1);
  assert.equal(counts.official_updates_waiting, 0);
});

test("a failed switch leaves the old copy on, shows no note and counts nothing until the retry succeeds", async () => {
  host.promoteResult = { ok: false, reason: "busy disk" };
  await launch(RECORDS(PY_RECEIPT), [{ ...LEGACY_040, candidate: candidateOf(BUN_060) }]);
  const approved = manifestHash(BUN_060, PINNED.folderId);
  assert.equal(P().records.cli.approved, approved, "the approval is on record");
  assert.equal(P().records.cli.previous, PY_RECEIPT);
  assert.equal(P().listings.cli.hash, PY_RECEIPT, "the old copy is still the one listed");
  assert.ok(activeManifest(P(), "cli"), "and still on through previous");
  assert.notEqual(P().records.cli.approved, P().listings.cli.hash, "so the page's note, bound to the running copy, stays hidden");
  assert.equal(takePluginCounts().official_updates_auto, 0);
  host.promoteResult = null;
  host.promotes.length = 0;
  resetOfficialUpdatesForTests();
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.equal(P().listings.cli.hash, approved, "the next scan finishes the switch, as after a restart");
  assert.equal(takePluginCounts().official_updates_auto, 1, "counted once it took");
});

test("a failed switch finished by Try Again is counted as an automatic update too", async () => {
  const { installOfficialPlugin } = await import("./official.ts");
  host.promoteResult = { ok: false, reason: "busy disk" };
  await launch(RECORDS(PY_RECEIPT), [{ ...LEGACY_040, candidate: candidateOf(BUN_060) }]);
  assert.equal(takePluginCounts().official_updates_auto, 0);
  host.promoteResult = null;
  const result = await installOfficialPlugin("cli", { showSheet: false });
  assert.deepEqual(result, { ok: true });
  assert.equal(P().consent, null, "no sheet: the approval is on record");
  assert.equal(P().listings.cli.hash, manifestHash(BUN_060, PINNED.folderId));
  assert.equal(takePluginCounts().official_updates_auto, 1);
});

test("two overlapping Try Again presses after a failed switch promote once and count once", async () => {
  const { installOfficialPlugin } = await import("./official.ts");
  host.promoteResult = { ok: false, reason: "busy disk" };
  await launch(RECORDS(PY_RECEIPT), [{ ...LEGACY_040, candidate: candidateOf(BUN_060) }]);
  host.promoteResult = null;
  host.promotes.length = 0;
  takePluginCounts();
  const [first, second] = await Promise.all([installOfficialPlugin("cli", { showSheet: false }), installOfficialPlugin("cli", { showSheet: false })]);
  assert.deepEqual([first, second], [{ ok: true }, { ok: true }]);
  assert.equal(host.promotes.length, 1, "the second press waits for the switch already running");
  assert.equal(takePluginCounts().official_updates_auto, 1);
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.equal(takePluginCounts().official_updates_auto, 0, "a later scan doesn't count it again");
});

test("an official update that asks for more still waits for Update…: the old copy stays on and the reason is counted", async () => {
  const wider = bun("0.6.0", { permissions: { control: true, network: ["api.example.com"] } });
  await launch(RECORDS(PY_RECEIPT), [{ ...LEGACY_040, candidate: candidateOf(wider) }]);
  assert.deepEqual(host.promotes, []);
  assert.equal(P().records.cli.approved, PY_RECEIPT);
  assert.equal(P().listings.cli.legacy, true);
  assert.ok(activeManifest(P(), "cli"), "the approved copy keeps working");
  assert.equal(officialPlugins(P(), true, () => false)[0].update, "0.6.0");
  const counts = takePluginCounts();
  assert.equal(counts.official_updates_auto, 0);
  assert.equal(counts.official_updates_waiting, 1);
  assert.equal(counts.official_update_prompts_network, 1);
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.equal(takePluginCounts().official_update_prompts_network, 0, "counted once per download");
});

test("an old-style install with no approval on record isn't adopted: no baseline, so Install stays the user's choice", async () => {
  await launch(JSON.stringify({ version: 1, plugins: {} }), [{ ...LEGACY_040, candidate: candidateOf(BUN_060) }]);
  assert.deepEqual(host.promotes, []);
  assert.equal(P().listings.cli, undefined);
  assert.equal(P().records.cli, undefined);
  assert.equal(officialPlugins(P(), true, () => false)[0].state, "available");
});

test("a user folder named cli is never treated as official, whatever its plugin.json says", async () => {
  const mine = bun("0.5.0");
  await launch(RECORDS(manifestHash(mine, "7:7")), [
    { name: "cli", status: "ok", text: mine, folderId: "7:7" },
    { name: "cli", status: "missing", official: true, candidateOnly: true, candidate: candidateOf(BUN_060) },
  ]);
  assert.equal(P().listings.cli.official, undefined);
  assert.deepEqual(host.promotes, []);
  assert.equal(P().records.cli.approved, manifestHash(mine, "7:7"));
  assert.equal(officialUpdateVerdict(P(), "cli", P().candidates.cli).ok, false);
});

test("the official check: a download that isn't the pinned copy, a receipt for something else, a spoofed name or an unofficial manifest all keep the prompt", async () => {
  await launch(RECORDS(PY_RECEIPT), [{ ...LEGACY_040, candidate: candidateOf(BUN_060, `official-${"e".repeat(64)}`) }]);
  assert.deepEqual(host.promotes, [], "a candidate whose digest isn't the pin's");
  assert.equal(takePluginCounts().official_update_prompts_baseline, 1);

  await launch(RECORDS(manifestHash(PY_040, "official-tampered")), [{ ...LEGACY_040, candidate: candidateOf(BUN_060) }]);
  assert.equal(P().listings.cli, undefined, "a receipt that doesn't match the copy lists nothing");
  assert.deepEqual(host.promotes, []);

  const { readManifest } = await import("../../lib/pluginManifest.ts");
  const base = { name: "cli", manifest: readManifest(BUN_060).manifest, problems: [], hash: manifestHash(BUN_060, PINNED.folderId), folderId: PINNED.folderId, official: true, legacyHash: officialLegacyHash(BUN_060) };
  const before = {
    pinned: [PINNED],
    listings: { cli: { name: "cli", manifest: readManifest(PY_040).manifest, problems: [], hash: PY_RECEIPT, folderId: "bundled", official: true, legacy: true } },
    records: { cli: { enabled: true, approved: PY_RECEIPT, values: {}, applied: {} } },
  };
  const verdict = (candidate, state) => officialUpdateVerdict(state, "cli", candidate).ok;
  assert.equal(verdict(base, before), true, "the real pair passes");
  assert.equal(verdict({ ...base, name: "clj" }, before), false, "a candidate under another name");
  assert.equal(verdict({ ...base, official: false }, before), false, "a candidate native didn't verify");
  assert.equal(verdict({ ...base, manifest: { ...base.manifest, official: false } }, before), false, "a manifest not marked official");
  assert.equal(verdict({ ...base, problems: ["bad"] }, before), false, "a candidate with problems");
  assert.equal(verdict(base, { ...before, listings: { cli: { ...before.listings.cli, official: false } } }), false, "an installed copy native didn't verify");
  assert.equal(verdict(base, { ...before, records: { cli: { ...before.records.cli, approved: "f".repeat(64) } } }), false, "a receipt that isn't for the installed copy");
  assert.equal(verdict(base, { ...before, records: { cli: { ...before.records.cli, enabled: false } } }), false, "a plugin you turned off");
  assert.equal(verdict(base, { ...before, pinned: [] }), false, "nothing pinned under that name");
});

test("an open consent sheet for the plugin isn't raced: the update waits while you decide", async () => {
  await launch(RECORDS(PY_RECEIPT), [LEGACY_040]);
  usePlugins.setState({ consent: { id: 99, name: "cli", hash: "x" } });
  host.folders = [{ ...LEGACY_040, candidate: candidateOf(BUN_060) }];
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.deepEqual(host.promotes, []);
  usePlugins.setState({ consent: null });
});

test("approving an update by hand drops the auto-update note", async () => {
  const wider = bun("0.6.0", { permissions: { control: true, network: ["api.example.com"] } });
  await launch(RECORDS(PY_RECEIPT, { updated: { from: "0.3.0", to: "0.4.0", added: [] } }), [{ ...LEGACY_040, candidate: candidateOf(wider) }]);
  assert.ok(P().records.cli.updated);
  assert.ok(lifecycle.requestPluginConsent("cli", true));
  assert.ok(lifecycle.enablePlugin("cli", P().consent.hash));
  assert.equal(P().records.cli.updated, undefined);
});

test("the saved note is read back bounded and checked", () => {
  const read = (updated) => parsePluginRecords(RECORDS(PY_RECEIPT, { updated })).cli.updated;
  assert.deepEqual(read({ from: "0.4.0", to: "0.6.0", added: ["a", 3, "", "b"] }), { from: "0.4.0", to: "0.6.0", added: ["a", "b"] });
  assert.deepEqual(read({ from: "<script>", to: 6, added: [] }), { from: null, to: null, added: [] });
  assert.equal(read({ from: "0.4.0" }), undefined);
  assert.equal(read("yes"), undefined);
  assert.equal(read({ added: Array.from({ length: 40 }, (_, i) => `line ${i}`) }).added.length, 24);
  const kept = parsePluginRecords(pluginRecordsJson(parsePluginRecords(RECORDS(PY_RECEIPT, { updated: { from: "0.4.0", to: "0.6.0", added: ["x"] } })))).cli.updated;
  assert.deepEqual(kept, { from: "0.4.0", to: "0.6.0", added: ["x"] });
});

test("the plugin page says it updated by itself, says plainly when it added code, and lists what's new", () => {
  assert.deepEqual(autoUpdateNote({ from: "0.5.0", to: "0.6.0", added: [] }), { title: "Updated by itself to 0.6.0", description: "Its permissions didn't change." });
  assert.deepEqual(autoUpdateNote({ from: "0.4.0", to: "0.6.0", added: ["Adds to the command bar: Command Line: Show Status"], runtime: true }), {
    title: "Updated by itself to 0.6.0",
    description:
      "It added its own code, which runs in Ardia's sandbox, offline, and first starts when you use one of its commands in the command bar. Its permissions didn't change. New since 0.4.0: Adds to the command bar: Command Line: Show Status.",
  });
  assert.equal(parsePluginRecords(RECORDS(PY_RECEIPT, { updated: { from: "0.4.0", to: "0.6.0", added: [], runtime: true } })).cli.updated.runtime, true);
  assert.equal(parsePluginRecords(RECORDS(PY_RECEIPT, { updated: { from: "0.4.0", to: "0.6.0", added: [], runtime: "yes" } })).cli.updated.runtime, undefined);
});

test("hostile values in a downloaded official plugin.json never reach plugins.json or a switch: approval and promotion stay untouched", async () => {
  const doc = JSON.parse(BUN_060);
  const variants = (value) => [
    { ...doc, permissions: { control: true, network: [value] } },
    { ...doc, main: value },
    { ...doc, activationEvents: [value] },
    { ...doc, contributes: { ...doc.contributes, programs: [{ ...doc.contributes.programs[0], afterUpdate: [...AFTER_UPDATE, [value]] }] } },
    { ...doc, contributes: { ...doc.contributes, programs: [{ ...doc.contributes.programs[0], path: value }] } },
    { ...doc, contributes: { ...doc.contributes, commands: [...doc.contributes.commands, { name: "x", title: value, icon: "bolt", open: "tab" }] } },
  ];
  let checked = 0;
  for (const { value } of HOSTILE_STRINGS) {
    for (const variant of variants(value)) {
      const text = JSON.stringify(variant);
      await launch(RECORDS(PY_RECEIPT), [{ ...LEGACY_040, candidate: candidateOf(text) }]);
      assert.deepEqual(host.promotes, [], `promotion for ${text.slice(0, 160)}`);
      assert.equal(parsePluginRecords(stub.docs.get("plugins.json")).cli.approved, PY_RECEIPT, "plugins.json keeps the old approval");
      assert.equal(P().records.cli.updated, undefined);
      checked++;
    }
  }
  assert.ok(checked >= 6 * 20);
  await launch(RECORDS(PY_RECEIPT), [{ ...LEGACY_040, candidate: candidateOf(BUN_060) }]);
  assert.equal(host.promotes.length, 1, "the same path still switches the real 0.6.0");
});
