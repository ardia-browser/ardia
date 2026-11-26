import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { detail, fakeRegistry, keyPair, officialSig, sha, version } from "./fixtures/registry.mjs";
import { v3Text } from "./fixtures/manifests.mjs";
const stub = await import("../../test-native/index.ts");
const shell = await import("../../test-native/shell.ts");
const { reloadLaunchConfigForTests } = await import("../../platform/launchConfig.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { startPlugins } = await import("./start.ts");
const keysModule = await import("./registryKeys.ts");
const client = await import("./registryClient.ts");
const revocations = await import("./revocations.ts");
const lockfile = await import("./lockfile.ts");
const { planInstall } = await import("./installPlan.ts");
const { installPlugin } = await import("./installer.ts");
const updater = await import("./updater.ts");
const { migrateLegacyPlugins } = await import("./migration.ts");
const { devReload, devLinkPath } = await import("./devReload.ts");
const { parseGithubSpec } = await import("./githubSource.ts");
const savedState = await import("./savedState.ts");
const { resetCandidatesForTests } = await import("./candidates.ts");
const { pluginSocketMethod } = await import("./socketMethods.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
const { filterCatalog, refreshCatalog, useCatalog, addRegistry } = await import("./marketplace.ts");
setConsentPeriod(true, "plugins-registry-test");

const BASE = "https://registry.test/r";
const registryKeys = keyPair();
const nativeKeys = keyPair();
const host = stub.pluginHost;
const P = () => usePlugins.getState();

function configure() {
  shell.launch.pluginRegistryURL = BASE;
  shell.launch.pluginRegistryKeys = `test=${registryKeys.publicPem}`;
  shell.launch.pluginNativeKeys = `native=${nativeKeys.publicPem}`;
  reloadLaunchConfigForTests();
}

const manifestFor = (id, v, extra = {}) => {
  const [scope, name] = id.slice(1).split("/");
  return v3Text({ name, title: name, version: v, main: "index.js", ...extra }, scope);
};

let registry;

beforeEach(async () => {
  configure();
  useBrowser.getState().hydrate({});
  startPlugins();
  host.folders = [];
  host.artifacts = {};
  host.artifactResults = {};
  host.artifactLog = [];
  host.activations = [];
  for (const doc of ["Plugins/plugins-lock.json", "Plugins/plugins-state.json", "Plugins/revocations-cache.json", "Plugins/registry-cache.json", "plugins.json"]) stub.docs.delete(doc);
  lockfile.resetLockForTests();
  revocations.resetRevocationsForTests();
  client.resetRegistryCacheForTests();
  savedState.resetPluginsExtrasForTests();
  resetCandidatesForTests();
  usePlugins.setState({ records: {}, listings: {}, order: [], candidates: {}, consent: null, fetches: {} });
  registry = fakeRegistry(BASE, registryKeys);
  client.setRegistryFetcherForTests(registry.fetcher);
  takePluginCounts();
});

describe("registry keys and addresses", () => {
  test("keys parse as kid=key lists, PEMs and bare keys alike; registries are https or a loopback under test", () => {
    assert.deepEqual(Object.keys(keysModule.parseKeyList(`a=${"x".repeat(44)},b=${"y".repeat(44)}`)), ["a", "b"]);
    assert.deepEqual(Object.keys(keysModule.parseKeyList("MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=")), ["test"]);
    assert.equal(keysModule.parseKeyList("").test, undefined);
    assert.equal(keysModule.registryUrl("https://plugins.acme.com/r/index.json"), "https://plugins.acme.com/r");
    assert.equal(keysModule.registryUrl("http://plugins.acme.com/r"), null);
    assert.equal(keysModule.registryUrl("http://127.0.0.1:8080/r", true), "http://127.0.0.1:8080/r");
    assert.equal(keysModule.registryUrl("https://user@acme.com/r"), null);
    assert.equal(keysModule.defaultRegistryUrl(), BASE);
  });

  test("with no key for a registry, nothing from it is trusted", async () => {
    shell.launch.pluginRegistryKeys = null;
    reloadLaunchConfigForTests();
    await registry.publish([detail("@acme/a", [version("1.0.0")])]);
    const got = await client.fetchIndex(client.defaultRegistry());
    assert.equal(got.ok, false);
    assert.equal(got.code, "keys");
  });
});

describe("signed fetches", () => {
  test("an envelope verifies against the registry key, then its body; a forged one is refused", async () => {
    await registry.publish([detail("@acme/a", [version("1.0.0")])]);
    const index = await client.fetchIndex(client.defaultRegistry());
    assert.equal(index.ok, true);
    assert.equal(index.value.plugins[0].id, "@acme/a");
    await registry.put("index.json", { seq: 2, generatedAt: "2026-11-25T10:00:00Z", plugins: [] }, keyPair());
    client.resetRegistryCacheForTests();
    const forged = await client.fetchIndex(client.defaultRegistry());
    assert.equal(forged.ok, false);
    assert.equal(forged.code, "verify");
  });

  test("an unchanged file comes back 304 and is read from the ETag cache, verified again", async () => {
    await registry.publish([detail("@acme/a", [version("1.0.0")])]);
    const first = await client.fetchDetail(client.defaultRegistry(), "@acme/a");
    assert.equal(first.fresh, true);
    const second = await client.fetchDetail(client.defaultRegistry(), "@acme/a");
    assert.equal(second.ok, true);
    assert.equal(second.fresh, false, "a 304 answer reuses the cached envelope");
    assert.ok(stub.docs.get("Plugins/registry-cache.json"), "the cache is kept on disk");
  });

  test("offline with nothing cached says so; offline with a cached copy keeps working", async () => {
    await registry.publish([detail("@acme/a", [version("1.0.0")])]);
    registry.setOffline(true);
    const nothing = await client.fetchIndex(client.defaultRegistry());
    assert.equal(nothing.code, "offline");
    registry.setOffline(false);
    await client.fetchIndex(client.defaultRegistry());
    registry.setOffline(true);
    assert.equal((await client.fetchIndex(client.defaultRegistry())).ok, true);
  });
});

describe("revocations", () => {
  test("a lower seq than one already seen is refused, so an old list can't be replayed", async () => {
    await registry.publish([], { seq: 5, issuedAt: "2026-11-25T10:00:00Z", entries: [] });
    assert.deepEqual(await revocations.refreshRevocations(), { ok: true, changed: true });
    assert.equal(revocations.revocationSeq(), 5);
    assert.ok(stub.docs.get("Plugins/revocations-cache.json").includes('"seq":5'));
    await registry.put("revocations.json", { seq: 3, issuedAt: "2026-11-25T10:00:00Z", entries: [] });
    client.resetRegistryCacheForTests();
    const replay = await revocations.refreshRevocations();
    assert.equal(replay.ok, false);
    assert.equal(revocations.revocationSeq(), 5);
  });
});

describe("install plans", () => {
  test("dependencies come from their registry and resolve to the newest compatible versions", async () => {
    await registry.publish([detail("@acme/app", [version("1.0.0", { dependencies: { "@acme/lib": "^2.0.0" } })]), detail("@acme/lib", [version("1.0.0"), version("2.1.0"), version("3.0.0")])]);
    const plan = await planInstall({ id: "@acme/app" });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.plan.plugins.map((p) => `${p.id}@${p.version}`), ["@acme/lib@2.1.0", "@acme/app@1.0.0"]);
    assert.deepEqual(plan.plan.plugins.map((p) => p.key), ["acme__lib", "acme__app"]);
  });

  test("an @ardia native artifact needs Ardia's official signature over its exact bytes", async () => {
    const claim = { id: "@ardia/cli", version: "1.0.0", platform: "universal", sha256: sha(1) };
    const signed = await officialSig(claim, nativeKeys);
    const official = (sig) => detail("@ardia/cli", [version("1.0.0", { artifacts: { universal: { url: "https://github.com/ardia-browser/plugins/releases/download/cli-v1/cli.tar.gz", sha256: sha(1), sizeBytes: 10, ...(sig ? { officialSig: sig } : {}) } } })], { tier: "native" });
    await registry.publish([official(null)]);
    const unsigned = await planInstall({ id: "@ardia/cli" });
    assert.equal(unsigned.ok, false);
    assert.equal(unsigned.code, "official");
    client.resetRegistryCacheForTests();
    await registry.publish([official(await officialSig({ ...claim, sha256: sha(2) }, nativeKeys))]);
    assert.equal((await planInstall({ id: "@ardia/cli" })).ok, false, "a signature over other bytes doesn't count");
    client.resetRegistryCacheForTests();
    await registry.publish([official(signed)]);
    const good = await planInstall({ id: "@ardia/cli" });
    assert.equal(good.ok, true);
    assert.equal(good.plan.plugins[0].official, true);
  });

  test("a revoked version is skipped, and a block on the owner refuses the install", async () => {
    await registry.publish([detail("@acme/a", [version("1.0.0"), version("1.1.0")])], { seq: 2, issuedAt: "2026-11-25T10:00:00Z", entries: [{ entryId: "x", seq: 2, match: { id: "@acme/a", versions: ["1.1.0"] }, action: "yank", reason: "broken", issuedAt: "2026-11-25T10:00:00Z" }] });
    await revocations.refreshRevocations();
    const plan = await planInstall({ id: "@acme/a" });
    assert.equal(plan.plan.plugins[0].version, "1.0.0");
    client.resetRegistryCacheForTests();
    await registry.publish([detail("@acme/a", [version("1.0.0")])], { seq: 3, issuedAt: "2026-11-25T10:00:00Z", entries: [{ entryId: "y", seq: 3, match: { githubOwner: "acme" }, action: "block", reason: "malicious", issuedAt: "2026-11-25T10:00:00Z" }] });
    await revocations.refreshRevocations();
    assert.equal((await planInstall({ id: "@acme/a" })).ok, false);
  });
});

describe("installing", () => {
  test("Get downloads the plugin and its new dependency, asks once for both, and writes the lock on confirm", async () => {
    await registry.publish([detail("@acme/app", [version("1.0.0", { dependencies: { "@acme/lib": "^1.0.0" } })]), detail("@acme/lib", [version("1.0.0")])]);
    host.artifacts["@acme/app"] = manifestFor("@acme/app", "1.0.0", { dependencies: { "@acme/lib": "^1.0.0" } });
    host.artifacts["@acme/lib"] = manifestFor("@acme/lib", "1.0.0");
    const done = installPlugin({ id: "@acme/app" }, { showSheet: false });
    for (let i = 0; i < 50 && !P().consent; i++) await new Promise((r) => setTimeout(r, 5));
    const asked = P().consent;
    assert.equal(asked.name, "acme__app");
    assert.deepEqual(asked.bundle.map((b) => b.name), ["acme__lib"], "the new dependency is approved on the same sheet");
    assert.ok(lifecycle.confirmConsentRequest(asked.id));
    assert.deepEqual(await done, { ok: true });
    const lock = lockfile.currentLock();
    assert.deepEqual(Object.keys(lock).sort(), ["@acme/app", "@acme/lib"]);
    assert.equal(lock["@acme/app"].root, true);
    assert.equal(lock["@acme/lib"].root, false);
    assert.deepEqual(lock["@acme/app"].dependencies, ["@acme/lib"]);
    assert.ok(stub.docs.get("Plugins/plugins-lock.json"));
    assert.deepEqual(host.activations.map((a) => a.name).sort(), ["acme__app", "acme__lib"]);
    await lifecycle.rescanPlugins(null);
    assert.ok(P().records.acme__app.enabled && P().records.acme__lib.enabled);
    const counts = takePluginCounts();
    assert.equal(counts.registry_installs, 1);
    assert.equal(counts.registry_downloads, 2);
  });

  test("an unreachable registry fails the install with the offline wording", async () => {
    registry.setOffline(true);
    const result = await installPlugin({ id: "@acme/app" }, { showSheet: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /Couldn't reach the plugin registry/);
  });
});

async function installed(id, v, extra = {}) {
  await registry.publish([detail(id, [version(v)])]);
  host.artifacts[`${id}@${v}`] = manifestFor(id, v, extra);
  const done = installPlugin({ id }, { showSheet: false });
  for (let i = 0; i < 100 && !P().consent; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(lifecycle.confirmConsentRequest(P().consent.id));
  assert.deepEqual(await done, { ok: true });
  await lifecycle.rescanPlugins(null);
}

describe("updates", () => {
  test("a newer version asking for nothing more switches over silently and keeps the earlier one for rollback", async () => {
    await installed("@acme/a", "1.0.0", { permissions: { tabs: "read" } });
    client.resetRegistryCacheForTests();
    await registry.publish([detail("@acme/a", [version("1.0.0"), version("2.0.0")])]);
    host.artifacts["@acme/a@2.0.0"] = manifestFor("@acme/a", "2.0.0", { permissions: { tabs: "read" } });
    await updater.checkPlugins(consentToken());
    assert.equal(P().listings.acme__a.manifest.version, "2.0.0");
    assert.equal(P().records.acme__a.updated.to, "2.0.0");
    assert.equal(lockfile.currentLock()["@acme/a"].version, "2.0.0");
    assert.equal(takePluginCounts().updates_silent, 1);
    const back = await updater.rollbackPlugin("acme__a");
    assert.equal(back.ok, true);
    assert.equal(P().listings.acme__a.manifest.version, "1.0.0");
    assert.equal(P().records.acme__a.updated.rolledBack, true);
  });

  test("a newer version asking for more waits for Update… with the exact additions", async () => {
    await installed("@acme/a", "1.0.0", { permissions: { tabs: "read" } });
    client.resetRegistryCacheForTests();
    await registry.publish([detail("@acme/a", [version("1.0.0"), version("2.0.0")])]);
    host.artifacts["@acme/a@2.0.0"] = manifestFor("@acme/a", "2.0.0", { permissions: { tabs: "write" } });
    await updater.checkPlugins(consentToken());
    assert.equal(P().listings.acme__a.manifest.version, "1.0.0", "the current version keeps running");
    const pending = P().records.acme__a.pendingUpdate;
    assert.equal(pending.version, "2.0.0");
    assert.deepEqual(pending.added, ["tabs:write"]);
    assert.ok(updater.reviewUpdate("acme__a"));
    assert.deepEqual(P().consent.added, ["tabs:write"]);
    assert.ok(lifecycle.confirmConsentRequest(P().consent.id));
    for (let i = 0; i < 100 && P().listings.acme__a?.manifest?.version !== "2.0.0"; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(P().listings.acme__a.manifest.version, "2.0.0");
    assert.equal(P().records.acme__a.pendingUpdate, undefined);
  });

  test("a disable revocation turns a plugin off with its reason, and lifting it turns it back on", async () => {
    await installed("@acme/a", "1.0.0");
    client.resetRegistryCacheForTests();
    await registry.publish([detail("@acme/a", [version("1.0.0")])], { seq: 7, issuedAt: "2026-11-25T10:00:00Z", entries: [{ entryId: "d", seq: 7, match: { id: "@acme/a" }, action: "disable", reason: "Broken release", issuedAt: "2026-11-25T10:00:00Z" }] });
    await updater.checkPlugins(consentToken());
    assert.equal(P().records.acme__a.revoked.reason, "Broken release");
    assert.equal(lifecycle.reconcilePlugins.length >= 0, true);
    const { activeManifest } = await import("./store.ts");
    assert.equal(activeManifest(P(), "acme__a"), null, "a disabled plugin withdraws");
    client.resetRegistryCacheForTests();
    await registry.publish([detail("@acme/a", [version("1.0.0")])], { seq: 8, issuedAt: "2026-11-25T10:00:00Z", entries: [] });
    await updater.checkPlugins(consentToken());
    assert.equal(P().records.acme__a.revoked, undefined);
    assert.ok(activeManifest(P(), "acme__a"));
  });
});

describe("migration", () => {
  test("an existing cli install is adopted as @ardia/cli, pending its first registry copy, once", async () => {
    usePlugins.setState({ records: { cli: { enabled: true, approved: "a".repeat(64), values: { x: true }, applied: {} } } });
    host.adoptResult = { ok: true, found: true, moved: ["programs", "data", "download"] };
    assert.deepEqual(await migrateLegacyPlugins(null), ["@ardia/cli"]);
    assert.deepEqual(host.adoptions.at(-1), { from: "cli", to: "ardia__cli" });
    assert.equal(P().records.cli, undefined);
    assert.equal(P().records.ardia__cli.preapproved, true);
    assert.deepEqual(P().records.ardia__cli.values, { x: true });
    assert.equal(lockfile.currentLock()["@ardia/cli"].pending, "migration");
    assert.ok(savedState.pluginsExtras().migrated.includes("cli"));
    assert.deepEqual(await migrateLegacyPlugins(null), [], "it runs once");
    const { programsKeptAtLaunch } = await import("./programs.ts");
    assert.ok(programsKeptAtLaunch(P()).includes("ardia__cli"), "its command stays on PATH while the registry copy is pending");
  });
});

describe("dev links", () => {
  const devFolder = (text) => ({ name: "acme__dev", status: "ok", source: "dev", text, folderId: "dev-abc", devPath: "/work/dev" });
  const params = { id: "@acme/dev", path: "/work/dev", link: devLinkPath("@acme/dev", "/config") };

  test("a reload that asks for nothing new approves itself and restarts the plugin; one that asks for more needs consent", async () => {
    host.folders = [devFolder(manifestFor("@acme/dev", "1.0.0"))];
    await lifecycle.rescanPlugins(null);
    assert.equal((await devReload(params)).error.code, "needs_consent", "the first link asks");
    assert.ok(lifecycle.confirmConsentRequest(P().consent.id));
    host.folders = [devFolder(manifestFor("@acme/dev", "1.0.1"))];
    const quiet = await devReload(params);
    assert.deepEqual(quiet, { ok: true, id: "@acme/dev", version: "1.0.1" });
    host.folders = [devFolder(manifestFor("@acme/dev", "1.0.2", { permissions: { tabs: "read" } }))];
    const louder = await devReload(params);
    assert.equal(louder.ok, false);
    assert.equal(louder.error.code, "needs_consent");
    lifecycle.dismissPluginConsent();
  });

  test("a reload names the link the CLI writes and a plugin Ardia sees", async () => {
    assert.equal((await devReload({ ...params, link: "/elsewhere.json" })).error.code, "bad_request");
    assert.equal((await devReload({ id: "nope" })).error.code, "bad_request");
    assert.equal((await devReload(params)).error.code, "not_linked");
    const viaSocket = await pluginSocketMethod("plugins.devReload", params);
    assert.equal(viaSocket.result.ok, false);
  });
});

describe("marketplace", () => {
  test("the catalog loads from the registry, filters by words and category, and says when the registry is offline", async () => {
    await registry.publish([detail("@acme/alpha", [version("1.0.0")]), detail("@acme/beta", [version("1.0.0")])]);
    await refreshCatalog(true);
    assert.equal(useCatalog.getState().state, "ready");
    assert.deepEqual(filterCatalog(useCatalog.getState().entries, "alpha", "all").map((e) => e.id), ["@acme/alpha"]);
    assert.equal(filterCatalog(useCatalog.getState().entries, "", "nothing").length, 0);
    client.resetRegistryCacheForTests();
    stub.docs.delete("Plugins/registry-cache.json");
    registry.setOffline(true);
    await refreshCatalog(true);
    assert.equal(useCatalog.getState().state, "offline");
  });

  test("a custom registry needs https, a key, and never serves @ardia", () => {
    assert.equal(addRegistry("http://x.test/r", "", "k").ok, false);
    assert.equal(addRegistry("https://x.test/r", "@ardia", `k=${registryKeys.publicPem}`).ok, false);
    assert.equal(addRegistry("https://x.test/r", "@acme/*", "").ok, false);
    assert.deepEqual(addRegistry("https://x.test/r", "@acme/*", `k=${registryKeys.publicPem}`), { ok: true });
    assert.equal(savedState.pluginsExtras().registries[0].scopes[0], "@acme");
    assert.equal(client.registryForId("@acme/jira").url, "https://x.test/r");
    assert.equal(client.registryForId("@other/x").url, BASE);
  });

  test("github: installs name a repository", () => {
    assert.equal(parseGithubSpec("github:alice/pr-reviewer"), "alice/pr-reviewer");
    assert.equal(parseGithubSpec("https://github.com/alice/pr-reviewer.git"), "alice/pr-reviewer");
    assert.equal(parseGithubSpec("github:../etc"), null);
  });
});

describe("profiles and install links", () => {
  test("a profile-scoped plugin shows only in the profiles it's on; a global one shows everywhere", async () => {
    const { shownManifest, enabledInProfile } = await import("./store.ts");
    const { readManifest } = await import("../../lib/pluginManifest.ts");
    const scoped = readManifest(manifestFor("@acme/scoped", "1.0.0"), "acme__scoped").manifest;
    const global = readManifest(v3Text({ name: "g", title: "G", main: "index.js", permissions: { control: true } }, "acme"), "acme__g").manifest;
    const s = {
      listings: { acme__scoped: { name: "acme__scoped", manifest: scoped, problems: [], hash: "h", folderId: "x" }, acme__g: { name: "acme__g", manifest: global, problems: [], hash: "g", folderId: "y" } },
      records: { acme__scoped: { enabled: true, approved: "h", values: {}, applied: {}, profiles: ["work"] }, acme__g: { enabled: true, approved: "g", values: {}, applied: {}, profiles: ["work"] } },
    };
    assert.ok(shownManifest(s, "acme__scoped", "work"));
    assert.equal(shownManifest(s, "acme__scoped", "personal"), null);
    assert.ok(shownManifest(s, "acme__g", "personal"), "programs and control make a plugin global");
    assert.ok(enabledInProfile({ profiles: "all" }, "any") && enabledInProfile(undefined, "any"));
  });

  test("ardia://plugin/install links open the plugin's Get and never reach a tab", async () => {
    const { takePluginInstallLinks } = await import("./installLinks.ts");
    const { pluginInstallLink } = await import("../../lib/pluginIds.ts");
    assert.equal(pluginInstallLink("ardia://plugin/install/@acme/jira"), "@acme/jira");
    assert.equal(pluginInstallLink("ardia://plugin/install/%40acme%2Fjira"), null, "the id is a path of its own, not an encoded one");
    assert.equal(pluginInstallLink("ardia://plugin/install/acme/jira"), null);
    takePluginCounts();
    assert.deepEqual(takePluginInstallLinks(["ardia://plugin/install/@acme/jira", "https://a.example/"]), ["https://a.example/"]);
    assert.equal(takePluginCounts().deep_link_installs, 1);
  });
});
