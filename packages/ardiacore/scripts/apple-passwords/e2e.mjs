#!/usr/bin/env node
// Apple Passwords end to end, in hidden instances pointed at the fake helper (fake-helper.mjs; never Apple's).
//
//   node packages/ardiacore/scripts/apple-passwords/e2e.mjs <Debug Ardia.app> <scratch dir> [check…] [--release <Release Ardia.app>] [--keep]
//
// Runs every check, or the ones named, each printing one PASS or FAIL line; details go to <scratch dir>/e2e.log.
// METRO_PORT picks the Metro serving this tree. Exit code 1 if any check failed.
// The checks are listed in docs/testing.md › Apple Passwords checks.
import fs from "node:fs";
import path from "node:path";
import { launch, reporter, sleep } from "../../../../scripts/lib/instance.mjs";
import { scanLogs, systemLog } from "../../../../scripts/lib/log-secrets.mjs";
import { codeChecks } from "./codes.mjs";
import { FIXTURES, fakeHelper } from "./fake.mjs";
import { ICLOUD_PASSWORDS_EXTENSION_ID, iCloudExtensionStandIn } from "./icloud-extension.mjs";
import { loginListChecks } from "./login-list.mjs";
import { savingChecks } from "./saving.mjs";
import { fixtureSites, PAGE_EVENTS } from "./sites.mjs";
import { strongPasswordChecks } from "./strong-password.mjs";
import { chromiumTabs, waitFor, webkitTabs } from "./webkit.mjs";

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
const RUN_STARTED = Date.now();
const launched = [];

async function start(name, { manifest, binary = APP, files = {}, test = {} }) {
  const data = path.join(SCRATCH, name, "data");
  app = await launch(binary, { data, fresh: true, onboarded: true, test: { applePasswordsManifest: manifest, ...test }, switches: sites.switches, files, ready: READY });
  note("launched", name, "pid", app.pid, "log", app.log);
  launched.push({ name, pid: app.pid, log: app.log });
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
  await app.eval(`return ac.applePasswords.submitApplePasswordsCode(ac.applePasswords.pairingCodeSecret(${JSON.stringify(fake.fixtures.code)})).then(() => true);`, { timeout: 60_000 });
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
  await app.eval(`return ac.applePasswords.submitApplePasswordsCode(ac.applePasswords.pairingCodeSecret(${JSON.stringify(fake.fixtures.code)})).then(() => true);`, { timeout: 60_000 });
  return until(pairingView, (v) => v.state === "connected" && v.choice === "apple");
}

const FIXTURE_CARD = { name: `O'Brien "Q" \\ </script><script>x()</script>`, number: "4111111111111111", expMonth: 7, expYear: 2031 };

const HELPER_MISSING = "Apple Passwords' browser helper is missing from this Mac. Update macOS in System Settings › General › Software Update, then try again.";

const ME_CARD = { name: "Ada Lovelace", organization: "", emails: ["ada.lovelace@me.test"], phones: ["+1 415 555 0134"], addresses: [{ street: "1 Infinite Loop", city: "Cupertino", state: "CA", postalCode: "95014", country: "US" }] };

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

async function pageWithField(url, id) {
  const page = await app.page(url);
  const deadline = Date.now() + 10_000;
  let ready = false;
  while (!(ready = await page.eval(`document.readyState === "complete" && !!document.getElementById(${JSON.stringify(id)})`).catch(() => false)) && Date.now() < deadline) await sleep(100);
  if (!ready) page.close();
  assert(ready, `the page has its #${id} field`, url);
  return page;
}

