#!/usr/bin/env node
// Apple Passwords end to end, in hidden instances pointed at the fake helper (fake-helper.mjs; never Apple's).
//
//   node packages/ardiacore/scripts/apple-passwords/e2e.mjs <Debug Ardia.app> <scratch dir> [check…] [--release <Release Ardia.app>] [--keep]
//
//   E1  Pairing with the fixture code reads Connected and saves the profile's choice
//   E2  a helper killed at launch makes Pairing say "Apple Passwords isn't available"
//   E3  with no helper manifest, Pairing says how to get the helper back
//   E4  a Release build ignores the fake-helper override: the fake never starts (needs --release)
//   E5… the Login list in a WebKit tab (login-list.mjs), in one paired instance shared by those checks; E15 ends the
//       fake's Pairing and pairs again from the Login list, leaving that instance paired
//   E32 with a stand-in for the iCloud Passwords extension (its id, from icloud-extension.mjs), picking Apple Passwords
//       turns it off and says so, "Turn it back on" turns it on, and switching to Ardia turns it on only if Ardia turned
//       it off; it is never uninstalled
//
// Each check launches its own instance (scripts/lib/instance.mjs) with ARDIA_TEST applePasswordsManifest at the fake's
// manifest and the fixture sites (sites.mjs: https example.localhost, accounts.example.localhost, other.localhost and
// empty.localhost, http plain.localhost, all on loopback with their ports), drives the same Settings state the Password manager menu and Pairing sheet use (ac.applePasswords), and
// prints one PASS or FAIL line; details go to <scratch dir>/e2e.log. METRO_PORT picks the Metro serving this tree.
// Exit code 1 if any check failed.
import fs from "node:fs";
import path from "node:path";
import { launch, reporter, sleep } from "../../../../scripts/lib/instance.mjs";
import { fakeHelper } from "./fake.mjs";
import { ICLOUD_PASSWORDS_EXTENSION_ID, iCloudExtensionStandIn } from "./icloud-extension.mjs";
import { loginListChecks } from "./login-list.mjs";
import { fixtureSites } from "./sites.mjs";
import { webkitTabs } from "./webkit.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? null : args.splice(at, 2)[1];
};
const releaseApp = flag("--release");
const keep = args.includes("--keep");
const [appArg, scratchArg, ...wanted] = args.filter((a) => !a.startsWith("--"));
if (args.includes("--help") || args.includes("-h") || !appArg || !scratchArg) {
  const lines = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1);
  console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 64);
}
const appPath = (p) => {
  const resolved = path.resolve(p);
  if (resolved.startsWith("/Applications/")) throw new Error("never run against an installed app");
  if (!fs.existsSync(path.join(resolved, "Contents/MacOS"))) throw new Error(`not an app bundle: ${resolved}`);
  return resolved;
};
const APP = appPath(appArg);
const SCRATCH = path.resolve(scratchArg);
fs.mkdirSync(SCRATCH, { recursive: true });
const report = reporter(path.join(SCRATCH, "e2e.log"), { name: "apple passwords e2e" });
const note = report.log;

const sites = await fixtureSites(path.join(SCRATCH, "tls"));
const READY = { timeout: 90_000, test: "return ac.store.getState().windowOrder.length > 0" };
let app = null;
let shared = null;

async function start(name, { manifest, binary = APP, files = {} }) {
  const data = path.join(SCRATCH, name, "data");
  app = await launch(binary, { data, fresh: true, onboarded: true, test: { applePasswordsManifest: manifest }, switches: sites.switches, files, ready: READY });
  note("launched", name, "pid", app.pid, "log", app.log);
  return app;
}

async function stop() {
  if (!app || app === shared?.app) return;
  if (!keep) note("quit:", (await app.quit()).how);
  app = null;
}

async function paired() {
  if (shared && !shared.app.exited) {
    app = shared.app;
    return shared;
  }
  const fake = fakeHelper(path.join(SCRATCH, "paired", "fake"));
  await start("paired", { manifest: fake.manifest });
  const shown = await pickApplePasswords();
  assert(shown.step === "code", "the code step opens", shown);
  await app.eval(`return ac.applePasswords.submitApplePasswordsCode(${JSON.stringify(fake.fixtures.code)}).then(() => true);`, { timeout: 60_000 });
  const done = await until(pairingView, (v) => v.state === "connected" && v.choice === "apple");
  note("paired", JSON.stringify(done));
  shared = { app, fake, tabs: webkitTabs(app, { log: note }) };
  return shared;
}

