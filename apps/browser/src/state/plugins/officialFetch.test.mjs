import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { officialLegacyHash } = await import("../../test-native/shell.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins, activeManifest } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { manifestHash } = await import("./appChecks.ts");
const { officialPlugins, installOfficialPlugin, fetchOfficialCandidate, pendingOfficialRetries, resetOfficialUpdatesForTests, FETCH_REASONS } = await import("./official.ts");
const { programsKeptAtLaunch } = await import("./programs.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
const { readPluginRecords } = await import("./savedState.ts");
const reload = () => usePlugins.setState({ records: readPluginRecords() });

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const cli = (version, extra = {}) =>
  JSON.stringify({ manifest: 1, name: "cli", title: "Command Line", version, alwaysOn: true, official: true, icon: "terminal.fill", permissions: ["control"], programs: [{ name: "ardia", path: "bin/ardia" }], ...extra });
const OLD = cli("0.4.0");
const NEW = cli("0.5.0", { description: "Drive Ardia from your terminal or an agent." });
const PINNED = { name: "cli", version: "0.5.0", folderId: `official-${"5".repeat(64)}` };
const LEGACY = { name: "cli", status: "ok", official: true, legacy: true, folderId: "bundled", text: OLD };
const OLD_RECEIPT = manifestHash(OLD, "bundled");
const RECORDS = (approved) => JSON.stringify({ version: 1, plugins: { cli: { enabled: true, approved, values: {}, applied: {}, installed: true } } });

setConsentPeriod(true, "test-epoch");
lifecycle.PROMOTION_RETRY.delayMs = 20;
host.pinned = [PINNED];
host.officialArtifacts = {};
host.officialFetchResults = { cli: { ok: false, code: "offline", reason: "The Internet connection appears to be offline." } };
host.folders = [LEGACY];
stub.docs.set("plugins.json", RECORDS(OLD_RECEIPT));
S().hydrate({ settings: { cliControl: true } });
const savedAtLaunch = stub.docs.get("plugins.json");
startPlugins();
await settle();

test("a 0.2.47 profile offline: the old ardia stays installed and linked from its own copy, the sweep keeps it, nothing is asked", () => {
  assert.equal(P().listings.cli.legacy, true);
  assert.ok(activeManifest(P(), "cli"), "the old receipt still approves the copy 0.2.47 made");
  assert.deepEqual(host.sweeps[0], ["cli"], "the launch sweep keeps the old link and its Programs/cli/current");
  assert.equal(host.links.length, 1);
  assert.deepEqual([host.links[0].folderId, host.links[0].approved], ["bundled", OLD_RECEIPT], "linked in place, nothing restaged");
  assert.deepEqual(host.links[0].programs, [{ name: "ardia", path: "bin/ardia" }], "the old copy runs no after-update actions");
  assert.equal(P().consent, null);
  assert.equal(S().settings.cliControl, true, "control stays as saved");
  assert.equal(stub.docs.get("plugins.json"), savedAtLaunch, "plugins.json is untouched, so 0.2.47 still works after a rollback");
  assert.deepEqual(host.officialFetchLog, ["cli"], "the replacement is fetched in the background");
  assert.equal(P().fetches.cli, undefined, "a background failure shows no error on the row");
  const counts = takePluginCounts();
  assert.equal(counts.official_fetches, 1);
  assert.equal(counts.official_fetch_offline, 1);
});

test("the launch sweep keeps PATH links only for plugins with a verified, approved listing; native keeps official copies on disk", () => {
  assert.deepEqual(programsKeptAtLaunch({ order: [], listings: {}, records: { cli: { enabled: true, approved: OLD_RECEIPT, values: {}, applied: {} } } }), [], "a record alone keeps no link when its copy failed verification");
  assert.deepEqual(programsKeptAtLaunch(P()), ["cli"]);
});

test("a failed background fetch waits before trying again; the old copy keeps working", async () => {
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.deepEqual(host.officialFetchLog, ["cli"], "no retry inside the back-off");
  assert.deepEqual(pendingOfficialRetries(), ["cli"], "a retry is scheduled for when the back-off ends, so it doesn't wait for a folder change");
  assert.ok(activeManifest(P(), "cli"));
});

test("online, a replacement whose plugin.json changed waits for your approval: the old one stays on, the new one isn't switched to", async () => {
  resetOfficialUpdatesForTests();
  delete host.officialFetchResults.cli;
  host.officialArtifacts.cli = NEW;
  host.links.length = 0;
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.deepEqual(host.officialFetchLog, ["cli", "cli"]);
  assert.equal(P().candidates.cli.hash, manifestHash(NEW, PINNED.folderId));
  assert.deepEqual(host.promotes, [], "a changed name-and-hash pair needs its own approval");
  assert.equal(P().listings.cli.legacy, true);
  assert.ok(activeManifest(P(), "cli"));
  assert.deepEqual(host.unlinks, [], "nothing came off PATH");
  assert.equal(officialPlugins(P(), true, () => false)[0].update, "0.5.0", "Settings offers the update to review");
  assert.equal(takePluginCounts().official_updates_waiting, 1);
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.equal(takePluginCounts().official_updates_waiting, 0, "counted once");
});

test("reviewing the update installs the verified download: the old copy stays on until it's switched to, then the new one links", async () => {
  const asked = installOfficialPlugin("cli", { showSheet: false });
  assert.equal(P().consent.hash, P().candidates.cli.hash);
  assert.ok(lifecycle.enablePlugin("cli", P().consent.hash));
  assert.equal(P().records.cli.previous, OLD_RECEIPT, "the old receipt is kept while the switch happens");
  assert.ok(activeManifest(P(), "cli"), "still on during the switch");
  assert.deepEqual(await asked, { ok: true });
  assert.deepEqual(host.promotes, [{ name: "cli", folderId: PINNED.folderId, approved: manifestHash(NEW, PINNED.folderId) }]);
  assert.equal(P().listings.cli.folderId, PINNED.folderId);
  assert.equal(P().listings.cli.legacy, undefined);
  assert.equal(host.links.at(-1).folderId, PINNED.folderId);
  assert.deepEqual(host.unlinks, []);
});

test("a legacy copy counts only with its exact old receipt", async () => {
  const listing = (approved) => lifecycle.keptLegacy({ name: "cli", legacy: true, hash: OLD_RECEIPT, folderId: "bundled", manifest: null, problems: [] }, { cli: { enabled: true, approved, values: {}, applied: {} } });
  assert.equal(listing(OLD_RECEIPT), true);
  assert.equal(listing(manifestHash(OLD, "official-x")), false);
  assert.equal(lifecycle.keptLegacy({ name: "cli", legacy: true, hash: OLD_RECEIPT, folderId: "bundled", manifest: null, problems: [] }, {}), false, "no receipt, no listing: a fresh profile is offered Install");
  assert.equal(lifecycle.keptLegacy({ name: "cli", legacy: true, hash: OLD_RECEIPT, folderId: "bundled", manifest: null, problems: [] }, { cli: { enabled: false, approved: OLD_RECEIPT, values: {}, applied: {} } }), true, "turned off, it stays listed so it can be turned back on");
});

test("a download whose plugin.json is the one already approved switches over by itself, recording its exact approval and keeping the old receipt", async () => {
  usePlugins.setState({ records: {}, candidates: {}, fetches: {}, consent: null });
  stub.docs.set("plugins.json", RECORDS(OLD_RECEIPT));
  reload();
  host.folders = [LEGACY];
  host.officialArtifacts.cli = OLD;
  host.officialFetchLog.length = 0;
  host.promotes.length = 0;
  resetOfficialUpdatesForTests();
  const before = stub.docs.get("plugins.json");
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.deepEqual(host.promotes, [{ name: "cli", folderId: PINNED.folderId, approved: P().listings.cli.hash }], "its exact approval is on record");
  assert.equal(P().listings.cli.folderId, PINNED.folderId);
  assert.ok(activeManifest(P(), "cli"));
  assert.equal(P().consent, null);
  assert.notEqual(stub.docs.get("plugins.json"), before);
  assert.equal(P().records.cli.approved, P().listings.cli.hash, "a later pin change keeps it approved");
  assert.equal(P().records.cli.previous, OLD_RECEIPT, "the 0.2.47 receipt stays for a rollback");
  assert.equal(P().records.cli.installed, true, "0.2.47 sees it installed");
  assert.equal(takePluginCounts().official_migrations_kept, 1);
});

test("an approval written before a crash, with the switch not done, is finished at the next scan", async () => {
  const pending = manifestHash(NEW, PINNED.folderId);
  usePlugins.setState({ records: {}, candidates: {}, fetches: {}, consent: null });
  stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: { cli: { enabled: true, approved: pending, previous: OLD_RECEIPT, values: {}, applied: {}, installed: true } } }));
  reload();
  host.folders = [{ ...LEGACY, candidate: { folderId: PINNED.folderId, text: NEW, legacyHash: officialLegacyHash(NEW), version: "0.5.0" } }];
  host.promotes.length = 0;
  resetOfficialUpdatesForTests();
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.deepEqual(host.promotes.map((p) => p.approved), [pending]);
  assert.equal(P().listings.cli.folderId, PINNED.folderId);
  assert.ok(activeManifest(P(), "cli"));
});

