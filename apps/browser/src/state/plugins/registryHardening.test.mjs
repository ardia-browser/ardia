import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { detail, fakeRegistry, keyPair, officialSig, sha, version } from "./fixtures/registry.mjs";
import { v3Text } from "./fixtures/manifests.mjs";
const stub = await import("../../test-native/index.ts");
const shell = await import("../../test-native/shell.ts");
const { reloadLaunchConfigForTests } = await import("../../platform/launchConfig.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePlugins, activeManifest } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { startPlugins } = await import("./start.ts");
const client = await import("./registryClient.ts");
const revocations = await import("./revocations.ts");
const lockfile = await import("./lockfile.ts");
const { planInstall, newInPlan } = await import("./installPlan.ts");
const { installPlugin } = await import("./installer.ts");
const updater = await import("./updater.ts");
const { migrateLegacyPlugins } = await import("./migration.ts");
const { devReload, devLinkPath } = await import("./devReload.ts");
const { githubDetail, wantedAssets } = await import("./githubSource.ts");
const savedState = await import("./savedState.ts");
const { resetCandidatesForTests } = await import("./candidates.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
const { refreshCatalog, useCatalog, addRegistry, installFromFile, installFromDeepLink, setPluginChannel } = await import("./marketplace.ts");
const { handlePluginInstallLinks, takePluginInstallLinks, resetInstallLinksForTests } = await import("./installLinks.ts");
const { pluginMenuItems } = await import("./menus.ts");
const { manifestInProfile, eventProfileId } = await import("./profileScope.ts");
const { storageSpace } = await import("./storage.ts");
const { secretSpace } = await import("./secrets.ts");
const { requestProfile } = await import("./channelData.ts");
setConsentPeriod(true, "plugins-registry-hardening-test");

const BASE = "https://registry.test/r";
const CUSTOM = "https://corp.test/r";
const registryKeys = keyPair();
const customKeys = keyPair();
const nativeKeys = keyPair();
const host = stub.pluginHost;
const P = () => usePlugins.getState();
const tick = () => new Promise((r) => setTimeout(r, 5));

function configure(keys = true) {
  shell.launch.pluginRegistryURL = BASE;
  shell.launch.pluginRegistryKeys = keys ? `test=${registryKeys.publicPem}` : null;
  shell.launch.pluginNativeKeys = `native=${nativeKeys.publicPem}`;
  reloadLaunchConfigForTests();
}

const manifestFor = (id, v, extra = {}) => {
  const [scope, name] = id.slice(1).split("/");
  return v3Text({ name, title: name, version: v, main: "index.js", ...extra }, scope);
};

let registry;
let custom;

function route(defaultUp = true) {
  client.setRegistryFetcherForTests((url, headers, signal) => {
    if (url.startsWith(CUSTOM)) return custom.fetcher(url, headers, signal);
    if (!defaultUp) return Promise.reject(new TypeError("Network request failed"));
    return registry.fetcher(url, headers, signal);
  });
}

beforeEach(async () => {
  configure();
  useBrowser.getState().hydrate({});
  startPlugins();
  Object.assign(host, { folders: [], artifacts: {}, artifactResults: {}, artifactLog: [], artifactVersions: {}, artifactShas: {}, officialVerified: true, activations: [], activateResult: null, adoptions: [], rollbacks: [], rollbackResults: [], artifactGate: null, listFails: false, localInstalls: [], localInstallResult: null });
  host.adoptResult = { ok: true, found: false, moved: [] };
  for (const doc of ["Plugins/plugins-lock.json", "Plugins/plugins-state.json", "Plugins/revocations-cache.json", "Plugins/registry-cache.json", "plugins.json"]) stub.docs.delete(doc);
  lockfile.resetLockForTests();
  revocations.resetRevocationsForTests();
  client.resetRegistryCacheForTests();
  savedState.resetPluginsExtrasForTests();
  resetCandidatesForTests();
  usePlugins.setState({ records: {}, listings: {}, order: [], candidates: {}, consent: null, fetches: {} });
  registry = fakeRegistry(BASE, registryKeys);
  custom = fakeRegistry(CUSTOM, customKeys);
  route();
  takePluginCounts();
});

async function confirmWhenAsked(done) {
  for (let i = 0; i < 100 && !P().consent; i++) await tick();
  assert.ok(P().consent, "the consent sheet opened");
  assert.ok(lifecycle.confirmConsentRequest(P().consent.id));
  return done;
}

async function installed(id, v, extra = {}, versions = [version(v)]) {
  await registry.publish([detail(id, versions)]);
  host.artifacts[`${id}@${v}`] = manifestFor(id, v, extra);
  assert.deepEqual(await confirmWhenAsked(installPlugin({ id }, { showSheet: false })), { ok: true });
  await lifecycle.rescanPlugins(null);
}

const revocationList = (seq, entries) => ({ seq, issuedAt: "2026-11-25T10:00:00Z", entries: entries.map((e, i) => ({ entryId: `e${i}`, seq, issuedAt: "2026-11-25T10:00:00Z", reason: "Bad release", ...e })) });

describe("official code is judged by the plugin.json Ardia downloaded", () => {
  const PROGRAMS = { programs: [{ name: "ardia", path: "bin/ardia" }] };
  const official = (sig) => detail("@ardia/cli", [version("1.0.0", { artifacts: { universal: { url: "https://github.com/ardia-browser/plugins/releases/download/cli-v1/cli.tar.gz", sha256: sha(1), sizeBytes: 10, ...(sig ? { officialSig: sig } : {}) } } })]);

  test("an @ardia download whose plugin.json puts programs on PATH needs the official signature even when the registry calls it sandboxed", async () => {
    await registry.publish([official(null)]);
    host.artifacts["@ardia/cli"] = manifestFor("@ardia/cli", "1.0.0", PROGRAMS);
    const refused = await installPlugin({ id: "@ardia/cli" }, { showSheet: false });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /isn't signed by Ardia's release key/);
    assert.equal(P().consent, null, "nothing reaches the consent sheet");
    assert.equal(P().candidates.ardia__cli, undefined, "the unsigned download isn't offered");
    assert.deepEqual(host.activations, []);
    assert.equal(lockfile.currentLock()["@ardia/cli"], undefined);
    client.resetRegistryCacheForTests();
    const signed = await officialSig({ id: "@ardia/cli", version: "1.0.0", platform: "universal", sha256: sha(1) }, nativeKeys);
    await registry.publish([official(signed)]);
    assert.deepEqual(await confirmWhenAsked(installPlugin({ id: "@ardia/cli" }, { showSheet: false })), { ok: true });
    assert.equal(host.artifactLog.at(-1).officialSig, signed, "native gets the signature to check and record itself");
    assert.equal(host.artifactLog.at(-1).platform, "universal");
    const entry = lockfile.currentLock()["@ardia/cli"];
    assert.equal(entry.officialSig, signed);
    assert.equal(entry.platform, "universal");
  });

  test("a signature native didn't confirm isn't enough", async () => {
    const signed = await officialSig({ id: "@ardia/cli", version: "1.0.0", platform: "universal", sha256: sha(1) }, nativeKeys);
    await registry.publish([official(signed)]);
    host.artifacts["@ardia/cli"] = manifestFor("@ardia/cli", "1.0.0", PROGRAMS);
    host.officialVerified = false;
    try {
      const refused = await installPlugin({ id: "@ardia/cli" }, { showSheet: false });
      assert.equal(refused.ok, false);
      assert.match(refused.reason, /isn't signed/);
    } finally {
      host.officialVerified = true;
    }
  });
});

describe("a download must be the exact copy the plan asked for", () => {
  test("a copy that comes back with another digest or version is refused before consent", async () => {
    await registry.publish([detail("@acme/a", [version("1.0.0")])]);
    host.artifacts["@acme/a"] = manifestFor("@acme/a", "1.0.0");
    host.artifactShas[sha(1)] = sha(9);
    const other = await installPlugin({ id: "@acme/a" }, { showSheet: false });
    assert.equal(other.ok, false);
    assert.match(other.reason, /isn't the one the registry signed/);
    host.artifactShas = {};
    host.artifactVersions[sha(1)] = "9.9.9";
    const older = await installPlugin({ id: "@acme/a" }, { showSheet: false });
    assert.equal(older.ok, false);
    assert.match(older.reason, /version 9\.9\.9, not 1\.0\.0/);
    assert.equal(P().consent, null);
    assert.equal(takePluginCounts().registry_verify_failures, 2);
  });
});

describe("revocations hold at every activation", () => {
  test("a .tar.gz of a revoked version is turned away before the consent sheet", async () => {
    await registry.publish([], revocationList(2, [{ match: { id: "@acme/file", versions: ["1.0.0"] }, action: "disable" }]));
    const candidate = { folderId: `store-${sha(3)}`, text: manifestFor("@acme/file", "1.0.0"), version: "1.0.0" };
    host.folders = [{ name: "acme__file", status: "missing", source: "store", candidates: [candidate] }];
    host.localInstallResult = { ok: true, name: "acme__file", id: "@acme/file", source: "store", sha256: sha(3), candidate };
    const result = await installFromFile("/tmp/acme-file.tar.gz");
    assert.equal(result.ok, false);
    assert.match(result.reason, /turned off by Ardia's registry: Bad release/);
    assert.equal(P().consent, null);
    assert.equal(takePluginCounts().file_installs_revoked, 1);
  });

  test("a revocation reaches a plugin installed from a folder, which the lock never lists", async () => {
    host.folders = [{ name: "acme__loose", status: "ok", source: "local", text: manifestFor("@acme/loose", "1.0.0"), folderId: `local-${"a".repeat(64)}` }];
    await lifecycle.rescanPlugins(null);
    usePlugins.setState({ records: { acme__loose: { enabled: true, approved: P().listings.acme__loose.hash, values: {}, applied: {} } } });
    assert.ok(activeManifest(P(), "acme__loose"));
    await registry.publish([], revocationList(3, [{ match: { id: "@acme/loose" }, action: "block" }]));
    await updater.checkPlugins(consentToken());
    assert.equal(P().records.acme__loose.revoked.action, "block");
    assert.equal(activeManifest(P(), "acme__loose"), null);
  });

  test("approving a download the registry revoked while the sheet was open is refused and nothing switches", async () => {
    await registry.publish([detail("@acme/a", [version("1.0.0")])]);
    host.artifacts["@acme/a"] = manifestFor("@acme/a", "1.0.0");
    const done = installPlugin({ id: "@acme/a" }, { showSheet: false });
    for (let i = 0; i < 100 && !P().consent; i++) await tick();
    revocations.resetRevocationsForTests(revocationList(9, [{ match: { id: "@acme/a" }, action: "disable" }]));
    assert.equal(lifecycle.confirmConsentRequest(P().consent.id), false);
    const result = await done;
    assert.equal(result.ok, false);
    assert.match(result.reason, /turned it off: Bad release/);
    assert.deepEqual(host.activations, []);
    assert.equal(P().records.acme__a?.enabled ?? false, false);
  });

  test("a rollback checks the earlier version against revocations and restores its whole lock entry", async () => {
    await installed("@acme/a", "1.0.0", { permissions: { tabs: "read" } });
    client.resetRegistryCacheForTests();
    await registry.publish([detail("@acme/a", [version("1.0.0"), version("2.0.0")])]);
    host.artifacts["@acme/a@2.0.0"] = manifestFor("@acme/a", "2.0.0", { permissions: { tabs: "read" } });
    await updater.checkPlugins(consentToken());
    const updatedEntry = lockfile.currentLock()["@acme/a"];
    assert.equal(updatedEntry.version, "2.0.0");
    assert.deepEqual([updatedEntry.previous.version, updatedEntry.previous.sha256, updatedEntry.previous.repo], ["1.0.0", sha(1), "acme/plugins"], "the lock keeps the earlier copy's provenance");
    revocations.resetRevocationsForTests(revocationList(10, [{ match: { id: "@acme/a", versions: ["1.0.0"] }, action: "disable" }]));
    const refused = await updater.rollbackPlugin("acme__a");
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /turned off/);
    assert.equal(P().listings.acme__a.manifest.version, "2.0.0", "nothing switched");
    assert.equal(takePluginCounts().rollback_refusals, 1);
    revocations.resetRevocationsForTests(revocationList(11, []));
    assert.equal((await updater.rollbackPlugin("acme__a")).ok, true);
    const back = lockfile.currentLock()["@acme/a"];
    assert.deepEqual([back.version, back.sha256, back.repo], ["1.0.0", sha(1), "acme/plugins"]);
    assert.equal(back.previous.version, "2.0.0", "going forward again stays possible");
  });

  test("an @ardia rollback target with no recorded release signature isn't switched to", async () => {
    const text = manifestFor("@ardia/tool", "2.0.0", { programs: [{ name: "tool", path: "bin/tool" }] });
    const earlier = manifestFor("@ardia/tool", "1.0.0", { programs: [{ name: "tool", path: "bin/tool" }] });
    host.folders = [{ name: "ardia__tool", status: "ok", source: "store", text, folderId: `store-${sha(2)}`, previous: { folderId: `store-${sha(1)}`, text: earlier, version: "1.0.0" } }];
    await lifecycle.rescanPlugins(null);
    usePlugins.setState({ records: { ardia__tool: { enabled: true, approved: P().listings.ardia__tool.hash, previous: "b".repeat(64), values: {}, applied: {} } } });
    await lockfile.writeLock({ "@ardia/tool": { id: "@ardia/tool", key: "ardia__tool", version: "2.0.0", channel: "latest", source: { kind: "registry", url: BASE }, sha256: sha(2), payloadDigest: null, dependencies: [], root: true, official: true, installedAt: 1, previous: { version: "1.0.0", source: { kind: "registry", url: BASE }, sha256: sha(1), payloadDigest: null, dependencies: [] } } }, null);
    const refused = await updater.rollbackPlugin("ardia__tool");
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /release signature/);
    assert.deepEqual(host.rollbacks.filter((n) => n === "ardia__tool"), []);
  });
});

describe("the lock follows what's active", () => {
  test("Update… writes the new version to the lock only once it's switched to", async () => {
    await installed("@acme/a", "1.0.0", { permissions: { tabs: "read" } });
    client.resetRegistryCacheForTests();
    await registry.publish([detail("@acme/a", [version("1.0.0"), version("2.0.0")])]);
    host.artifacts["@acme/a@2.0.0"] = manifestFor("@acme/a", "2.0.0", { permissions: { tabs: "write" } });
    await updater.checkPlugins(consentToken());
    assert.equal(lockfile.currentLock()["@acme/a"].version, "1.0.0", "a waiting update isn't in the lock");
    assert.ok(updater.reviewUpdate("acme__a"));
    assert.ok(lifecycle.confirmConsentRequest(P().consent.id));
    for (let i = 0; i < 100 && lockfile.currentLock()["@acme/a"].version !== "2.0.0"; i++) await tick();
    const entry = lockfile.currentLock()["@acme/a"];
    assert.deepEqual([entry.version, entry.sha256, entry.previous.version], ["2.0.0", sha(2), "1.0.0"]);
  });

  test("removing a plugin drops its lock entry", async () => {
    await installed("@acme/a", "1.0.0");
    assert.ok(lockfile.currentLock()["@acme/a"]);
    const removed = await lifecycle.removePlugin("acme__a");
    assert.equal(removed.ok, true, removed.reason);
    assert.equal(lockfile.currentLock()["@acme/a"], undefined);
  });

  test("a locked version whose files are gone is downloaded again", async () => {
    await installed("@acme/a", "1.0.0");
    const plan = await planInstall({ id: "@acme/a" });
    assert.deepEqual(newInPlan(plan.plan), [], "a copy on disk isn't fetched again");
    host.folders = [];
    await lifecycle.rescanPlugins(null);
    assert.deepEqual(newInPlan(plan.plan).map((p) => p.id), ["@acme/a"]);
  });

  test("an install settles only after the switch, and a failed switch fails it and leaves the lock alone", async () => {
    await registry.publish([detail("@acme/a", [version("1.0.0")])]);
    host.artifacts["@acme/a"] = manifestFor("@acme/a", "1.0.0");
    host.activateResult = { ok: false, reason: "disk full" };
    const result = await confirmWhenAsked(installPlugin({ id: "@acme/a" }, { showSheet: false }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "disk full");
    assert.equal(lockfile.currentLock()["@acme/a"], undefined);
  });

  test("an install keeps each plugin's repo, so owner and repo revocations match", async () => {
    await installed("@acme/a", "1.0.0");
    assert.equal(lockfile.currentLock()["@acme/a"].repo, "acme/plugins");
    revocations.resetRevocationsForTests(revocationList(4, [{ match: { githubOwner: "acme" }, action: "disable" }]));
    await updater.enforceRevocations(null);
    assert.equal(P().records.acme__a.revoked.action, "disable");
  });
});

describe("background updates carry their dependencies", () => {
  test("a root update that needs a newer installed dependency asks for both together and writes neither early", async () => {
    await registry.publish([detail("@acme/app", [version("1.0.0", { dependencies: { "@acme/lib": "^1.0.0" } })]), detail("@acme/lib", [version("1.0.0")])]);
    host.artifacts["@acme/app@1.0.0"] = manifestFor("@acme/app", "1.0.0", { dependencies: { "@acme/lib": "^1.0.0" } });
    host.artifacts["@acme/lib@1.0.0"] = manifestFor("@acme/lib", "1.0.0");
    assert.deepEqual(await confirmWhenAsked(installPlugin({ id: "@acme/app" }, { showSheet: false })), { ok: true });
    await lifecycle.rescanPlugins(null);
    client.resetRegistryCacheForTests();
    const app2 = version("2.0.0", { dependencies: { "@acme/lib": "^2.0.0" } });
    await registry.publish([detail("@acme/app", [version("1.0.0", { dependencies: { "@acme/lib": "^1.0.0" } }), app2]), detail("@acme/lib", [version("1.0.0"), version("2.0.0", { artifacts: { universal: { url: "https://github.com/acme/plugins/releases/download/lib2/lib.tar.gz", sha256: sha(5), sizeBytes: 10 } } })])]);
    host.artifacts["@acme/app@2.0.0"] = manifestFor("@acme/app", "2.0.0", { dependencies: { "@acme/lib": "^2.0.0" } });
    host.artifacts["@acme/lib@2.0.0"] = manifestFor("@acme/lib", "2.0.0", { permissions: { tabs: "read" } });
    await updater.checkPlugins(consentToken());
    const lock = lockfile.currentLock();
    assert.deepEqual([lock["@acme/app"].version, lock["@acme/lib"].version], ["1.0.0", "1.0.0"], "nothing waiting is written to the lock");
    const pending = P().records.acme__app.pendingUpdate;
    assert.ok(pending, "the app's update waits");
    assert.deepEqual(pending.bundle.map((b) => b.name), ["acme__lib"]);
    assert.ok(pending.added.some((line) => line.startsWith("@acme/lib")), "the sheet names what the dependency adds");
    assert.ok(updater.reviewUpdate("acme__app"));
    assert.deepEqual(P().consent.bundle.map((b) => b.name), ["acme__lib"]);
    assert.ok(lifecycle.confirmConsentRequest(P().consent.id));
    for (let i = 0; i < 100 && lockfile.currentLock()["@acme/app"].version !== "2.0.0"; i++) await tick();
    await lifecycle.rescanPlugins(null);
    assert.deepEqual([lockfile.currentLock()["@acme/app"].version, lockfile.currentLock()["@acme/lib"].version], ["2.0.0", "2.0.0"]);
    assert.deepEqual([P().listings.acme__app.manifest.version, P().listings.acme__lib.manifest.version], ["2.0.0", "2.0.0"]);
  });
});

describe("the legacy cli move", () => {
  test("a turned-off legacy cli stays off, and the move isn't done until native says nothing is left", async () => {
    usePlugins.setState({ records: { cli: { enabled: false, approved: "a".repeat(64), values: {}, applied: {} } } });
    host.adoptResult = { ok: true, found: true, moved: ["programs"], leftover: true };
    await migrateLegacyPlugins(null);
    assert.equal(P().records.ardia__cli.enabled, false);
    assert.equal(P().records.ardia__cli.preapproved, undefined, "a disabled record isn't approved in advance");
    assert.equal(savedState.pluginsExtras().migrated.includes("cli"), false, "the old download is still there");
    await migrateLegacyPlugins(null);
    assert.equal(P().records.ardia__cli.preapproved, undefined, "running again changes nothing");
    host.adoptResult = { ok: true, found: false, moved: ["download"], leftover: false };
    await migrateLegacyPlugins(null);
    assert.ok(savedState.pluginsExtras().migrated.includes("cli"));
  });

  test("a move native couldn't finish is retried and keeps the old record", async () => {
    usePlugins.setState({ records: { cli: { enabled: true, approved: "a".repeat(64), values: {}, applied: {} } } });
    host.adoptResult = { ok: false, found: true, moved: [], reason: "PATH couldn't be pointed at its new folder" };
    assert.deepEqual(await migrateLegacyPlugins(consentToken()), []);
    assert.ok(P().records.cli, "the old record stays until the move works");
    assert.equal(lockfile.currentLock()["@ardia/cli"], undefined);
    assert.equal(savedState.pluginsExtras().migrated.includes("cli"), false);
    assert.equal(takePluginCounts().migrations_failed, 1);
  });
});

describe("registries you add", () => {
  test("the catalog shows each plugin from the registry an install would use", async () => {
    await registry.publish([detail("@acme/a", [version("1.0.0")]), detail("@corp/x", [version("1.0.0")])]);
    await custom.publish([detail("@corp/x", [version("1.0.0")]), detail("@other/y", [version("1.0.0")])]);
    assert.equal(addRegistry(CUSTOM, "", `test=${customKeys.publicPem}`).ok, false, "a registry names its scopes");
    assert.deepEqual(addRegistry(CUSTOM, "@corp", `test=${customKeys.publicPem}`), { ok: true });
    await refreshCatalog(true);
    const rows = useCatalog.getState().entries.map((e) => `${e.id}@${e.registry}`).sort();
    assert.deepEqual(rows, [`@acme/a@${BASE}`, `@corp/x@${CUSTOM}`]);
    assert.equal(client.registryForId("@corp/x").url, CUSTOM);
  });

  test("with no built-in key, ardia.dev stays closed while a registry with its own key installs; with one, revocations must load first", async () => {
    configure(false);
    route();
    await custom.publish([detail("@corp/x", [version("1.0.0")])]);
    assert.deepEqual(addRegistry(CUSTOM, "@corp", `test=${customKeys.publicPem}`), { ok: true });
    host.artifacts["@corp/x"] = manifestFor("@corp/x", "1.0.0");
    assert.deepEqual(await confirmWhenAsked(installPlugin({ id: "@corp/x" }, { showSheet: false })), { ok: true });
    const closed = await installPlugin({ id: "@acme/a" }, { showSheet: false });
    assert.equal(closed.ok, false);
    assert.match(closed.reason, /no key/);
    configure(true);
    route(false);
    client.resetRegistryCacheForTests();
    stub.docs.delete("Plugins/registry-cache.json");
    const refused = await installPlugin({ id: "@corp/x", channel: "beta" }, { showSheet: false });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /revocation list/);
  });

  test("github: releases give this computer's asset, not every asset labelled universal", async () => {
    const m = { id: "@a/tool", version: "1.2.0", release: { github: "a/tool", assets: { "macos-arm64": "tool-{version}-mac.tar.gz", universal: "tool-{version}.tar.gz" } } };
    assert.deepEqual(wantedAssets(m, "macos-arm64"), [{ platform: "macos-arm64", name: "tool-1.2.0-mac.tar.gz" }, { platform: "universal", name: "tool-1.2.0.tar.gz" }]);
    assert.deepEqual(wantedAssets(m, "linux-x64"), [{ platform: "universal", name: "tool-1.2.0.tar.gz" }]);
    assert.deepEqual(wantedAssets({ ...m, release: { github: "a/tool", asset: "tool-{platform}.tar.gz" } }, "linux-x64"), [{ platform: "linux-x64", name: "tool-linux-x64.tar.gz" }]);
    const manifest = v3Text({ name: "tool", title: "Tool", version: "1.2.0", main: "index.js", release: { github: "a/tool", assets: { "macos-arm64": "tool-{version}-mac.tar.gz" } } }, "a");
    const files = {
      "https://api.github.com/repos/a/tool/releases?per_page=20": JSON.stringify([{ tag_name: "v1.2.0", prerelease: false, published_at: "2026-11-25T10:00:00Z", assets: [{ name: "tool-1.2.0-mac.tar.gz", browser_download_url: "https://github.com/a/tool/releases/download/v1.2.0/tool-1.2.0-mac.tar.gz", size: 50 }, { name: "tool-1.2.0-mac.tar.gz.sha256", browser_download_url: "https://github.com/a/tool/releases/download/v1.2.0/mac.sha256", size: 64 }] }]),
      "https://raw.githubusercontent.com/a/tool/v1.2.0/plugin.json": manifest,
      "https://github.com/a/tool/releases/download/v1.2.0/mac.sha256": `${sha(7)}  tool-1.2.0-mac.tar.gz\n`,
    };
    const fetcher = async (url) => (files[url] === undefined ? { status: 404, header: () => null, text: async () => "" } : { status: 200, header: () => null, text: async () => files[url] });
    const got = await githubDetail(fetcher, "a/tool", "macos-arm64");
    assert.equal(got.ok, true, got.reason);
    assert.deepEqual(Object.keys(got.detail.versions[0].artifacts), ["macos-arm64"]);
    assert.equal((await githubDetail(fetcher, "a/tool", "linux-x64")).ok, false, "there's nothing for this computer");
  });
});

describe("dev reloads and install links", () => {
  const devFolder = (text) => ({ name: "acme__dev", status: "ok", source: "dev", text, folderId: "dev-abc", devPath: "/work/dev" });
  const params = { id: "@acme/dev", path: "/work/dev", link: devLinkPath("@acme/dev", "/config") };

  test("a reload names the folder the dev link points at, or it's refused before any consent", async () => {
    host.folders = [devFolder(manifestFor("@acme/dev", "1.0.0"))];
    const elsewhere = await devReload({ ...params, path: "/tmp/evil" });
    assert.equal(elsewhere.error.code, "bad_request");
    assert.equal(P().consent, null);
    assert.equal((await devReload({ ...params, path: "/work/dev/" })).error.code, "needs_consent", "a trailing slash is the same folder");
    lifecycle.dismissPluginConsent();
  });

  test("an install link that arrives before plugins start waits for them", () => {
    resetInstallLinksForTests();
    try {
      assert.deepEqual(takePluginInstallLinks(["ardia://plugin/install/@acme/jira", "ardia://plugin/install/@acme/jira", "https://a.example/"]), ["https://a.example/"]);
      const seen = [];
      handlePluginInstallLinks((id) => (seen.push(id), true));
      assert.deepEqual(seen, ["@acme/jira"], "it's handed over once the handler is there, once");
    } finally {
      handlePluginInstallLinks(installFromDeepLink);
    }
  });
});

const MENU = { commands: [{ name: "go", title: "Go" }], contributes: { menus: { tab: [{ command: "go" }] } }, permissions: { storage: true, secrets: true }, settings: { rows: [{ key: "token", type: "secret", title: "Token" }] } };

async function scopedPlugin(profiles) {
    host.folders = [{ name: "acme__m", status: "ok", source: "local", text: manifestFor("@acme/m", "1.0.0", MENU), folderId: `local-${"c".repeat(64)}` }];
    await lifecycle.rescanPlugins(null);
    usePlugins.setState({ records: { acme__m: { enabled: true, approved: P().listings.acme__m.hash, values: {}, applied: {}, profiles } } });
    useBrowser.setState((b) => ({
      profiles: { ...b.profiles, work: { ...b.profiles.default, id: "work", name: "Work" } },
      windows: { ...b.windows, ww: { ...(Object.values(b.windows)[0] ?? {}), id: "ww", kind: "main", profileId: "work" }, wd: { ...(Object.values(b.windows)[0] ?? {}), id: "wd", kind: "main", profileId: "default" } },
    }));
}

describe("profile-scoped plugins", () => {
  test("menus, commands and events reach a profile plugin only in its profiles", async () => {
    await scopedPlugin(["work"]);
    assert.equal(P().listings.acme__m.manifest.scope, "profile");
    const items = (windowId) => pluginMenuItems("tab", { when: {}, data: { windowId } }).map((i) => i.id);
    assert.equal(items("ww").length, 1);
    assert.deepEqual(items("wd"), [], "a window of another profile doesn't list it");
    const { runPluginCommand } = await import("./commands.ts");
    assert.equal(await runPluginCommand("acme__m", "go", "wd"), false, "its command doesn't run from another profile's window");
    assert.ok(manifestInProfile(P(), "acme__m", "work"));
    assert.equal(manifestInProfile(P(), "acme__m", "default"), null);
    assert.equal(manifestInProfile(P(), "acme__m", null), null, "an event with no profile doesn't reach a plugin limited to some");
    assert.equal(eventProfileId({ windowId: "ww" }), "work");
  });

  test("a profile plugin's storage and runtime secrets live under the profile; settings secrets stay shared", async () => {
    await scopedPlugin(["work"]);
    const m = P().listings.acme__m.manifest;
    assert.equal(storageSpace("acme__m", "work"), "profiles/work/acme__m");
    assert.equal(storageSpace("acme__m", null), "acme__m");
    assert.equal(secretSpace("acme__m", "work"), "acme__m@work");
    assert.deepEqual(requestProfile("acme__m", m, { profile: "work" }), { ok: true, profileId: "work" });
    assert.equal(requestProfile("acme__m", m, { profile: "default" }).ok, false, "a profile it's off in is refused");
    assert.deepEqual(requestProfile("acme__m", m, {}), { ok: true, profileId: "work" }, "with nothing named, the first profile it's on in");
    assert.deepEqual(requestProfile("acme__m", { scope: "global" }, { profile: "work" }), { ok: true, profileId: null });
  });
});

describe("the revocation list's floor", () => {
  test("a cached list that doesn't verify can't raise the seq floor", async () => {
    stub.docs.set("Plugins/revocations-cache.json", JSON.stringify({ version: 1, seq: 999, envelope: { v: 1, kid: "test", sig: "x", payload: {} } }));
    await registry.publish([], revocationList(5, []));
    const got = await revocations.refreshRevocations();
    assert.equal(got.ok, true, got.reason);
    assert.equal(revocations.revocationSeq(), 5);
  });
});

const LOCK_DOC = "Plugins/plugins-lock.json";

function failingWrites(name) {
  const realSet = stub.docs.set.bind(stub.docs);
  let failing = true;
  stub.docs.set = (key, value) => {
    if (failing && key === name) throw new Error("disk full");
    return realSet(key, value);
  };
  return () => {
    failing = false;
    stub.docs.set = realSet;
  };
}

async function promptedUpdate() {
  await installed("@acme/a", "1.0.0", { permissions: { tabs: "read" } });
  client.resetRegistryCacheForTests();
  await registry.publish([detail("@acme/a", [version("1.0.0"), version("2.0.0")])]);
  host.artifacts["@acme/a@2.0.0"] = manifestFor("@acme/a", "2.0.0", { permissions: { tabs: "write" } });
  await updater.checkPlugins(consentToken());
  assert.ok(P().records.acme__a.pendingUpdate);
}

describe("round 2: official code at consent and activation", () => {
  const PROGRAMS = { programs: [{ name: "tool", path: "bin/tool" }] };
  const candidateFolder = () => ({ name: "ardia__tool", status: "missing", source: "store", candidates: [{ folderId: `store-${sha(4)}`, text: manifestFor("@ardia/tool", "1.0.0", PROGRAMS), version: "1.0.0" }] });
  const entry = (extra = {}) => ({ id: "@ardia/tool", key: "ardia__tool", version: "1.0.0", channel: "latest", source: { kind: "registry", url: BASE }, sha256: sha(4), payloadDigest: null, dependencies: [], root: true, official: true, installedAt: 1, ...extra });

  test("an @ardia candidate that reaches outside the sandbox with no recorded signature never reaches the sheet", async () => {
    const { wantCandidate } = await import("./candidates.ts");
    host.folders = [candidateFolder()];
    wantCandidate("ardia__tool", `store-${sha(4)}`);
    await lifecycle.rescanPlugins(null);
    assert.ok(P().candidates.ardia__tool?.hash);
    assert.equal(lifecycle.requestPluginConsent("ardia__tool"), false);
    assert.equal(lifecycle.approvePlugin("ardia__tool", P().candidates.ardia__tool.hash, null), false);
  });

  test("a recorded signature that doesn't verify stops the switch, so nothing activates", async () => {
    const { wantCandidate } = await import("./candidates.ts");
    host.folders = [candidateFolder()];
    assert.ok(await lockfile.stageLockEntries([{ folderId: `store-${sha(4)}`, entry: entry({ officialSig: "A".repeat(86), platform: "universal" }) }]));
    wantCandidate("ardia__tool", `store-${sha(4)}`);
    await lifecycle.rescanPlugins(null);
    assert.ok(lifecycle.requestPluginConsent("ardia__tool"));
    assert.ok(lifecycle.confirmConsentRequest(P().consent.id));
    assert.equal((await lifecycle.settledPromotions(["ardia__tool"])).ok, false);
    assert.deepEqual(host.activations, [], "native is never asked to switch to it");
  });
});

describe("round 2: revocations at every turn-on", () => {
  test("a plugin turned off and then blocked can't be turned back on", async () => {
    await installed("@acme/a", "1.0.0");
    assert.ok(lifecycle.disablePlugin("acme__a", null));
    revocations.resetRevocationsForTests(revocationList(20, [{ match: { id: "@acme/a" }, action: "block" }]));
    assert.equal(lifecycle.turnOnApprovedPlugin("acme__a"), false);
    assert.equal(P().records.acme__a.enabled, false);
  });

  test("a download yanked while its sheet was open is refused at the button", async () => {
    await registry.publish([detail("@acme/a", [version("1.0.0")])]);
    host.artifacts["@acme/a"] = manifestFor("@acme/a", "1.0.0");
    const done = installPlugin({ id: "@acme/a" }, { showSheet: false });
    for (let i = 0; i < 100 && !P().consent; i++) await tick();
    revocations.resetRevocationsForTests(revocationList(21, [{ match: { id: "@acme/a", versions: ["1.0.0"] }, action: "yank" }]));
    assert.equal(lifecycle.confirmConsentRequest(P().consent.id), false);
    assert.equal((await done).ok, false);
    assert.deepEqual(host.activations, []);
  });

  test("a rollback hands native the exact earlier copy it checked", async () => {
    await installed("@acme/a", "1.0.0", { permissions: { tabs: "read" } });
    client.resetRegistryCacheForTests();
    await registry.publish([detail("@acme/a", [version("1.0.0"), version("2.0.0")])]);
    host.artifacts["@acme/a@2.0.0"] = manifestFor("@acme/a", "2.0.0", { permissions: { tabs: "read" } });
    await updater.checkPlugins(consentToken());
    const folder = host.folders.find((f) => f.name === "acme__a");
    folder.previous = { ...folder.previous, folderId: `store-${sha(8)}` };
    const swapped = await updater.rollbackPlugin("acme__a");
    assert.equal(swapped.ok, false, "a previous copy that changed since the check isn't switched to");
    assert.equal(P().listings.acme__a.manifest.version, "2.0.0");
  });
});

describe("round 2: store, staged provenance and the lock stay together", () => {
  test("a reinstall after the files vanished downloads again even when the listing is stale", async () => {
    await installed("@acme/a", "1.0.0");
    const before = host.artifactLog.length;
    host.folders = [];
    const done = installPlugin({ id: "@acme/a" }, { showSheet: false });
    for (let i = 0; i < 100 && !P().consent && host.artifactLog.length === before; i++) await tick();
    for (let i = 0; i < 100 && !P().consent; i++) await tick();
    if (P().consent) lifecycle.confirmConsentRequest(P().consent.id);
    await done;
    assert.equal(host.artifactLog.length, before + 1, "the missing copy is fetched again");
  });

  test("an Update… confirmed after a restart keeps the new copy's full provenance", async () => {
    await promptedUpdate();
    lockfile.resetLockForTests();
    resetCandidatesForTests();
    assert.ok(updater.reviewUpdate("acme__a") || (await lifecycle.rescanPlugins(null), updater.reviewUpdate("acme__a")));
    assert.ok(lifecycle.confirmConsentRequest(P().consent.id));
    for (let i = 0; i < 100 && lockfile.currentLock()["@acme/a"].version !== "2.0.0"; i++) await tick();
    const entry = lockfile.currentLock()["@acme/a"];
    assert.deepEqual([entry.version, entry.sha256, entry.repo, entry.payloadDigest], ["2.0.0", sha(2), "acme/plugins", "d".repeat(64)]);
  });

  test("a lock that can't be written after the switch undoes the switch and fails", async () => {
    await promptedUpdate();
    assert.ok(updater.reviewUpdate("acme__a"));
    const restore = failingWrites(LOCK_DOC);
    try {
      assert.ok(lifecycle.confirmConsentRequest(P().consent.id));
      const promoted = await lifecycle.settledPromotions(["acme__a"]);
      assert.equal(promoted.ok, false);
      assert.match(promoted.reason, /stayed on 1\.0\.0/);
    } finally {
      restore();
    }
    await lifecycle.rescanPlugins(null);
    assert.equal(P().listings.acme__a.manifest.version, "1.0.0", "the files went back to what the lock says");
    assert.equal(lockfile.currentLock()["@acme/a"].version, "1.0.0");
    assert.ok(activeManifest(P(), "acme__a"), "the earlier copy keeps running under its approval");
  });
});

describe("round 2: revocation seq and dependents", () => {
  test("a revocation list that couldn't be saved is saved again at the same seq", async () => {
    await registry.publish([], revocationList(30, []));
    const restore = failingWrites("Plugins/revocations-cache.json");
    try {
      assert.equal((await revocations.refreshRevocations()).ok, false);
    } finally {
      restore();
    }
    client.resetRegistryCacheForTests();
    assert.equal((await revocations.refreshRevocations()).ok, true);
    assert.ok(stub.docs.get("Plugins/revocations-cache.json").includes('"seq":30'));
  });

  test("an update its installed dependent can't take is held back to the newest version that fits", async () => {
    await registry.publish([detail("@acme/app", [version("1.0.0", { dependencies: { "@acme/lib": "^1.0.0" } })]), detail("@acme/lib", [version("1.0.0")])]);
    host.artifacts["@acme/app@1.0.0"] = manifestFor("@acme/app", "1.0.0", { dependencies: { "@acme/lib": "^1.0.0" } });
    host.artifacts["@acme/lib@1.0.0"] = manifestFor("@acme/lib", "1.0.0");
    assert.deepEqual(await confirmWhenAsked(installPlugin({ id: "@acme/app" }, { showSheet: false })), { ok: true });
    await lifecycle.rescanPlugins(null);
    client.resetRegistryCacheForTests();
    const lib = (v, n) => version(v, { artifacts: { universal: { url: `https://github.com/acme/plugins/releases/download/lib${n}/lib.tar.gz`, sha256: sha(n), sizeBytes: 10 } } });
    await registry.publish([detail("@acme/app", [version("1.0.0", { dependencies: { "@acme/lib": "^1.0.0" } })]), detail("@acme/lib", [version("1.0.0"), lib("1.1.0", 6), lib("2.0.0", 7)])]);
    host.artifacts["@acme/lib@1.1.0"] = manifestFor("@acme/lib", "1.1.0");
    host.artifacts["@acme/lib@2.0.0"] = manifestFor("@acme/lib", "2.0.0");
    await updater.checkPlugins(consentToken());
    await lifecycle.rescanPlugins(null);
    assert.equal(P().listings.acme__lib.manifest.version, "1.1.0", "2.0.0 would break @acme/app, which wants ^1.0.0");
    assert.equal(lockfile.currentLock()["@acme/lib"].version, "1.1.0");
  });
});

describe("round 2: per-profile isolation", () => {
  test("a profile plugin's settings secret is kept per profile and refused in a profile it's off in", async () => {
    await scopedPlugin(["work"]);
    const { setPluginSecretRow, pluginSecretRowIsSet, secretRowSpace } = await import("./secretRows.ts");
    assert.equal(secretRowSpace("acme__m", "work"), "acme__m@work");
    assert.equal(secretRowSpace("acme__m", "default"), null);
    const refused = await setPluginSecretRow("acme__m", "token", "s3cret", "default");
    assert.equal(refused.ok, false);
    assert.equal(await pluginSecretRowIsSet("acme__m", "token", "default"), false);
  });

  test("launch and idle replays pass the same profile gate as live events", async () => {
    await scopedPlugin(["work"]);
    const { eventReaches } = await import("./channel.ts");
    assert.equal(eventReaches("acme__m", { windows: [] }), false, "app.launched has no profile, so a plugin limited to some doesn't get it");
    assert.equal(eventReaches("acme__m", { tabId: "t-gone", windowId: "wd" }), false, "tab.idle for another profile's window isn't replayed to it");
    assert.equal(eventReaches("acme__m", { tabId: "t-gone", windowId: "ww" }), true);
  });

  test("a call carries the profile that invoked it, and storage keeps to it after focus moves", async () => {
    await scopedPlugin(["work"]);
    const { callProfile } = await import("./tools.ts");
    const { storageMethod } = await import("./channelData.ts");
    assert.equal(callProfile("acme__m", { kind: "command", command: "go", context: { windowId: "ww" } }), "work");
    useBrowser.setState((b) => ({ ui: { ...b.ui, focusOrder: ["wd", "ww"] } }));
    await storageMethod({ name: "acme__m", run: 1 }, P().listings.acme__m.manifest, "storage.set", { key: "k", value: 1, profile: "work" });
    assert.equal(host.storage["profiles/work/acme__m"], '{"k":1}', "the write lands in the invoking profile, not the focused window's");
    assert.equal(host.storage["profiles/default/acme__m"], undefined);
  });
});

describe("round 3: the lock is durable or nothing changes", () => {
  test("an install whose staged provenance can't be saved fails before the sheet and activates nothing", async () => {
    await registry.publish([detail("@acme/a", [version("1.0.0")])]);
    host.artifacts["@acme/a"] = manifestFor("@acme/a", "1.0.0");
    shell.refusedLandings.add(LOCK_DOC);
    try {
      const result = await installPlugin({ id: "@acme/a" }, { showSheet: false });
      assert.equal(result.ok, false);
      assert.match(result.reason, /couldn't save what it downloaded/);
    } finally {
      shell.refusedLandings.delete(LOCK_DOC);
    }
    assert.equal(P().consent, null);
    assert.deepEqual(host.activations, []);
    assert.equal(lockfile.stagedLockEntry("acme__a", `store-${sha(1)}`), null, "nothing half-staged is left in memory");
  });

  test("a lock write that never lands puts back the earlier lock in memory and on disk, and the switch with it", async () => {
    await promptedUpdate();
    assert.ok(updater.reviewUpdate("acme__a"));
    shell.refusedLandings.add(LOCK_DOC);
    try {
      assert.ok(lifecycle.confirmConsentRequest(P().consent.id));
      const promoted = await lifecycle.settledPromotions(["acme__a"]);
      assert.equal(promoted.ok, false);
    } finally {
      shell.refusedLandings.delete(LOCK_DOC);
    }
    await lifecycle.rescanPlugins(null);
    assert.equal(P().listings.acme__a.manifest.version, "1.0.0");
    assert.equal(lockfile.currentLock()["@acme/a"].version, "1.0.0", "memory holds the earlier lock");
    assert.equal(lockfile.parseLock(stub.docs.get(LOCK_DOC))["@acme/a"].version, "1.0.0", "the file holds it too");
  });

  test("a store that can't be listed fails the install instead of trusting a stale listing", async () => {
    await installed("@acme/a", "1.0.0");
    const before = host.artifactLog.length;
    host.listFails = true;
    try {
      const result = await installPlugin({ id: "@acme/a" }, { showSheet: false });
      assert.equal(result.ok, false);
      assert.match(result.reason, /couldn't read its plugin store/);
    } finally {
      host.listFails = false;
    }
    assert.equal(host.artifactLog.length, before);
  });

  test("an older revocation save finishing late can't mark a newer unsaved seq as saved", async () => {
    const CACHE = "Plugins/revocations-cache.json";
    let release;
    shell.landingGates.set(CACHE, new Promise((resolve) => (release = resolve)));
    await registry.publish([], revocationList(1, []));
    const first = revocations.refreshRevocations();
    for (let i = 0; i < 50 && !stub.docs.get(CACHE); i++) await tick();
    shell.landingGates.delete(CACHE);
    await registry.put("revocations.json", revocationList(2, []));
    client.resetRegistryCacheForTests();
    shell.refusedLandings.add(CACHE);
    assert.equal((await revocations.refreshRevocations()).ok, false, "seq 2 didn't land");
    shell.refusedLandings.delete(CACHE);
    release();
    assert.equal((await first).ok, true);
    let writes = 0;
    const realSet = stub.docs.set.bind(stub.docs);
    stub.docs.set = (key, value) => (key === CACHE && writes++, realSet(key, value));
    try {
      client.resetRegistryCacheForTests();
      assert.equal((await revocations.refreshRevocations()).ok, true);
    } finally {
      stub.docs.set = realSet;
    }
    assert.equal(writes, 1, "seq 2 is written again");
    assert.ok(stub.docs.get(CACHE).includes('"seq":2'));
  });
});

describe("round 3: work-only plugins see only work", () => {
  test("omnibox queries, decide hooks and profile-bound tool calls from another profile are refused before they go out", async () => {
    await scopedPlugin(["work"]);
    const { invokePluginCall, callReaches } = await import("./tools.ts");
    const omnibox = await invokePluginCall("acme__m", { kind: "omnibox", provider: "p", query: "q" }, { kind: "host" }, 1000, { profile: "default" });
    assert.deepEqual([omnibox.ok, omnibox.code], [false, "refused"]);
    const decide = await invokePluginCall("acme__m", { kind: "decide", event: "tab.opening", data: { windowId: "wd" } }, { kind: "host" }, 1000);
    assert.deepEqual([decide.ok, decide.code], [false, "refused"]);
    const tool = await invokePluginCall("acme__m", { kind: "tool", tool: "t", input: {} }, { kind: "command" }, 1000, { profile: "default" });
    assert.deepEqual([tool.ok, tool.code], [false, "refused"], "a tool a command runs keeps the command's profile");
    assert.equal(callReaches("acme__m", { kind: "decide", event: "tab.opening", data: {} }, "work"), true);
    assert.equal(callReaches("acme__m", { kind: "tool", tool: "t", input: {} }, null), true, "a tool called with no profile isn't held to one");
  });

  test("state snapshots for a work-only plugin hold only work windows, tabs and groups", async () => {
    await scopedPlugin(["work"]);
    const { limitedProfiles, profileView } = await import("./profileScope.ts");
    assert.deepEqual(limitedProfiles(P(), "acme__m"), ["work"]);
    const b = useBrowser.getState();
    const s = {
      ...b,
      windowOrder: ["ww", "wd"],
      tabs: { tw: { id: "tw", windowId: "ww", profileId: "work" }, td: { id: "td", windowId: "wd", profileId: "default" } },
      groups: { gw: { id: "gw", windowId: "ww", profileId: "work" }, gd: { id: "gd", windowId: "wd", profileId: "default" } },
      ui: { ...b.ui, focusOrder: ["wd", "ww"] },
    };
    const view = profileView(s, ["work"]);
    assert.deepEqual([Object.keys(view.windows), view.windowOrder, Object.keys(view.tabs), Object.keys(view.groups), view.ui.focusOrder], [["ww"], ["ww"], ["tw"], ["gw"], ["ww"]]);
  });
});

describe("round 4: fault injection", () => {
  const staged = (key, n) => ({ folderId: `store-${sha(n)}`, entry: { id: `@acme/${key.split("__")[1]}`, key, version: "1.0.0", channel: "latest", source: { kind: "registry", url: BASE }, sha256: sha(n), payloadDigest: null, dependencies: [], root: true, official: false, installedAt: 1 } });

  test("a candidate isn't eligible for the sheet until its staged provenance has landed", async () => {
    const { wantCandidate } = await import("./candidates.ts");
    host.folders = [{ name: "acme__held", status: "missing", source: "store", candidates: [{ folderId: `store-${sha(3)}`, text: manifestFor("@acme/held", "1.0.0"), version: "1.0.0" }] }];
    wantCandidate("acme__held", `store-${sha(3)}`);
    await lifecycle.rescanPlugins(null);
    let release;
    shell.landingGates.set(LOCK_DOC, new Promise((resolve) => (release = resolve)));
    const pending = lockfile.stageLockEntries([staged("acme__held", 3)]);
    assert.equal(lifecycle.requestPluginConsent("acme__held"), false, "a write still in flight doesn't make it eligible");
    assert.equal(lockfile.stagedLockEntry("acme__held", `store-${sha(3)}`), null);
    shell.landingGates.delete(LOCK_DOC);
    release();
    assert.equal(await pending, true);
    assert.equal(lifecycle.requestPluginConsent("acme__held"), true);
    lifecycle.dismissPluginConsent();
  });

  test("two overlapping staged writes that never land leave neither behind", async () => {
    shell.refusedLandings.add(LOCK_DOC);
    try {
      const results = await Promise.all([lockfile.stageLockEntries([staged("acme__one", 5)]), lockfile.stageLockEntries([staged("acme__two", 6)])]);
      assert.deepEqual(results, [false, false]);
    } finally {
      shell.refusedLandings.delete(LOCK_DOC);
    }
    assert.equal(lockfile.stagedLockEntry("acme__one", `store-${sha(5)}`), null);
    assert.equal(lockfile.stagedLockEntry("acme__two", `store-${sha(6)}`), null);
    assert.deepEqual(lockfile.parseStaged(stub.docs.get(LOCK_DOC) ?? null), {}, "the file holds neither either");
    assert.equal(await lockfile.stageLockEntries([staged("acme__three", 7)]), true);
    assert.deepEqual(Object.keys(lockfile.parseStaged(stub.docs.get(LOCK_DOC))), ["acme__three"], "a later write starts from what actually landed");
  });

  test("a rollback whose lock write and switch back both fail says what's actually running", async () => {
    await installed("@acme/a", "1.0.0", { permissions: { tabs: "read" } });
    client.resetRegistryCacheForTests();
    await registry.publish([detail("@acme/a", [version("1.0.0"), version("2.0.0")])]);
    host.artifacts["@acme/a@2.0.0"] = manifestFor("@acme/a", "2.0.0", { permissions: { tabs: "read" } });
    await updater.checkPlugins(consentToken());
    host.rollbackResults = [null, { ok: false, reason: "disk full" }];
    shell.refusedLandings.add(LOCK_DOC);
    let result;
    try {
      result = await updater.rollbackPlugin("acme__a");
    } finally {
      shell.refusedLandings.delete(LOCK_DOC);
    }
    assert.equal(result.ok, false);
    assert.equal(P().listings.acme__a.manifest.version, "1.0.0");
    assert.match(result.reason, /went back to 1\.0\.0/, "it doesn't claim to have stayed on 2.0.0");
    assert.ok(activeManifest(P(), "acme__a"), "what's running is the one its approval now names");
  });

  test("an omnibox query keeps the profile of the window it started in, whatever has focus", async () => {
    await scopedPlugin(["work"]);
    host.folders = [{ name: "acme__o", status: "ok", source: "local", text: manifestFor("@acme/o", "1.0.0", { contributes: { omnibox: [{ id: "o", title: "O", global: true }] } }), folderId: `local-${"e".repeat(64)}` }];
    await lifecycle.rescanPlugins(null);
    assert.deepEqual(P().listings.acme__o.problems, []);
    usePlugins.setState({ records: { acme__o: { enabled: true, approved: P().listings.acme__o.hash, values: {}, applied: {}, profiles: ["work"] } } });
    const { useRegisteredProviders } = await import("../omnibox/providers.ts");
    const provider = useRegisteredProviders.getState().list.find((p) => p.id.includes("acme__o"));
    assert.ok(provider, "the plugin's provider is registered");
    useBrowser.setState((b) => ({ ui: { ...b.ui, focusOrder: ["ww", "wd"] } }));
    takePluginCounts();
    const before = host.events.length;
    const asked = new AbortController();
    const answer = provider.query("x", asked.signal, { windowId: "wd" });
    asked.abort();
    assert.deepEqual(await answer, []);
    assert.equal(takePluginCounts().plugin_omnibox_queries ?? 0, 0, "a Default window's query is never put to a work-only plugin, though Work has focus");
    assert.equal(host.events.length, before);
  });

  test("queued snapshot frames built for an earlier profile assignment are dropped at delivery", async () => {
    await scopedPlugin(["work"]);
    const { dropOutOfScope, profileScopeKey } = await import("./stateEvents.ts");
    assert.equal(profileScopeKey("acme__m"), "work");
    const sub = { name: "acme__m", outbox: [{ topic: "tabs", scope: "*" }, { topic: "downloads", scope: "work" }], sent: new Map([["tabs", new Map([["td", "x"]])]]) };
    assert.deepEqual(dropOutOfScope(sub), ["tabs"]);
    assert.deepEqual(sub.outbox.map((f) => f.topic), ["downloads"], "rows queued before it was limited to Work never go out");
    assert.equal(sub.sent.has("tabs"), false, "the next flush sends a fresh snapshot");
  });

  test("a store scan that fails after the download fails the install instead of trusting the earlier listing", async () => {
    await registry.publish([detail("@acme/a", [version("1.0.0")])]);
    host.artifacts["@acme/a"] = manifestFor("@acme/a", "1.0.0");
    host.artifactGate = {
      then(resolve) {
        host.listFails = true;
        resolve();
      },
    };
    try {
      const result = await installPlugin({ id: "@acme/a" }, { showSheet: false });
      assert.equal(result.ok, false);
      assert.match(result.reason, /after the download/);
    } finally {
      host.listFails = false;
      host.artifactGate = null;
    }
    assert.equal(P().consent, null);
    assert.deepEqual(host.activations, []);
    assert.deepEqual(host.folders, [], "the dropped download is also removed from the store");
  });

  test("staging fails when lockfile fsync fails, so the candidate never reaches consent", async () => {
    await registry.publish([detail("@acme/a", [version("1.0.0")])]);
    host.artifacts["@acme/a"] = manifestFor("@acme/a", "1.0.0");
    await revocations.refreshRevocations();
    shell.refusedSyncs.on = true;
    let result;
    try {
      result = await installPlugin({ id: "@acme/a" }, { showSheet: false });
    } finally {
      shell.refusedSyncs.on = false;
    }
    assert.equal(result.ok, false);
    assert.match(result.reason, /plugins-lock\.json/);
    assert.equal(P().consent, null);
    assert.deepEqual(host.folders, []);
  });

  test("a rollback whose lock write, switch forward, and rescan all fail still reports the rolled-back version", async () => {
    await installed("@acme/a", "1.0.0", { permissions: { tabs: "read" } });
    client.resetRegistryCacheForTests();
    await registry.publish([detail("@acme/a", [version("1.0.0"), version("2.0.0")])]);
    host.artifacts["@acme/a@2.0.0"] = manifestFor("@acme/a", "2.0.0", { permissions: { tabs: "read" } });
    await updater.checkPlugins(consentToken());
    host.rollbackResults = [null, { ok: false, reason: "disk full" }];
    shell.refusedLandings.add(LOCK_DOC);
    host.listFails = true;
    let result;
    try {
      result = await updater.rollbackPlugin("acme__a");
    } finally {
      shell.refusedLandings.delete(LOCK_DOC);
      host.listFails = false;
    }
    assert.equal(result.ok, false);
    assert.match(result.reason, /went back to 1\.0\.0/);
  });

  test("a queued channel change behind a plugin removal does not recreate a partial lock entry", async () => {
    await installed("@acme/a", "1.0.0");
    let release;
    shell.landingGates.set(LOCK_DOC, new Promise((r) => (release = r)));
    const removing = lockfile.forgetLockKey("acme__a", null);
    const channeling = setPluginChannel("acme__a", "beta");
    release();
    shell.landingGates.delete(LOCK_DOC);
    await removing;
    assert.equal(await channeling, false);
    assert.equal(lockfile.currentLock()["@acme/a"], undefined);
  });
});
