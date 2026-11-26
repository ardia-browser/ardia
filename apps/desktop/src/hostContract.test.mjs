import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { callHost } from "./host.ts";
import { BOOKMARKS_EXPORT_CALL } from "./hostBookmarksExport.ts";
import { reachesNativeHostUnchecked, resolveHostModule } from "./hostModules.ts";
import { createNativeEvents } from "./hostEvents.ts";
import { hostLaunchConfig } from "./hostLaunchConfig.ts";
import { HostTab } from "./hostTab.ts";
import { linuxAdvertised } from "../scripts/linux-capabilities.mjs";

function fixture() {
  const listeners = new Set();
  const requests = [];
  const host = {
    bootstrap: { windowId: "window", profileId: "default" },
    call: async (name, profile, args) => { requests.push({ name, profile, args }); return "null"; },
    invoke: async (method, args) => { requests.push({ method, args }); return { browserId: 7, chromeTabId: 7 }; },
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { host, requests, listeners };
}

test("domain adapter preserves argument JSON and scalar, string, null and object responses", async () => {
  const { host, requests } = fixture();
  const call = resolveHostModule(host, "ArdiaHistory", "call");
  for (const reply of ['"text"', "7", "false", "null", '{"data":{"error":"valid nested value"}}']) {
    host.call = async (name, profile, args) => { requests.push({ name, profile, args }); return reply; };
    assert.equal(await call("query", "default", '{"maxUrls":5}'), reply);
    assert.deepEqual(requests.at(-1), { name: "history.query", profile: "default", args: '{"maxUrls":5}' });
  }
});

test("every call of a schema-generated domain reaches a host that serves it under its own name, with its arguments untouched, except the ones the Linux UI routes or answers itself", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../../../packages/ardiacore/src/engine/generated/manifest.json", import.meta.url), "utf8"));
  const everyCall = Object.entries(manifest.domains).flatMap(([domain, entry]) => Object.keys(entry.calls).map((verb) => `${domain}.${verb}`));
  const servedWhenTheHostCant = [BOOKMARKS_EXPORT_CALL];
  const routedByTheUi = new Set(["passwords.unlock", "passwords.reveal", "passwords.export", "autofill.cardNumber"]);
  const reshapedByTheUi = new Set(["passwords.list", "autofill.addresses", "autofill.cards"]);
  for (const name of [...servedWhenTheHostCant, ...routedByTheUi, ...reshapedByTheUi]) {
    const [domain, verb] = name.split(".");
    assert.equal(manifest.domains[domain]?.calls[verb]?.desktop, "custom", `${name} is a desktop custom call`);
  }
  for (const [domain, entry] of Object.entries(manifest.domains)) {
    const { host, requests } = fixture();
    host.bootstrap.capabilities = everyCall;
    const call = resolveHostModule(host, `Ardia${domain[0].toUpperCase()}${domain.slice(1)}`, "call");
    for (const verb of Object.keys(entry.calls).filter((verb) => !routedByTheUi.has(`${domain}.${verb}`))) {
      const reshaped = reshapedByTheUi.has(`${domain}.${verb}`);
      host.call = async (name, profile, args) => { requests.push({ name, profile, args }); return reshaped ? "{}" : "null"; };
      const reply = await call(verb, "default", '{"profile":"default"}');
      if (!reshaped) assert.equal(reply, "null", `${domain}.${verb}`);
      assert.deepEqual(requests.at(-1), { name: `${domain}.${verb}`, profile: "default", args: '{"profile":"default"}' });
    }
  }
});

const LEFT_OUT_BY_THE_UI = new Set(["ArdiaSync.takeFileCounts"]);
const moduleManifest = JSON.parse(readFileSync(new URL("../../../packages/ardiacore/src/engine/generated/manifest.json", import.meta.url), "utf8")).modules;

