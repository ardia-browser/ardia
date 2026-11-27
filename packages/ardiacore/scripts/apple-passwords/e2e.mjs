#!/usr/bin/env node
// Apple Passwords end to end, in hidden instances pointed at the fake helper (fake-helper.mjs; never Apple's).
//
//   node packages/ardiacore/scripts/apple-passwords/e2e.mjs <Debug Ardia.app> <scratch dir> [check…] [--release <Release Ardia.app>] [--keep]
//
//   E1  Pairing with the fixture code reads Connected and saves the profile's choice
//   E2  a helper killed at launch makes Pairing say "Apple Passwords isn't available"
//   E3  with no helper manifest, Pairing says how to get the helper back
//   E4  a Release build ignores the fake-helper override: the fake never starts (needs --release)
//   E8  on Apple Passwords, Chrome keeps its offer to save on but never shows its own password list over a sign-in field
//   E8save on Apple Passwords, signing in in a Chromium tab still gives Chrome's pending save (the save prompt fires)
//   E5… the Login list in a WebKit tab (login-list.mjs), in one paired instance shared by those checks; E15 ends the
//       fake's Pairing and pairs again from the Login list, leaving that instance paired; E34-E38 filter it as you type
//       on filter.localhost's /login-ready (its Sign in button is enabled and submit is recorded, not sent), and E37
//       ends Pairing and pairs again too
//   E5chromium… the same Login list checks in a Chromium tab of that instance
//   E18… saving to Apple Passwords from a WebKit tab (saving.mjs), in the same paired instance; E33 saves on an http page
//   E25-E27 Verification codes on a code field (codes.mjs), in that instance, in a WebKit tab and (E25chromium…) a
//       Chromium one: "Code for example.localhost" fills the fixture code, the account typed on the site's sign-in
//       page comes first, and an http code field or one holding text gets nothing
//   E32 with a stand-in for the iCloud Passwords extension (its id, from icloud-extension.mjs), picking Apple Passwords
//       turns it off and says so, "Turn it back on" turns it on, and switching to Ardia turns it on only if Ardia turned
//       it off; it is never uninstalled
//
// Each check launches its own instance (scripts/lib/instance.mjs) with ARDIA_TEST applePasswordsManifest at the fake's
// manifest and the fixture sites (sites.mjs: https example.localhost, accounts.example.localhost, other.localhost,
// empty.localhost, save.localhost and filter.localhost, http plain.localhost and plain-save.localhost, all on loopback with their ports), drives the same Settings state the Password manager menu and Pairing sheet use (ac.applePasswords), and
// prints one PASS or FAIL line; details go to <scratch dir>/e2e.log. METRO_PORT picks the Metro serving this tree.
// Exit code 1 if any check failed.
import fs from "node:fs";
import path from "node:path";
import { launch, reporter, sleep } from "../../../../scripts/lib/instance.mjs";
import { codeChecks } from "./codes.mjs";
import { fakeHelper } from "./fake.mjs";
import { ICLOUD_PASSWORDS_EXTENSION_ID, iCloudExtensionStandIn } from "./icloud-extension.mjs";
import { loginListChecks } from "./login-list.mjs";
import { savingChecks } from "./saving.mjs";
import { fixtureSites } from "./sites.mjs";
import { chromiumTabs, webkitTabs } from "./webkit.mjs";

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
  shared = { app, fake, tabs: webkitTabs(app, { log: note }), chromium: chromiumTabs(app, { log: note }) };
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

async function pairApplePasswords(fake) {
  await pickApplePasswords();
  await app.eval(`return ac.applePasswords.submitApplePasswordsCode(${JSON.stringify(fake.fixtures.code)}).then(() => true);`, { timeout: 60_000 });
  return until(pairingView, (v) => v.state === "connected" && v.choice === "apple");
}

const CHROME_ONLY_LOGIN = { username: "chrome-only@example.test", password: "fixture-pw-chrome-only-9" };

async function openSignIn(host, pathname = "/login") {
  const url = sites.url(host, pathname);
  await app.eval(`ac.actions.openUrls([${JSON.stringify(url)}]); return true;`);
  const { tabId } = await until(
    `const s = ac.store.getState(); const id = Object.keys(s.tabs).find((t) => s.tabs[t].url === ${JSON.stringify(url)} && !ac.tabLive.liveOf(t)?.isLoading); return { tabId: id ?? null };`,
    (v) => v.tabId,
  );
  return { tabId, url };
}

const loginItems = (events) =>
  events.filter((e) => e.name === "autofillSuggestions").flatMap((e) => e.payload?.items ?? []).filter((i) => /Password|Webauthn|Passkey/.test(i.type ?? ""));