test("a refused download says why and installs nothing: a SHA-256 mismatch, offline", async () => {
  usePlugins.setState({ records: {}, candidates: {}, fetches: {}, consent: null });
  stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: {} }));
  reload();
  host.folders = [];
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  host.promotes.length = 0;
  for (const code of ["verify", "offline"]) {
    host.officialFetchResults.cli = { ok: false, code, reason: "native reason" };
    const result = await installOfficialPlugin("cli", { showSheet: false });
    assert.deepEqual(result, { ok: false, reason: FETCH_REASONS[code], code }, code);
    assert.deepEqual(P().fetches.cli, { state: "failed", code, reason: FETCH_REASONS[code] });
    assert.equal(P().consent, null);
    assert.equal(P().listings.cli, undefined);
    assert.equal(P().records.cli, undefined);
  }
  assert.deepEqual(host.promotes, []);
  const counts = takePluginCounts();
  assert.equal(counts.official_verify_failures, 1);
  assert.equal(counts.official_fetch_offline, 1);
  delete host.officialFetchResults.cli;
});

test("an update waiting for review shows Update… even while the old command is linked and working", async () => {
  const { officialView } = await import("./officialView.ts");
  const plugin = { name: "cli", title: "Command Line", blurb: "", icon: "terminal.fill", version: "0.4.0", example: "ardia tabs", state: "installed", update: "0.5.0" };
  const linked = { state: "linked", hash: "h", linked: ["ardia"], refused: {}, binDir: "/bin" };
  const view = officialView(plugin, linked, null);
  assert.equal(view.action, "update");
  assert.match(view.status, /0\.5\.0/);
});