function generatedResults() {
  const results = new Map();
  for (const entry of Object.values(moduleManifest)) {
    const source = readFileSync(new URL(`../../../${entry.types}`, import.meta.url), "utf8");
    for (const [module, row] of Object.entries(entry.modules)) {
      const body = source.split(`export type ${row.native} = {\n`)[1]?.split("\n};\n")[0] ?? "";
      for (const line of body.split("\n")) {
        const signature = /^ {2}(\w+)\??\(.*\): (.+);$/.exec(line);
        if (signature && row.functions[signature[1]]?.async === false) results.set(`${module}.${signature[1]}`, signature[2]);
      }
    }
  }
  return results;
}
const RESULTS = generatedResults();
const mayAnswerWithPromise = (name) => /\bPromise</.test(RESULTS.get(name) ?? "");

async function checkModuleFunction(module, fn, row, { advertised = true } = {}) {
  const name = `${module}.${fn}`;
  const args = row.args.map((_, index) => `arg${index}`);
  const { host, requests } = fixture();
  host.bootstrap.capabilities = advertised ? [...linuxAdvertised] : [];
  const resolved = resolveHostModule(host, module, fn);
  if (LEFT_OUT_BY_THE_UI.has(name)) {
    assert.equal(row.desktop, "absent", `${name} is left out on the desktop`);
    assert.equal(resolved, null, `${name} resolves to nothing, so callers skip it`);
    return;
  }
  assert.equal(typeof resolved, "function", `${name} resolves to a function`);
  const reachesHost = reachesNativeHostUnchecked(resolved);
  const answeredByTheUi = advertised ? row.desktop === "custom" || row.desktop === "adapted" : !reachesHost;
  if (advertised) assert.equal(reachesHost, !answeredByTheUi, answeredByTheUi ? `${name} is answered by the desktop UI${row.desktop === "adapted" ? ", in front of the native host's own dispatch" : ""}` : `${name} goes to the native host, which serves it only when its binding is host`);
  const promised = !answeredByTheUi || row.async;
  let answer;
  try {
    answer = resolved(...args);
  } catch (error) {
    assert.ok(answeredByTheUi && !promised, `${name} throws only as a synchronous answer of the desktop UI: ${error}`);
    return;
  }
  const isPromise = answer instanceof Promise;
  const label = advertised ? "" : " on an engine that advertises nothing";
  if (promised) assert.ok(isPromise, !answeredByTheUi ? `${name} goes to the native host${label}, so the host fallback answers it with a Promise the host settles` : `${name} answers with a Promise${label}, as the schema's async says`);
  if (isPromise && !row.async && (answeredByTheUi || (advertised && row.desktop === "host"))) assert.ok(mayAnswerWithPromise(name), `${name} answers synchronously${label}, as the schema's async says, unless its result type allows a Promise`);
  await Promise.resolve(answer).catch(() => {});
  if (!advertised) return;
  if (row.desktop === "custom") assert.equal(requests.some((request) => request.method === name || request.name === name), false, `${name} never reaches the host under its own name`);
  if (!answeredByTheUi) assert.deepEqual(requests, [{ method: name, args: { args } }], `${name} reaches the host with its positional arguments`);
}

const moduleFunctions = () => Object.values(moduleManifest).flatMap((domain) => Object.entries(domain.modules).flatMap(([module, entry]) => Object.entries(entry.functions).map(([fn, row]) => ({ module, fn, row }))));

test("with the capabilities the Linux engine advertises, every module function is answered by the desktop UI exactly when its binding is custom or adapted, and otherwise reaches the native host with its positional arguments, as a Promise when it is async or left to the host", async () => {
  const functions = moduleFunctions();
  assert.ok(linuxAdvertised.length > 50, "the engine's bootstrap still advertises its capabilities");
  for (const capability of ["ArdiaSync.status", "ArdiaCalendar.status", "ArdiaCalendar.requestAccess", "ArdiaLive.request"]) {
    assert.ok(linuxAdvertised.includes(capability), `bootstrap helper capability ${capability} is parsed into the advertised fixture`);
  }
  assert.ok(functions.some(({ module, fn }) => module === "ArdiaWindowBackdrop" && fn === "holdKeyLook"), "the scan found the shaders pilot");
  for (const name of LEFT_OUT_BY_THE_UI) assert.ok(functions.some(({ module, fn }) => `${module}.${fn}` === name), `${name} is still a schema function`);
  for (const { module, fn, row } of functions) await checkModuleFunction(module, fn, row);
});