async function until(body, test, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await app.eval(body, { timeout: 20_000 }).catch((e) => ({ error: String(e) }));
    if (test(last)) return last;
    if (app.exited) break;
    await sleep(250);
  }
  throw new Error(`timed out: ${JSON.stringify(last)?.slice(0, 400)}`);
}

const pairingView = `
  const s = ac.applePasswords.useApplePasswords.getState();
  const profileId = ac.store.getState().settings.defaultProfileId;
  return { state: s.state, step: s.pairing?.step ?? null, error: s.pairing?.error ?? null, choice: ac.store.getState().profiles[profileId].passwordManager ?? null };`;

async function pickApplePasswords() {
  await app.eval(`return ac.applePasswords.loadApplePasswords().then(() => { void ac.applePasswords.startApplePasswordsPairing(ac.store.getState().settings.defaultProfileId); return true; });`);
  return until(pairingView, (v) => v.step && v.step !== "starting", 40_000);
}

const assert = (ok, message, detail) => {
  if (!ok) throw new Error(`${message}: ${JSON.stringify(detail)}`);
};

const extensionView = `
  const s = ac.store.getState();
  const profileId = s.settings.defaultProfileId;
  return ac.engine.call("extensions.list", { profile: "" }).then(({ extensions }) => {
    const ext = extensions.find((e) => e.id === ${JSON.stringify(ICLOUD_PASSWORDS_EXTENSION_ID)});
    const note = ac.iCloudPasswordsExtension?.iCloudExtensionNote(profileId) ?? null;
    return { installed: !!ext, enabled: ext?.enabled ?? null, note, choice: s.profiles[profileId].passwordManager ?? null };
  });`;

const choose = (manager) =>
  app.eval(`ac.passwordManager.choosePasswordManager(ac.store.getState().settings.defaultProfileId, ${JSON.stringify(manager)}); return true;`);

const setExtension = (enabled) =>
  app.eval(`return ac.engine.call("extensions.setEnabled", { profile: "", id: ${JSON.stringify(ICLOUD_PASSWORDS_EXTENSION_ID)}, enabled: ${enabled} }).then(() => true);`);