async function chromeListAfterAsking(tabId, url) {
  const page = await app.page(url);
  try {
    await app.eval(`return ac.webviews.get(${JSON.stringify(tabId)}).focus()`);
    const before = (await app.eval(`return ac.engine.call("tabs.devEvents", { tabId: ${JSON.stringify(tabId)} })`)).length;
    const box = await page.eval("JSON.stringify(document.getElementById('u').getBoundingClientRect())");
    const { x, y, height } = JSON.parse(box);
    const at = { x: x + 20, y: y + height / 2, button: "left", clickCount: 1 };
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, buttons: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, buttons: 0 });
    await sleep(1500);
    const asked = await app.eval(`return ac.engine.call("autofill.showSuggestions", { tabId: ${JSON.stringify(tabId)}, passwords: true })`);
    await sleep(2500);
    const events = (await app.eval(`return ac.engine.call("tabs.devEvents", { tabId: ${JSON.stringify(tabId)} })`)).slice(before);
    return { asked, items: loginItems(events) };
  } finally {
    page.close();
  }
}

async function signInChromium(tabId, url, username, password) {
  const page = await app.page(url);
  try {
    const at = async (id) => {
      const { x, y, height } = JSON.parse(await page.eval(`JSON.stringify(document.getElementById(${JSON.stringify(id)}).getBoundingClientRect())`));
      const point = { x: x + 20, y: y + height / 2, button: "left", clickCount: 1 };
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, buttons: 1 });
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, buttons: 0 });
    };
    await app.eval(`return ac.webviews.get(${JSON.stringify(tabId)}).focus()`);
    await at("u");
    await page.send("Input.insertText", { text: username });
    await at("p");
    await page.send("Input.insertText", { text: password });
    const deadline = Date.now() + 5000;
    let ready = false;
    while (!(ready = await page.eval(`!document.getElementById("go").disabled`)) && Date.now() < deadline) await sleep(100);
    assert(ready === true, "the Sign in button is enabled once both fields are typed", ready);
    await at("go");
  } finally {
    page.close();
  }
}

const passwordPromptOf = (tabId) => `const p = ac.pageState.getState().pages[${JSON.stringify(tabId)}]?.passwordPrompt; return p ? { state: p.state, username: p.username, origin: p.origin } : null;`;

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

const inChromium = (checks, names) => Object.fromEntries(names.map((name) => [`${name}chromium`, checks[name]]));

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
  async E8() {
    const fake = fakeHelper(path.join(SCRATCH, "E8", "fake"));
    await start("E8", { manifest: fake.manifest });
    const origin = new URL(sites.url("example.localhost")).origin;
    const seeded = await app.eval(
      `return globalThis.expo.modules.ArdiaPasswords.save("", ${JSON.stringify(origin)}, ${JSON.stringify(CHROME_ONLY_LOGIN.username)}, ${JSON.stringify(CHROME_ONLY_LOGIN.password)}).then(() => true).catch((e) => ({ error: e.message }))`,
    );
    assert(seeded === true, "a login saved in Chrome's own store", seeded);
    const first = await openSignIn("example.localhost");
    const control = await chromeListAfterAsking(first.tabId, first.url);
    assert(control.items.some((i) => [i.label, i.sublabel].includes(CHROME_ONLY_LOGIN.username)), "on Ardia, Chrome's list shows its saved login (control)", control);
    await pairApplePasswords(fake);
    const offer = await until(`return ac.engine.call("passwords.autofillEnabled", { profile: "" })`, (v) => v === true, 10_000).catch((e) => ({ error: e.message }));
    assert(offer === true, "Chrome's offer to save stays on for Apple Passwords", offer);
    await app.eval(`ac.store.getState().navigate(${JSON.stringify(first.tabId)}, ${JSON.stringify(first.url)}, { userInitiated: true }); return true;`);
    await sleep(1500);
    const reloaded = await chromeListAfterAsking(first.tabId, first.url);
    assert(reloaded.items.length === 0, "an open tab shows no Chrome password list once the profile is on Apple Passwords", reloaded);
    const second = await openSignIn("example.localhost", "/login?again");
    const fresh = await chromeListAfterAsking(second.tabId, second.url);
    assert(fresh.items.length === 0, "a new tab shows no Chrome password list on Apple Passwords", fresh);
    return { control: control.items.length, reloaded: reloaded.asked, fresh: fresh.asked };
  },
  async E8save() {
    const fake = fakeHelper(path.join(SCRATCH, "E8save", "fake"));
    await start("E8save", { manifest: fake.manifest });
    await pairApplePasswords(fake);
    const tab = await openSignIn("example.localhost");
    const login = { username: `chromium-${Date.now()}@example.test`, password: "fixture-pw-chromium-11" };
    await signInChromium(tab.tabId, tab.url, login.username, login.password);
    const prompt = await until(passwordPromptOf(tab.tabId), (v) => v?.state === "save", 20_000);
    assert(prompt.username === login.username, "Chrome holds the submitted login for the save prompt on an Apple Passwords profile", prompt);
    return { state: prompt.state };
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
  ...inChromium(loginListChecks({ paired, sites, engine: "chromium" }), ["E5", "E6", "E7", "E12", "E13", "E15", "E34", "E35", "E36", "E37"]),
  ...savingChecks({ paired, sites }),
  ...codeChecks({ paired, sites }),
  ...inChromium(codeChecks({ paired, sites, engine: "chromium" }), ["E25", "E26", "E27"]),
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