test("the switch waits for the approval to reach plugins.json, and a failed switch is retried by Try Again without asking again", async () => {
  const { refusedWrites } = await import("../../test-native/shell.ts");
  const pending = manifestHash(NEW, PINNED.folderId);
  usePlugins.setState({ records: {}, candidates: {}, fetches: {}, consent: null });
  stub.docs.set("plugins.json", RECORDS(OLD_RECEIPT));
  reload();
  host.folders = [{ ...LEGACY, candidate: { folderId: PINNED.folderId, text: NEW, legacyHash: officialLegacyHash(NEW), version: "0.5.0" } }];
  host.promotes.length = 0;
  resetOfficialUpdatesForTests();
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.equal(P().candidates.cli.hash, pending);
  const asked = installOfficialPlugin("cli", { showSheet: false });
  refusedWrites.on = true;
  const confirmed = lifecycle.enablePlugin("cli", P().consent.hash);
  refusedWrites.on = false;
  assert.equal(confirmed, false, "an approval that can't be saved isn't confirmed");
  lifecycle.dismissPluginConsent("cli");
  await asked;
  assert.deepEqual(host.promotes, [], "nothing switches without a saved approval");
  assert.equal(P().listings.cli.legacy, true);
  const again = installOfficialPlugin("cli", { showSheet: false });
  assert.ok(lifecycle.enablePlugin("cli", P().consent.hash));
  host.promoteResult = { ok: false, reason: "busy disk" };
  const first = await again;
  assert.equal(first.ok, false);
  assert.equal(P().fetches.cli?.state, "failed");
  assert.ok(activeManifest(P(), "cli"), "the old copy is still approved through previous");
  host.promoteResult = null;
  const retried = await installOfficialPlugin("cli", { showSheet: false });
  assert.equal(P().consent, null, "Try Again uses the approval on record");
  assert.deepEqual(retried, { ok: true });
  assert.equal(P().listings.cli.folderId, PINNED.folderId);
});