const CHECKS = {
  async E1() {
    const fake = fakeHelper(path.join(SCRATCH, "E1", "fake"));
    await start("E1", { manifest: fake.manifest });
    const shown = await pickApplePasswords();
    assert(shown.step === "code" && shown.choice !== "apple", "the code step opens before anything is saved", shown);
    await app.eval(`return ac.applePasswords.submitApplePasswordsCode(${JSON.stringify(fake.fixtures.code)}).then(() => true);`, { timeout: 60_000 });
    const done = await until(pairingView, (v) => v.state === "connected");
    assert(done.choice === "apple" && done.step === null, "paired and saved", done);
    assert(fake.launches() === 1, "one helper launch", fake.launches());
    return { state: done.state, choice: done.choice };
  },
  async E2() {
    const fake = fakeHelper(path.join(SCRATCH, "E2", "fake"), { mode: { killedAtLaunch: true } });
    await start("E2", { manifest: fake.manifest });
    const failed = await pickApplePasswords();
    assert(failed.step === "failed" && failed.error === "Apple Passwords isn't available on this Mac.", "the sheet says Apple Passwords isn't available", failed);
    const after = await until(pairingView, (v) => v.state === "refused");
    assert(after.choice !== "apple", "the choice is unchanged", after);
    await app.eval(`return ac.applePasswords.startApplePasswordsPairing(null).then(() => true);`, { timeout: 30_000 });
    assert(fake.launches() === 1, "a helper macOS killed is never started again this run", fake.launches());
    return { state: after.state, launches: fake.launches() };
  },
  async E3() {
    const missing = path.join(SCRATCH, "E3", "no-such-manifest.json");
    fs.rmSync(missing, { force: true });
    await start("E3", { manifest: missing });
    const shown = await pickApplePasswords();
    assert(shown.step === "failed" && /Software Update/.test(shown.error ?? ""), "the sheet says how to get the helper back", shown);
    assert(shown.state === "helperMissing" && shown.choice !== "apple", "nothing is saved", shown);
    return { state: shown.state };
  },
  async E4() {
    if (!releaseApp) throw new Error("E4 needs --release <Release Ardia.app>");
    const fake = fakeHelper(path.join(SCRATCH, "E4", "fake"));
    await start("E4", { manifest: fake.manifest, binary: appPath(releaseApp), files: { "perf-probe": "" } });
    const shown = await pickApplePasswords();
    await sleep(2000);
    assert(fake.launches() === 0, "the fake helper never starts in a Release build", fake.launches());
    assert(shown.state === "notEntitled" && shown.choice !== "apple", "an unentitled Release build doesn't offer Apple Passwords", shown);
    return { state: shown.state, launches: fake.launches() };
  },
  async E32() {
    const fake = fakeHelper(path.join(SCRATCH, "E32", "fake"));
    const standIn = iCloudExtensionStandIn(path.join(SCRATCH, "E32", "icloud-passwords"));
    await start("E32", { manifest: fake.manifest });
    const installed = await app.eval(`return ac.engine.call("extensions.install", { profile: "", path: ${JSON.stringify(standIn)} });`, { timeout: 30_000 });
    assert(installed.id === ICLOUD_PASSWORDS_EXTENSION_ID, "the stand-in has the iCloud Passwords extension's id", installed);
    await until(extensionView, (v) => v.installed && v.enabled === true);
    const steps = {};
    await pickApplePasswords();
    await app.eval(`return ac.applePasswords.submitApplePasswordsCode(${JSON.stringify(fake.fixtures.code)}).then(() => true);`, { timeout: 60_000 });
    steps.picked = await until(extensionView, (v) => v.choice === "apple" && v.enabled === false && !!v.note);
    assert(steps.picked.note.text === "Ardia now fills from Apple Passwords itself. You can remove the iCloud Passwords extension." && steps.picked.note.action === "Turn it back on", "Settings says so with Turn it back on", steps.picked);
    await app.eval(`return ac.iCloudPasswordsExtension.turnICloudExtensionBackOn(ac.store.getState().settings.defaultProfileId).then(() => true);`, { timeout: 30_000 });
    steps.backOn = await until(extensionView, (v) => v.enabled === true && v.note === null);
    await choose("ardia");
    await sleep(1500);
    steps.ardiaAfterBackOn = await until(extensionView, (v) => v.choice === "ardia");
    assert(steps.ardiaAfterBackOn.enabled === true, "turned back on by the user, it stays on", steps.ardiaAfterBackOn);
    await choose("apple");
    steps.pickedAgain = await until(extensionView, (v) => v.choice === "apple" && v.enabled === false && !!v.note);
    await choose("ardia");
    steps.switchedAway = await until(extensionView, (v) => v.choice === "ardia" && v.enabled === true && v.note === null);
    await setExtension(false);
    await until(extensionView, (v) => v.enabled === false);
    await choose("apple");
    await sleep(1500);
    steps.offByUser = await until(extensionView, (v) => v.choice === "apple");
    assert(steps.offByUser.enabled === false && steps.offByUser.note === null, "an extension the user turned off gets no note", steps.offByUser);
    await choose("ardia");
    await sleep(1500);
    steps.leftOff = await until(extensionView, (v) => v.choice === "ardia");
    assert(steps.leftOff.enabled === false, "switching away leaves an extension the user turned off alone", steps.leftOff);
    assert(Object.values(steps).every((v) => v.installed), "never uninstalled", steps);
    return Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v.enabled]));
  },
  ...loginListChecks({ paired, sites }),
};

const names = wanted.length ? wanted : Object.keys(CHECKS);
for (const name of names) {
  if (!CHECKS[name]) {
    report.record(name, { error: `no such check; known: ${Object.keys(CHECKS).join(", ")}` });
    continue;
  }
  await report.check(name, CHECKS[name], { onFail: async () => app && note("app log tail:", app.output().slice(-3000)) });
  await stop();
}
if (shared && !keep) note("quit shared:", (await shared.app.quit()).how);
await sites.close();
process.exit(report.summary() ? 0 : 1);