async function chromeListAfterAsking(tabId, url) {
  const page = await pageWithField(url, "u");
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
  const page = await pageWithField(url, "u");
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

async function freshChromiumTab(url) {
  const fake = fakeHelper(path.join(SCRATCH, "E24control", "fake"));
  await start("E24control", { manifest: fake.manifest });
  return chromiumTabs(app, { log: note }).open(url);
}

function loggedSecrets() {
  const fakeLogins = fs
    .readdirSync(SCRATCH, { recursive: true })
    .filter((file) => path.basename(file) === "fixtures.json")
    .flatMap((file) => JSON.parse(fs.readFileSync(path.join(SCRATCH, file), "utf8")).logins ?? []);
  const passwords = new Map([...FIXTURES.logins, ...fakeLogins].map((l) => [l.password, l.user]));
  passwords.set(CHROME_ONLY_LOGIN.password, CHROME_ONLY_LOGIN.username);
  return [
    { label: "a fixture-pw- password", value: "fixture-pw-" },
    ...[...passwords].map(([value, user]) => ({ label: `the password of ${user}`, value })),
    { label: "the Pairing code", value: FIXTURES.code, whole: true },
    { label: "the fixture card's number", value: FIXTURE_CARD.number, whole: true },
    ...FIXTURES.codes.map((c) => ({ label: `the Verification code of ${c.username} on ${c.domain}`, value: c.code, whole: true })),
  ];
}

async function noSecretsInLogs() {
  assert(launched.length > 0, "E31 reads the logs of the checks run before it; run it last", launched);
  if (shared && !shared.app.exited) note("quit shared:", (await shared.app.quit()).how);
  shared = null;
  const secrets = loggedSecrets();
  const systemFile = path.join(SCRATCH, "system.log");
  const system = systemLog({ since: RUN_STARTED, pids: launched.map((l) => l.pid), file: systemFile });
  const { files, hits } = scanLogs({ dirs: [SCRATCH], secrets });
  const unread = [...launched.map((l) => l.log), systemFile].filter((log) => !files.includes(log));
  assert(!unread.length, "every instance's app log and the system log are read", unread);
  assert(system.includes("helper started"), "the system log holds the Apple Passwords client's own lines, so it was read", system.length);
  const found = hits.map((h) => `${h.label} in ${path.relative(SCRATCH, h.file) || h.file} (${h.encoding} at byte ${h.at})`);
  assert(!found.length, "no fixture password or code in any log", found);
  return { instances: launched.length, files: files.length, systemLogBytes: system.length, secrets: secrets.length };
}

const ENGINES = ["webkit", "chromium"];

async function meCardInstance(name) {
  const fake = fakeHelper(path.join(SCRATCH, name, "fake"));
  const card = path.join(SCRATCH, name, "me-card.json");
  fs.writeFileSync(card, JSON.stringify(ME_CARD));
  await start(name, { manifest: fake.manifest, test: { meCard: card } });
  await pairApplePasswords(fake);
  const on = await app.eval(`return ac.meCard.setMeCardFor("", true).then(() => (ac.meCard.useMeCard.getState().entries[""] ?? []).length)`, { timeout: 20_000 });
  assert(on === 1, "the Me card is on with its one entry", on);
  return { fake };
}

async function listsOn(fields, then = async () => {}) {
  const seen = {};
  for (const engine of ENGINES) {
    const tabs = engine === "webkit" ? webkitTabs(app, { log: note }) : chromiumTabs(app, { log: note });
    for (const [pathname, selector] of fields) {
      const tab = await tabs.open(sites.url("example.localhost", pathname));
      try {
        const devEvents = () => app.eval(`return ac.engine.call("tabs.devEvents", { tabId: ${JSON.stringify(tab.id)} })`);
        const before = engine === "chromium" ? (await devEvents()).length : 0;
        await tab.click(selector);
        await sleep(2000);
        const panels = await tab.lists();
        const events = engine === "chromium" ? (await devEvents()).slice(before) : [];
        const chromeAddresses = events.filter((e) => e.name === "autofillSuggestions").flatMap((e) => e.payload?.items ?? []).filter((i) => /Address/.test(i.type ?? ""));
        const loginRows = panels.find((rows) => rows.some((r) => r.title === "Open Passwords app")) ?? null;
        const addressList = chromeAddresses.length > 0 || panels.some((rows) => rows.some((r) => [ME_CARD.name, ME_CARD.emails[0], ME_CARD.addresses[0].street].some((text) => r.label.includes(text))));
        seen[`${engine} ${pathname} ${selector}`] = { loginList: !!loginRows, addressList, strong: !!loginRows?.some((r) => r.title === "Suggest strong password") };
        note("lists", engine, pathname, selector, JSON.stringify(panels.map((rows) => rows.map((r) => r.label))));
        if (loginRows) await then(tab, engine, pathname, loginRows);
      } finally {
        await tab.close();
      }
    }
  }
  note("lists seen", JSON.stringify(seen));
  return seen;
}

function expectLists(seen, engine, field, want) {
  const got = seen[`${engine} ${field}`];
  assert(got && got.loginList === want.loginList && got.addressList === want.addressList, `${engine} ${field} shows ${want.loginList ? "the Login list" : "no Login list"} and ${want.addressList ? "the address list" : "no address list"}`, seen);
}

const inChromium = (checks, names) => Object.fromEntries(names.map((name) => [`${name}chromium`, checks[name]]));

const CHECKS = {
  async E1() {
    const fake = fakeHelper(path.join(SCRATCH, "E1", "fake"));
    await start("E1", { manifest: fake.manifest });
    const shown = await pickApplePasswords();
    assert(shown.step === "code" && shown.choice !== "apple", "the code step opens before anything is saved", shown);
    await app.eval(`return ac.applePasswords.submitApplePasswordsCode(ac.applePasswords.pairingCodeSecret(${JSON.stringify(fake.fixtures.code)})).then(() => true);`, { timeout: 60_000 });
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
  async E8kept() {
    const fake = fakeHelper(path.join(SCRATCH, "E8kept", "fake"));
    await start("E8kept", { manifest: fake.manifest });
    const origin = new URL(sites.url("example.localhost")).origin;
    const seeded = await app.eval(
      `return globalThis.expo.modules.ArdiaPasswords.save("", ${JSON.stringify(origin)}, ${JSON.stringify(CHROME_ONLY_LOGIN.username)}, ${JSON.stringify(CHROME_ONLY_LOGIN.password)}).then(() => true).catch((e) => ({ error: e.message }))`,
    );
    assert(seeded === true, "the login is in Ardia's own store", seeded);
    await pairApplePasswords(fake);
    const tab = await openSignIn("example.localhost");
    await signInChromium(tab.tabId, tab.url, CHROME_ONLY_LOGIN.username, CHROME_ONLY_LOGIN.password);
    const prompt = await until(passwordPromptOf(tab.tabId), (v) => v?.state === "save", 20_000);
    assert(prompt.username === CHROME_ONLY_LOGIN.username, "a login Ardia's own store already holds is still offered to Apple Passwords", prompt);
    await app.eval(`return ac.prompts.answerPasswordPrompt(${JSON.stringify(tab.tabId)}, "save")`);
    const saved = await waitFor("the login in Apple Passwords", async () => fake.savedLogins().find((l) => l.user === CHROME_ONLY_LOGIN.username) ?? null, 20_000);
    assert(saved.password === CHROME_ONLY_LOGIN.password, "Save puts it in Apple Passwords", { user: saved.user, sites: saved.sites });
    return { state: prompt.state, sites: saved.sites };
  },
  async E44() {
    const missing = path.join(SCRATCH, "E44", "no-such-manifest.json");
    fs.rmSync(missing, { force: true });
    await start("E44", { manifest: missing });
    await app.eval("return ac.applePasswords.loadApplePasswords().then(() => true)");
    await choose("apple");
    await until(pairingView, (v) => v.choice === "apple" && v.state === "helperMissing");
    const seen = {};
    for (const [engine, tabs] of [["webkit", webkitTabs(app, { log: note })], ["chromium", chromiumTabs(app, { log: note })]]) {
      const tab = await tabs.open(sites.url("example.localhost"));
      try {
        await tab.click("#u");
        const rows = await tab.waitRows(`the ${engine} Login list`);
        assert(rows[0]?.notice && rows[0].label === HELPER_MISSING, `the ${engine} Login list says the helper is missing and how to get it back`, rows);
        seen[engine] = rows[0].label;
      } finally {
        await tab.close();
      }
    }
    return seen;
  },
  async E40() {
    await meCardInstance("E40");
    const seen = await listsOn([["/login-email", "#u"], ["/checkout", "#u"]]);
    for (const engine of ENGINES) {
      expectLists(seen, engine, "/login-email #u", { loginList: true, addressList: false });
      expectLists(seen, engine, "/checkout #u", { loginList: false, addressList: true });
    }
    return seen;
  },
  async E42() {
    await meCardInstance("E42");
    const seen = await listsOn([["/signup-email", "#u"], ["/signup-email", "#p"], ["/signup", "#u"]]);
    for (const engine of ENGINES) {
      expectLists(seen, engine, "/signup-email #u", { loginList: false, addressList: true });
      expectLists(seen, engine, "/signup #u", { loginList: false, addressList: true });
      expectLists(seen, engine, "/signup-email #p", { loginList: true, addressList: false });
      assert(seen[`${engine} /signup-email #p`].strong, `${engine}: the new-password field offers Suggest strong password`, seen);
    }
    return seen;
  },
  async E43() {
    const { fake } = await meCardInstance("E43");
    const user = FIXTURES.logins.find((l) => l.sites.includes("example.localhost")).user;
    const seen = await listsOn([["/identifier", "#u"], ["/identifier-next", "#u"]], async (tab, engine, pathname, rows) => {
      if (!rows.some((r) => r.title === user)) return;
      const passwordsAsked = fake.requests().filter((r) => r.cmd === 5).length;
      await tab.pick(user);
      const filled = await waitFor(`${engine} ${pathname} filled`, async () => ((await tab.value(`document.getElementById("u").value`)) === user ? true : null), 10_000).catch(() => false);
      assert(filled, `${engine} ${pathname}: picking a login fills the username`, await tab.value(`document.getElementById("u").value`));
      assert(fake.requests().filter((r) => r.cmd === 5).length === passwordsAsked, `${engine} ${pathname}: filling only the username never asks Apple Passwords for the password`, null);
    });
    for (const engine of ENGINES) {
      expectLists(seen, engine, "/identifier #u", { loginList: true, addressList: false });
      expectLists(seen, engine, "/identifier-next #u", { loginList: true, addressList: false });
    }
    return seen;
  },
  async cardWebKit() {
    const fake = fakeHelper(path.join(SCRATCH, "cardWebKit", "fake"));
    await start("cardWebKit", { manifest: fake.manifest, test: { reauth: "granted" } });
    const { name, number, expMonth, expYear } = FIXTURE_CARD;
    await app.eval(`return globalThis.expo.modules.ArdiaAutofill.saveCard("", ${JSON.stringify({ name, expMonth, expYear })}, ${JSON.stringify(number)}).then(() => true)`, { timeout: 20_000 });
    const cards = await app.eval(`return ac.engine.call("autofill.cards", { profile: "" })`);
    assert(cards.cards?.length === 1 && cards.cards[0].last4 === "1111", "the fixture card is saved", cards.cards?.map((c) => c.last4));
    const tab = await webkitTabs(app, { log: note }).open(sites.url("example.localhost", "/card"));
    const form = () => tab.value(`({ n: document.getElementById("n").value, num: document.getElementById("num").value, m: document.getElementById("m").value, y: document.getElementById("y").value, events: ${PAGE_EVENTS}.filter((e) => e[0] !== "focusin").map((e) => e.join(":")) })`);
    try {
      await tab.click("#n");
      const rows = await tab.waitRows("the card dropdown");
      assert(rows.some((r) => r.label.includes("1111")), "the dropdown lists the saved card", rows.map((r) => r.title));
      await tab.key("down");
      await sleep(300);
      await tab.key("enter");
      const filled = await waitFor("the filled card", async () => ((await form())?.num ? form() : null), 10_000);
      assert(filled.n === name, "the card's name fills byte for byte", { length: filled.n.length, same: filled.n === name });
      assert(filled.num === number, "the card's number fills", { length: filled.num.length });
      assert(/^0?7$/.test(filled.m) && /^(20)?31$/.test(filled.y), "the expiry fills", { m: filled.m, y: filled.y });
      for (const id of ["n", "num", "m", "y"]) assert(filled.events.includes(`input:${id}`) && filled.events.includes(`change:${id}`), `#${id} hears input and change`, filled.events);
      return { rows: rows.length, events: filled.events.length };
    } finally {
      await tab.close();
    }
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
    await app.eval(`return ac.applePasswords.submitApplePasswordsCode(ac.applePasswords.pairingCodeSecret(${JSON.stringify(fake.fixtures.code)})).then(() => true);`, { timeout: 60_000 });
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
  ...inChromium(loginListChecks({ paired, sites, engine: "chromium" }), ["E5", "E6", "E7", "E41", "E41fetch", "E9", "E10", "E11", "E12", "E13", "E28frame", "E28claim", "E14", "E15", "E16", "E17", "E34", "E34fetches", "E34fresh", "E35", "E36", "E37", "E38"]),
  ...savingChecks({ paired, sites }),
  ...inChromium(savingChecks({ paired, sites, engine: "chromium" }), ["E18", "E18notConnected", "E39", "E19", "E20", "E20unread", "E21", "E22", "E22garbled", "E23"]),
  ...strongPasswordChecks({ paired, sites, fresh: freshChromiumTab }),
  ...inChromium(strongPasswordChecks({ paired, sites, engine: "chromium" }), ["E24", "E24pattern", "E24change", "E24notConnected"]),
  ...codeChecks({ paired, sites }),
  ...inChromium(codeChecks({ paired, sites, engine: "chromium" }), ["E25", "E26", "E27"]),
  E31: noSecretsInLogs,
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