test("a 0.2.47 copy turned off stays listed across a restart and turns back on without asking", async () => {
  usePlugins.setState({ records: {}, candidates: {}, fetches: {}, consent: null });
  stub.docs.set("plugins.json", RECORDS(OLD_RECEIPT));
  reload();
  host.folders = [LEGACY];
  host.officialFetchResults.cli = { ok: false, code: "offline", reason: "offline" };
  resetOfficialUpdatesForTests();
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.ok(activeManifest(P(), "cli"));
  assert.ok(await lifecycle.turnOffPlugin("cli", consentToken()));
  await settle();
  reload();
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.equal(P().listings.cli?.legacy, true, "still listed with its old receipt");
  assert.equal(activeManifest(P(), "cli"), null);
  host.links.length = 0;
  assert.ok(lifecycle.turnOnApprovedPlugin("cli"));
  await settle();
  assert.equal(P().consent, null);
  assert.ok(activeManifest(P(), "cli"));
  assert.equal(host.links.at(-1)?.folderId, "bundled");
  delete host.officialFetchResults.cli;
});

test("a user plugin that happens to be named like an official one is left alone: no background download replaces it", async () => {
  usePlugins.setState({ records: {}, candidates: {}, fetches: {}, consent: null });
  const mine = JSON.stringify({ manifest: 1, name: "cli", title: "My CLI", version: "9.0.0" });
  stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: { cli: { enabled: true, approved: manifestHash(mine, "7:7"), values: {}, applied: {} } } }));
  reload();
  host.folders = [{ name: "cli", status: "ok", text: mine, folderId: "7:7" }];
  host.officialFetchLog.length = 0;
  host.officialArtifacts.cli = NEW;
  resetOfficialUpdatesForTests();
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.equal(P().listings.cli.official, undefined);
  assert.ok(activeManifest(P(), "cli"), "the user's own plugin stays on");
  assert.deepEqual(host.officialFetchLog, [], "nothing is downloaded behind it");
});