test("advertised Calendar capabilities route ArdiaCalendar.requestAccess to the host on Linux instead of falling back locally", async () => {
  const fallback = fixture();
  fallback.host.bootstrap.capabilities = [];
  await resolveHostModule(fallback.host, "ArdiaCalendar", "requestAccess")();
  assert.deepEqual(fallback.requests, []);
  const advertised = fixture();
  advertised.host.bootstrap.capabilities = [...linuxAdvertised];
  await resolveHostModule(advertised.host, "ArdiaCalendar", "requestAccess")();
  assert.equal(
    advertised.requests.some((request) => request.method === "ArdiaCalendar.requestAccess"),
    (process.env.ARDIA_DESKTOP_MODE ?? "linux") === "linux",
  );
});

test("on an engine that advertises nothing, every module function still resolves, and answers with a Promise when it is async or left to the host, synchronously otherwise unless its result type allows a Promise", async () => {
  for (const { module, fn, row } of moduleFunctions()) await checkModuleFunction(module, fn, row, { advertised: false });
});

test("a function the desktop UI stands in for until the engine advertises it reaches the host once it does", () => {
  const { host } = fixture();
  host.bootstrap.capabilities = [];
  assert.equal(reachesNativeHostUnchecked(resolveHostModule(host, "ArdiaAutomation", "start")), false);
  host.bootstrap.capabilities = [...linuxAdvertised];
  assert.equal(reachesNativeHostUnchecked(resolveHostModule(host, "ArdiaAutomation", "start")), true);
  assert.equal(moduleManifest.shell.modules.ArdiaAutomation.functions.start.desktop, "host");
});

test("a module constant the desktop answers resolves without the native host fallback, with the engine's advertised capabilities", () => {
  for (const entry of Object.values(moduleManifest)) {
    for (const [module, row] of Object.entries(entry.modules)) {
      for (const [constant, binding] of Object.entries(row.constants ?? {})) {
        const { host } = fixture();
        host.bootstrap.capabilities = [...linuxAdvertised];
        const resolved = resolveHostModule(host, module, constant);
        assert.equal(reachesNativeHostUnchecked(resolved), !["custom", "adapted"].includes(binding.desktop), `constant ${module}.${constant} is ${binding.desktop} on the desktop`);
      }
    }
  }
});

test("a Mac-only synchronous module function, which the desktop leaves to the host, passes as the host fallback's Promise, and a desktop answer of the wrong shape fails", async () => {
  await checkModuleFunction("ArdiaDemoOnMac", "size", { args: [], async: false, mac: "custom", desktop: "absent", windows: "absent" });
  await checkModuleFunction("ArdiaDemoOnMac", "measure", { args: ["dir"], async: true, mac: "custom", desktop: "absent", windows: "absent" });
  await assert.rejects(checkModuleFunction("ArdiaWindowBackdrop", "holdKeyLook", { args: ["on"], async: false, mac: "custom", desktop: "custom", windows: "absent" }), /answers synchronously/);
  await assert.rejects(checkModuleFunction("ArdiaWindowBackdrop", "holdKeyLook", { args: ["on"], async: true, mac: "custom", desktop: "absent", windows: "absent" }), /goes to the native host/);
  await assert.rejects(checkModuleFunction("ArdiaShell", "copyText", { args: ["text"], async: false, mac: "custom", desktop: "adapted", windows: "custom" }), /is answered by the desktop UI, in front of the native host's own dispatch/);
  await checkModuleFunction("ArdiaDemoOnMac", "size", { args: [], async: false, mac: "custom", desktop: "absent", windows: "absent" });
});

test("engine errors and bad replies reject with stable codes, profiles never retry", async () => {
  const { host } = fixture();
  for (const reply of ["", "undefined", "{bad"]) {
    host.call = async () => reply;
    await assert.rejects(callHost("history.query", "default", "{}", host), { code: "ERR_BAD_REPLY" });
  }
  host.call = async () => '{"error":"service refused"}';
  await assert.rejects(callHost("history.query", "default", "{}", host), { code: "ERR_ENGINE", message: "service refused" });
  let attempts = 0;
  host.call = async (_name, profile) => { attempts++; assert.equal(profile, "private"); throw Object.assign(new Error("Profile unavailable"), { code: "ERR_ENGINE" }); };
  await assert.rejects(callHost("history.query", "private", "{}", host), /Profile unavailable/);
  assert.equal(attempts, 1);
  await assert.rejects(callHost("history.query", null, "{}", host), /Profile must be a string/);
});

test("launch configuration is a complete synchronous copy with Linux test and prewarm safeguards", () => {
  const { host } = fixture();
  host.bootstrap.launchConfig = { dataDirectory: "/scratch/Ardia", configDirectory: "/scratch/config", background: true, isolated: true, testInstance: true, instance: { downloadsDir: "/downloads" }, switches: { newTabPrewarm: true, lazySidebarRows: false }, trace: ["pip"], test: { reauth: "allow" } };
  const config = resolveHostModule(host, "ArdiaApp", "launchConfig")();
  assert.equal(Object.getPrototypeOf(config), Object.prototype);
  assert.equal(config.then, undefined);
  assert.deepEqual(config, { dataDirectory: "/scratch/Ardia", configDirectory: "/scratch/config", background: true, isolated: true, testInstance: false, instance: { downloadsDir: "/downloads" }, switches: { newTabPrewarm: false, lazySidebarRows: false }, trace: [], test: {} });
  config.switches.lazySidebarRows = true;
  assert.equal(hostLaunchConfig(host).switches.lazySidebarRows, false);
  assert.deepEqual(Object.keys(hostLaunchConfig()).sort(), ["background", "configDirectory", "dataDirectory", "instance", "isolated", "switches", "test", "testInstance", "trace"].sort());
});

test("domain events deliver envelopes once and listener removal survives reuse and mutation", () => {
  const events = createNativeEvents();
  const received = [];
  let first;
  first = events.add("ArdiaHistory", "history", (event) => { received.push(event); first.remove(); });
  const payload = { name: "history.changed", data: { profile: "default" } };
  const other = events.add("ArdiaBookmarks", "bookmarks", () => assert.fail("wrong domain"));
  events.emit("ArdiaHistory", "history", payload);
  events.emit("ArdiaHistory", "history", payload);
  assert.deepEqual(received, [payload]);
  const second = events.add("ArdiaHistory", "history", (event) => received.push(event));
  first.remove();
  events.emit("ArdiaHistory", "history", payload);
  assert.equal(received.length, 2);
  second.remove();
  other.remove();
  events.removeAll("ArdiaHistory");
});

test("a throwing event listener leaves the others running, and each subscription of one function removes alone", (t) => {
  const events = createNativeEvents();
  const errors = t.mock.method(console, "error", () => {});
  const received = [];
  const listener = (event) => received.push(event);
  events.add("ArdiaTabs", "unclaimed", () => { throw new Error("broken listener"); });
  const once = events.add("ArdiaTabs", "unclaimed", listener);
  const twice = events.add("ArdiaTabs", "unclaimed", listener);
  assert.doesNotThrow(() => events.emit("ArdiaTabs", "unclaimed", 1));
  assert.deepEqual(received, [1, 1]);
  assert.equal(errors.mock.callCount(), 1);
  once.remove();
  events.emit("ArdiaTabs", "unclaimed", 2);
  assert.deepEqual(received, [1, 1, 2]);
  twice.remove();
  events.emit("ArdiaTabs", "unclaimed", 3);
  assert.deepEqual(received, [1, 1, 2]);
  events.removeAll("ArdiaTabs");
});

test("stable tab keys carry unique claims through reclaim, buffered events and stale cleanup", async () => {
  const { host, requests, listeners } = fixture();
  let finish;
  host.invoke = (method, args) => {
    requests.push({ method, args });
    if (method === "tab.create") return new Promise((resolve) => { finish = resolve; });
    return Promise.resolve(null);
  };
  const events = [];
  const first = new HostTab(host, { key: "app-tab" }, (event) => events.push(event));
  await new Promise(setImmediate);
  for (const listener of listeners) listener("ArdiaWebView", "7", { type: "progress", progress: 0.5 });
  finish({ browserId: 7, chromeTabId: 7 });
  await first.ready;
  assert.deepEqual(events.map((e) => e.type), ["ready", "progress"]);
  const second = new HostTab(host, { key: "app-tab", adoptId: "tab:7" }, () => {});
  await new Promise(setImmediate);
  assert.deepEqual(requests.at(-1).args, { key: "app-tab", adoptId: "tab:7", claim: second.claim, previousClaim: first.claim, profile: "default", url: "about:blank" });
  finish({ browserId: 7, chromeTabId: 7 });
  await second.ready;
  await assert.rejects(first.command("reload"), /released/);
  first.dispose();
  await second.command("reload");
  assert.deepEqual(requests.at(-1).args, { id: 7, claim: second.claim, command: "reload", args: [] });
  second.dispose();
  await new Promise(setImmediate);
  assert.deepEqual(requests.at(-1), { method: "tab.release", args: { id: 7, claim: second.claim } });
  assert.equal(listeners.size, 0);
});

test("late temporary surface creation releases its private native lifetime without firing ready", async () => {
  const { host, requests } = fixture();
  let finish;
  host.invoke = (method, args) => { requests.push({ method, args }); return method === "tab.create" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(null); };
  const surface = new HostTab(host, { key: "surface", temporary: true }, () => assert.fail("disposed surface event"));
  await new Promise(setImmediate);
  surface.dispose();
  finish({ browserId: 8, chromeTabId: 8 });
  await surface.ready;
  await new Promise(setImmediate);
  assert.equal(requests[0].args.temporary, true);
  assert.deepEqual(requests.at(-1), { method: "tab.release", args: { id: 8, claim: surface.claim } });
});

test("current shared domain wrappers use the production Linux Expo adapter", () => {
  const loader = fileURLToPath(new URL("../scripts/host-contract-loader.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("../scripts/host-contract-production.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--import", loader, fixture], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /production domain wrappers, bootstrap adapter, errors and events passed/);
});

test("a Mac host answers ArdiaSharedFolders.location from its bootstrap and sends the folder calls to the host with their arguments", async () => {
  const requests = [];
  const location = { path: "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Ardia Shared", iCloudAvailable: true, iCloudPath: "/Users/me/Library/Mobile Documents/com~apple~CloudDocs" };
  const mac = {
    bootstrap: { capabilities: ["ArdiaSharedFolders.location", "ArdiaSharedFolders.read", "ArdiaSharedFolders.watch"], nativeModules: { ArdiaSharedFolders: { location } } },
    invoke: async (method, args) => (requests.push({ method, args }), { exists: false }),
  };
  assert.deepEqual(resolveHostModule(mac, "ArdiaSharedFolders", "location")(), location);
  const bare = { ...mac, bootstrap: { ...mac.bootstrap, nativeModules: {} } };
  assert.deepEqual(resolveHostModule(bare, "ArdiaSharedFolders", "location")(), { path: "", iCloudAvailable: false, iCloudPath: "" });
  assert.deepEqual(await resolveHostModule(mac, "ArdiaSharedFolders", "read")("/Shared/Team", { device: 1, inode: 2 }), { exists: false });
  resolveHostModule(mac, "ArdiaSharedFolders", "watch")(["/Shared/Team"]);
  await Promise.resolve();
  assert.deepEqual(requests, [
    { method: "ArdiaSharedFolders.read", args: { args: ["/Shared/Team", { device: 1, inode: 2 }] } },
    { method: "ArdiaSharedFolders.watch", args: { args: [["/Shared/Team"]] } },
  ]);
});