test("with no listing left, removing an official name still keeps its data; a user listing's consent is never the candidate's", async () => {
  usePlugins.setState({ records: {}, candidates: {}, fetches: {}, consent: null });
  stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: { cli: { enabled: true, approved: OLD_RECEIPT, values: {}, applied: {}, installed: true } } }));
  reload();
  host.folders = [{ name: "cli", status: "missing", official: true, candidateOnly: true, candidate: { folderId: PINNED.folderId, text: NEW, legacyHash: officialLegacyHash(NEW), version: "0.5.0" } }];
  resetOfficialUpdatesForTests();
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.equal(P().listings.cli, undefined, "its copy failed verification, so nothing is listed");
  host.removed.length = 0;
  const removed = await lifecycle.removePlugin("cli");
  assert.equal(removed.ok, true);
  assert.deepEqual(host.removed, ["official:cli"]);
  const mine = JSON.stringify({ manifest: 1, name: "cli", title: "My CLI", version: "9.0.0" });
  host.folders = [
    { name: "cli", status: "ok", text: mine, folderId: "7:7" },
    { name: "cli", status: "missing", official: true, candidateOnly: true, candidate: { folderId: PINNED.folderId, text: NEW, legacyHash: officialLegacyHash(NEW), version: "0.5.0" } },
  ];
  usePlugins.setState({ consent: null });
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.ok(lifecycle.requestPluginConsent("cli"));
  assert.equal(P().consent.hash, P().listings.cli.hash, "the user's own folder is what its row asks about");
  lifecycle.dismissPluginConsent("cli");
});

test("Install from the official row asks about the official download even beside a user folder of the same name; a Remove whose listing changed meanwhile stops", async () => {
  usePlugins.setState({ records: {}, candidates: {}, fetches: {}, consent: null });
  stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: {} }));
  reload();
  const mine = JSON.stringify({ manifest: 1, name: "cli", title: "My CLI", version: "9.0.0" });
  host.folders = [
    { name: "cli", status: "ok", text: mine, folderId: "7:7" },
    { name: "cli", status: "missing", official: true, candidateOnly: true, candidate: { folderId: PINNED.folderId, text: NEW, legacyHash: officialLegacyHash(NEW), version: "0.5.0" } },
  ];
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  const asked = installOfficialPlugin("cli", { showSheet: false });
  await settle();
  assert.equal(P().consent?.hash, P().candidates.cli.hash, "the official row asks about the official copy");
  lifecycle.dismissPluginConsent("cli");
  await asked;
  host.removed.length = 0;
  const stopped = await lifecycle.removePlugin("cli", undefined, true);
  assert.equal(stopped.ok, false, "the dialog was for the official plugin, and the user folder is what's listed now");
  assert.deepEqual(host.removed, []);
});

test("an active copy whose SHA-256 has left the pin is kept only by its own approval and is never offered for a first approval", async () => {
  usePlugins.setState({ records: {}, candidates: {}, fetches: {}, consent: null });
  stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: {} }));
  reload();
  const oldSha = `official-${"9".repeat(64)}`;
  host.folders = [{ name: "cli", status: "ok", official: true, legacy: true, folderId: oldSha, text: OLD }];
  host.officialFetchResults.cli = { ok: false, code: "offline", reason: "offline" };
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.equal(P().listings.cli, undefined, "no approval on record, so it isn't listed");
  assert.equal(lifecycle.requestPluginConsent("cli"), false);
  stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: { cli: { enabled: true, approved: manifestHash(OLD, oldSha), values: {}, applied: {} } } }));
  reload();
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.ok(activeManifest(P(), "cli"), "its own approval keeps it running until the pinned one is approved");
  delete host.officialFetchResults.cli;
});

test("Remove stops when a different folder of the same kind took the name while the dialog was open", async () => {
  usePlugins.setState({ records: {}, candidates: {}, fetches: {}, consent: null });
  stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: {} }));
  reload();
  const mine = JSON.stringify({ manifest: 1, name: "mine", title: "Mine", version: "1.0.0" });
  host.folders = [{ name: "mine", status: "ok", text: mine, folderId: "1:1" }];
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  const seen = lifecycle.removalIdentity("mine");
  host.folders = [{ name: "mine", status: "ok", text: mine, folderId: "2:2" }];
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  host.removed.length = 0;
  const removed = await lifecycle.removePlugin("mine", undefined, seen);
  assert.equal(removed.ok, false);
  assert.deepEqual(host.removed, []);
});

test("a switch by Update… after a migration whose save failed still records the exact approval first", async () => {
  const { refusedWrites } = await import("../../test-native/shell.ts");
  usePlugins.setState({ records: {}, candidates: {}, fetches: {}, consent: null });
  stub.docs.set("plugins.json", RECORDS(OLD_RECEIPT));
  reload();
  host.folders = [{ ...LEGACY, candidate: { folderId: PINNED.folderId, text: OLD, legacyHash: officialLegacyHash(OLD), version: "0.5.0" } }];
  host.promotes.length = 0;
  resetOfficialUpdatesForTests();
  refusedWrites.on = true;
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  refusedWrites.on = false;
  assert.deepEqual(host.promotes, [], "nothing switches while the exact approval can't be saved");
  assert.equal(P().records.cli.approved, OLD_RECEIPT);
  const result = await installOfficialPlugin("cli", { showSheet: false });
  assert.deepEqual(result, { ok: true });
  assert.equal(P().records.cli.approved, manifestHash(OLD, PINNED.folderId), "the exact approval is on record before the switch");
  assert.equal(P().records.cli.previous, OLD_RECEIPT);
  assert.equal(host.promotes.length, 1);
});

test("Remove hands native the folder identity it saw, so a folder swapped in meanwhile isn't deleted", async () => {
  usePlugins.setState({ records: {}, candidates: {}, fetches: {}, consent: null });
  stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: {} }));
  reload();
  const mine = JSON.stringify({ manifest: 1, name: "mine", title: "Mine", version: "1.0.0" });
  host.folders = [{ name: "mine", status: "ok", text: mine, folderId: "3:3" }];
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  host.removeFolderIds.length = 0;
  const removed = await lifecycle.removePlugin("mine", undefined, lifecycle.removalIdentity("mine"));
  assert.equal(removed.ok, true);
  assert.deepEqual(host.removeFolderIds, ["3:3"]);
});

test("a finished download counts its time, its check time and its resumes; a copy already on disk counts as reused with no time", async () => {
  const fresh = async () => {
    usePlugins.setState({ records: {}, candidates: {}, fetches: {}, consent: null });
    stub.docs.set("plugins.json", JSON.stringify({ version: 1, plugins: {} }));
    reload();
    host.folders = [];
    await lifecycle.rescanPlugins(consentToken());
    await settle();
  };
  await fresh();
  takePluginCounts();
  host.officialArtifacts.cli = NEW;
  host.officialFetchOk.cli = { timings: { downloadMs: 2345, verifyMs: 87, bytes: 29_000_000, resumes: 2 } };
  assert.deepEqual(await fetchOfficialCandidate("cli", consentToken()), { ok: true });
  let counts = takePluginCounts();
  assert.deepEqual([counts.official_fetches, counts.official_fetches_timed, counts.official_fetch_ms, counts.official_verify_ms, counts.official_fetch_resumes, counts.official_fetches_reused], [1, 1, 2300, 90, 2, 0]);
  await fresh();
  host.officialFetchOk.cli = { reused: true };
  assert.deepEqual(await fetchOfficialCandidate("cli", consentToken()), { ok: true });
  counts = takePluginCounts();
  assert.deepEqual([counts.official_fetches, counts.official_fetches_timed, counts.official_fetch_ms, counts.official_verify_ms, counts.official_fetch_resumes, counts.official_fetches_reused], [1, 0, 0, 0, 0, 1]);
  await fresh();
  delete host.officialFetchOk.cli;
  assert.deepEqual(await fetchOfficialCandidate("cli", consentToken()), { ok: true });
  counts = takePluginCounts();
  assert.deepEqual([counts.official_fetches, counts.official_fetches_timed, counts.official_fetch_ms, counts.official_fetches_reused], [1, 0, 0, 0], "an older native build sends no timings");
});
