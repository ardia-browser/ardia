import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, beforeEach, test } from "node:test";
globalThis.require = createRequire(import.meta.url);

const link = (url) => ({ type: "url", title: url, url });
const DAY = 86_400_000;
let reads = {};
let readCalls = [];
let discarded = [];
let unlocked = true;
let duringRead = () => {};
const native = { listBrowsers: async () => "[]", importSafariExport: async () => "{}", importSafariDirect: async () => "{}", unlockBrowser: async () => null, chooseImportFile: async () => null, onWrite: () => {} };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

globalThis.acTestNativeModules = {
  ArdiaImport: {
    addListener: () => ({ remove() {} }),
    cancelImport() {},
    forgetUnlockedKeys() {},
    unlockBrowser: (...args) => native.unlockBrowser(...args),
    isBrowserUnlocked: () => unlocked,
    safariHasFullDiskAccess: () => false,
    writeImported: async () => {
      await native.onWrite();
      return JSON.stringify({ cookies: 0, addresses: 0, cards: 0 });
    },
    discardImported: (token) => discarded.push(token),
    listBrowsers: () => native.listBrowsers(),
    chooseImportFile: (kind) => native.chooseImportFile(kind),
    importBookmarksHTML: async () => JSON.stringify({ type: "folder", title: "Bookmarks", children: [{ type: "folder", title: "Bar", role: "toolbar", children: [link("https://html.example/")] }] }),
    importSafariExport: (_job, path) => native.importSafariExport(path),
    importSafariDirect: () => native.importSafariDirect(),
    listExtensions: async () => "[]",
    importData: async (_job, browserId, profileId) => {
      readCalls.push(browserId);
      await duringRead(browserId);
      const read = reads[browserId];
      if (!read) throw Object.assign(new Error("The import failed"), { code: "unreadable" });
      return JSON.stringify({
        browserId, profileId, history: [], historyCount: 0, tabGroups: [], cookieCount: 0, addressCount: 0, cardCount: 0, spaces: [], favorites: [], favicons: [],
        tabs: read.tabs.map((url) => ({ url, title: url, pinned: false, windowIndex: 0, active: false })),
        credentials: read.credentials,
        vaultToken: read.vaultToken,
        bookmarks: { type: "folder", title: "Bookmarks", children: [{ type: "folder", title: "Bookmarks Bar", role: "toolbar", children: read.bookmarks.map(link) }] },
        failed: [], warnings: [],
      });
    },
  },
};

const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const flow = await import("./flow.ts");
const { continueImport, importUnlocked, recheckAccess, runImport, skipEncryptedData, skipSource, unlockAndImport } = await import("./runImport.ts");
const { importSafariDirect, importSafariExport, pickSafariExport } = await import("./fileImports.ts");
const { emptyCounts, saveLogins } = await import("./apply.ts");
const outcome = await import("./importOutcome.ts");
const { endTurn } = await import("./importTurn.ts");
const { importBookmarksHtml } = await import("./fileImports.ts");
const { takeImportRuns } = await import("../telemetry/importRuns.ts");
const telemetry = await import("../telemetry/client.ts");
globalThis.fetch = async () => ({ status: 503 });
telemetry.loadChoice();
telemetry.setSharing(true, "onboarding");
after(() => telemetry.setSharing(false, "settings"));

const S = () => useBrowser.getState();
const step = () => flow.useImportFlow.getState().step;
const turnNow = () => flow.useImportFlow.getState().turn;
const chromium = (id, name) => ({ id, name, family: "chromium", requiresExport: false, needsKeychain: false, profiles: [{ id: "Default", name: "Default", path: id, isDefault: true, available: ["bookmarks", "passwords", "tabs"] }] });
const SAFARI = { id: "safari", name: "Safari", family: "safari", requiresExport: true, needsKeychain: false, profiles: [{ id: "", name: "Safari", path: "", isDefault: true, available: [] }] };
const now = Date.now();
const cred = (url, username, password, created) => ({ url, username, password, created });
const storedLogins = () => [...stub.passwordStores.get(null).values()].map((l) => [l.url, l.username, l.password]).sort();

async function until(name) {
  const end = Date.now() + 5000;
  while (step().name !== name && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert.equal(step().name, name);
  return step();
}

beforeEach(() => {
  readCalls = [];
  discarded = [];
  unlocked = true;
  duringRead = () => {};
  native.chooseImportFile = async () => null;
  native.importSafariExport = async () => "{}";
  native.importSafariDirect = async () => "{}";
  native.listBrowsers = async () => "[]";
  native.onWrite = () => {};
  stub.passwordStores.set(null, new Map());
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  S().createWindow({ url: "https://start.example/" });
  takeImportRuns();
});

function pick(browsers, ids) {
  endTurn();
  flow.useImportFlow.setState({ browsers, target: "default", run: null, step: { name: "choose", error: null } });
  flow.pickSources(ids);
}

test("several ticked browsers import one after another into the same profile, keeping one copy of what they share", async () => {
  reads = {
    chrome: { bookmarks: ["https://shared.example/", "https://chrome.example/"], tabs: ["https://tab.example/"], credentials: [cred("https://mail.example/", "me", "same", now - DAY)] },
    brave: { bookmarks: ["https://shared.example/", "https://brave.example/"], tabs: ["https://tab.example/", "https://brave-tab.example/"], credentials: [cred("https://mail.example/login", "me", "same", now)] },
  };
  pick([chromium("chrome", "Chrome"), chromium("brave", "Brave")], ["chrome", "brave"]);
  assert.deepEqual(flow.useImportFlow.getState().picked, ["chrome", "brave"]);
  continueImport("choose", turnNow());
  const done = await until("done");
  assert.deepEqual(done.sources.map((s) => [s.name, s.counts.bookmarks, s.counts.tabs, s.counts.passwords]), [["Chrome", 2, 1, 1], ["Brave", 1, 1, 0]]);
  assert.equal(done.counts.bookmarks, 3);
  assert.deepEqual(storedLogins(), [["https://mail.example", "me", "same"]]);
  assert.equal(Object.values(S().tabs).filter((t) => t.url === "https://tab.example/").length, 1);
  const sent = takeImportRuns();
  assert.deepEqual([sent.import_runs, sent.import_multi_runs, sent.import_multi_browsers, sent.import_passwords_merged, sent.import_password_conflicts], [2, 1, 2, 1, 0]);
});

test("different passwords for one account wait for a choice, and the chosen browser's version is saved", async () => {
  reads = {
    chrome: { bookmarks: [], tabs: [], credentials: [cred("https://bank.example/", "me", "chrome-pass", now - 30 * DAY), cred("https://shop.example/", "me", "c", now - DAY)] },
    brave: { bookmarks: [], tabs: [], credentials: [cred("https://bank.example/", "me", "brave-pass", now - DAY), cred("https://shop.example/", "me", "b", now - 2 * DAY)] },
  };
  pick([chromium("chrome", "Chrome"), chromium("brave", "Brave")], ["chrome", "brave"]);
  continueImport("choose", turnNow());
  const conflicts = await until("conflicts");
  assert.equal(conflicts.conflicts.length, 2);
  assert.equal(conflicts.pick, "newest");
  assert.equal(JSON.stringify(conflicts).includes("pass"), false, "the step never holds a password");
  assert.deepEqual(storedLogins(), [], "nothing is saved before the choice");
  outcome.pickConflictVersions("chrome", step().token);
  await outcome.importChosenPasswords(step().token);
  const done = await until("done");
  assert.deepEqual(storedLogins(), [["https://bank.example", "me", "chrome-pass"], ["https://shop.example", "me", "c"]]);
  assert.deepEqual(done.sources.map((s) => s.counts.passwords), [2, 0]);
  const sent = takeImportRuns();
  assert.deepEqual([sent.import_password_conflicts, sent.import_conflicts_browser, sent.import_conflicts_newest, sent.import_conflict_rows_changed], [2, 1, 0, 0]);
});

test("choices made by hand start from the default, count what changed, and are what gets saved", async () => {
  reads = {
    chrome: { bookmarks: [], tabs: [], credentials: [cred("https://bank.example/", "me", "old", now - 30 * DAY), cred("https://shop.example/", "me", "c", now - DAY)] },
    brave: { bookmarks: [], tabs: [], credentials: [cred("https://bank.example/", "me", "new", now - DAY), cred("https://shop.example/", "me", "b", now - 9 * DAY)] },
  };
  pick([chromium("chrome", "Chrome"), chromium("brave", "Brave")], ["chrome", "brave"]);
  continueImport("choose", turnNow());
  const first = await until("conflicts");
  const bank = first.conflicts.find((c) => c.site === "bank.example");
  outcome.openConflictList(step().token);
  assert.equal(step().view, "list");
  assert.deepEqual(Object.values(step().draft.choices).sort(), ["brave", "chrome"], "rows start on the newest of each");
  outcome.setConflictFilter("bank", step().token);
  outcome.chooseConflictVersion(bank.id, "chrome", step().token);
  outcome.closeConflictList(step().token);
  assert.equal(step().pick, "custom");
  assert.equal(outcome.handChanges(step().custom), 1);
  await outcome.importChosenPasswords(step().token);
  await until("done");
  assert.deepEqual(storedLogins(), [["https://bank.example", "me", "old"], ["https://shop.example", "me", "c"]]);
  const sent = takeImportRuns();
  assert.deepEqual([sent.import_conflicts_custom, sent.import_conflict_rows_changed], [1, 1]);
});

test("a browser that fails or is skipped never stops the others, and the done screen names it", async () => {
  reads = { chrome: { bookmarks: ["https://chrome.example/"], tabs: [], credentials: [] } };
  pick([chromium("chrome", "Chrome"), chromium("broken", "Broken"), SAFARI], ["chrome", "broken", "safari"]);
  continueImport("choose", turnNow());
  await until("safari");
  assert.equal(flow.runStepLabel(flow.useImportFlow.getState()), "3 of 3: Safari");
  assert.equal(flow.canGoBackToChoose(flow.useImportFlow.getState()), false);
  skipSource(turnNow());
  const done = await until("done");
  assert.deepEqual(done.failures, [{ kind: "bookmarks", profiles: [], browser: "Broken" }, { kind: "passwords", profiles: [], browser: "Broken" }, { kind: "tabs", profiles: [], browser: "Broken" }]);
  assert.deepEqual(done.notes, ["Safari was skipped."]);
  assert.deepEqual(done.sources.map((s) => s.name), ["Chrome", "Broken"]);
  assert.equal(done.counts.bookmarks, 1);
  const sent = takeImportRuns();
  assert.deepEqual([sent.import_multi_browsers, sent.import_multi_skipped], [3, 1]);
});

test("a kind only some ticked browsers have is offered once, a kind left unticked stays off, and going back restores the choice", () => {
  const firefox = { id: "firefox", name: "Firefox", family: "firefox", requiresExport: false, needsKeychain: false, profiles: [{ id: "p", name: "p", path: "p", isDefault: true, available: ["bookmarks", "history"] }] };
  pick([chromium("chrome", "Chrome"), firefox], ["chrome"]);
  flow.toggleImportKind("passwords", false);
  flow.toggleSource(firefox);
  assert.deepEqual([...flow.useImportFlow.getState().kinds].sort(), ["bookmarks", "history", "tabs"]);
  flow.toggleSource(chromium("chrome", "Chrome"));
  assert.deepEqual(flow.useImportFlow.getState().picked, ["firefox"]);
  assert.equal(flow.useImportFlow.getState().source.id, "firefox");
  flow.pickSources([]);
  assert.equal(flow.useImportFlow.getState().source, null);
  flow.pickSources(["chrome", "firefox"]);
  assert.equal(flow.startRun(), true);
  flow.takeTurn(chromium("chrome", "Chrome"));
  assert.deepEqual([...flow.useImportFlow.getState().kinds].sort(), ["bookmarks", "passwords", "tabs"]);
  const chosen = [...flow.useImportFlow.getState().run.chosen].sort();
  flow.patchImport({ step: { name: "profiles" } });
  flow.backTo("choose", turnNow());
  assert.equal(flow.useImportFlow.getState().run, null);
  assert.deepEqual([...flow.useImportFlow.getState().kinds].sort(), chosen);
});

const settle = async () => {
  for (let tick = 0; tick < 50; tick++) await new Promise((r) => setTimeout(r, 0));
};
const safariExport = (credentials) => JSON.stringify({ bookmarks: { type: "folder", title: "Bookmarks", children: [] }, profiles: [], tabs: [], credentials });

test("a Safari export still being read when its window closed never reaches the next import run", async () => {
  reads = { chrome: { bookmarks: [], tabs: [], credentials: [] }, brave: { bookmarks: [], tabs: [], credentials: [] } };
  const late = deferred();
  native.importSafariExport = () => late.promise;
  pick([SAFARI, chromium("chrome", "Chrome")], ["safari", "chrome"]);
  continueImport("choose", turnNow());
  await until("safari");
  void importSafariExport("/tmp/old.zip", turnNow());
  native.listBrowsers = async () => JSON.stringify([chromium("chrome", "Chrome"), chromium("brave", "Brave")]);
  flow.startImport(0);
  await settle();
  flow.useImportFlow.setState({ target: "default" });
  flow.pickSources(["chrome", "brave"]);
  continueImport("choose", turnNow());
  const done = await until("done");
  late.resolve(safariExport([cred("https://old.example/", "me", "stale", now)]));
  await settle();
  assert.deepEqual(storedLogins(), []);
  assert.equal(step(), done, "the finished run is left as it was");
});

test("pressing Continue twice starts each browser's read once", async () => {
  reads = { chrome: { bookmarks: [], tabs: [], credentials: [] }, brave: { bookmarks: [], tabs: [], credentials: [] } };
  pick([chromium("chrome", "Chrome"), chromium("brave", "Brave")], ["chrome", "brave"]);
  continueImport("choose", turnNow());
  continueImport("choose", turnNow());
  await until("done");
  assert.deepEqual(readCalls, ["chrome", "brave"]);
  assert.equal(takeImportRuns().import_runs, 2);
});

test("a Full Disk Access check that answers after the browser was skipped doesn't start it again", async () => {
  reads = { chrome: { bookmarks: [], tabs: [], credentials: [] }, locked: { bookmarks: [], tabs: [], credentials: [] } };
  const answer = deferred();
  native.listBrowsers = () => answer.promise;
  pick([{ ...chromium("locked", "Locked"), needsFullDiskAccess: true }, chromium("chrome", "Chrome")], ["locked", "chrome"]);
  continueImport("choose", turnNow());
  await until("access");
  const checking = recheckAccess(turnNow());
  skipSource(turnNow());
  await until("done");
  answer.resolve(JSON.stringify([chromium("locked", "Locked"), chromium("chrome", "Chrome")]));
  await checking;
  await settle();
  assert.deepEqual(readCalls, ["chrome"]);
  assert.equal(step().name, "done");
});

test("a keychain unlock that finishes after Skip Encrypted Data doesn't import a second time", async () => {
  reads = { chrome: { bookmarks: [], tabs: [], credentials: [] } };
  unlocked = false;
  const unlock = deferred();
  native.unlockBrowser = () => unlock.promise;
  pick([{ ...chromium("chrome", "Chrome"), needsKeychain: true }], ["chrome"]);
  continueImport("choose", turnNow());
  await until("unlock");
  const unlocking = unlockAndImport(turnNow());
  skipEncryptedData(turnNow());
  await until("done");
  unlock.resolve(null);
  await unlocking;
  await settle();
  assert.deepEqual(readCalls, ["chrome"]);
  native.unlockBrowser = async () => null;
});

test("a password save stops as soon as the import is cancelled", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  const results = await saveLogins([{ profileId: "default", origin: "https://a.example", username: "me", password: "x", consent: null }], cancelled.signal);
  assert.deepEqual(results, []);
  assert.deepEqual(storedLogins(), []);
});

test("counts that span the run need every browser's consent, and a password Ardia kept is reported", async () => {
  stub.passwordStores.get(null).set("https://mail.example\nme", { origin: "https://mail.example/", url: "https://mail.example", username: "me", password: "already", created: 1 });
  reads = {
    chrome: { bookmarks: [], tabs: [], credentials: [cred("https://mail.example/", "me", "imported", now)] },
    brave: { bookmarks: [], tabs: [], credentials: [] },
  };
  pick([chromium("chrome", "Chrome"), chromium("brave", "Brave")], ["chrome", "brave"]);
  continueImport("choose", turnNow());
  const done = await until("done");
  assert.deepEqual(done.notes, ["1 password wasn't changed: Ardia already has a different one saved for that account."]);
  assert.equal(done.sources[0].counts.passwords, 0);
  let sent = takeImportRuns();
  assert.deepEqual([sent.import_multi_runs, sent.import_passwords_kept_existing], [1, 1]);

  stub.passwordStores.set(null, new Map());
  duringRead = (id) => {
    if (id !== "chrome") return;
    telemetry.setSharing(false, "settings");
    telemetry.setSharing(true, "settings");
  };
  pick([chromium("chrome", "Chrome"), chromium("brave", "Brave")], ["chrome", "brave"]);
  continueImport("choose", turnNow());
  await until("done");
  sent = takeImportRuns();
  assert.deepEqual([sent.import_runs, sent.import_multi_runs, sent.import_multi_browsers], [0, 0, 0], "every turn carries the consent from Continue, which changed during the run");
});

test("a Safari file picker that answers after Safari was skipped reads nothing into the run", async () => {
  reads = { chrome: { bookmarks: [], tabs: [], credentials: [] } };
  const picked = deferred();
  native.chooseImportFile = () => picked.promise;
  let exports = 0;
  native.importSafariExport = async () => {
    exports += 1;
    return safariExport([cred("https://late.example/", "me", "late", now)]);
  };
  pick([SAFARI, chromium("chrome", "Chrome")], ["safari", "chrome"]);
  continueImport("choose", turnNow());
  await until("safari");
  const picking = pickSafariExport(turnNow());
  skipSource(turnNow());
  await until("done");
  picked.resolve("/tmp/late.zip");
  await picking;
  await settle();
  assert.equal(exports, 0);
  assert.deepEqual(storedLogins(), []);
});

test("a single Safari import whose writes are under way when a new run starts saves no password and leaves the new run alone", async () => {
  native.importSafariExport = async () => JSON.stringify({ ...JSON.parse(safariExport([cred("https://old.example/", "me", "stale", now)])), vaultToken: "vault-1" });
  native.listBrowsers = async () => JSON.stringify([chromium("chrome", "Chrome"), chromium("brave", "Brave")]);
  native.onWrite = () => flow.startImport(0);
  pick([SAFARI], ["safari"]);
  continueImport("choose", turnNow());
  await until("safari");
  await importSafariExport("/tmp/old.zip", turnNow());
  native.onWrite = () => {};
  await settle();
  assert.deepEqual(storedLogins(), [], "the old Safari password was never saved");
  reads = { chrome: { bookmarks: [], tabs: [], credentials: [] }, brave: { bookmarks: [], tabs: [], credentials: [] } };
  flow.useImportFlow.setState({ target: "default" });
  flow.pickSources(["chrome", "brave"]);
  continueImport("choose", turnNow());
  const done = await until("done");
  assert.deepEqual(done.sources.map((x) => x.name), ["Chrome", "Brave"]);
});

test("a second Skip for the same browser does nothing, and the run is counted once", async () => {
  reads = { chrome: { bookmarks: [], tabs: [], credentials: [] } };
  pick([chromium("chrome", "Chrome"), SAFARI], ["chrome", "safari"]);
  continueImport("choose", turnNow());
  await until("safari");
  skipSource(turnNow());
  skipSource(turnNow());
  const done = await until("done");
  await settle();
  assert.deepEqual(done.notes, ["Safari was skipped."]);
  assert.deepEqual(flow.useImportFlow.getState().run.outcomes.map((o) => o.source.id), ["chrome", "safari"]);
  const sent = takeImportRuns();
  assert.deepEqual([sent.import_multi_runs, sent.import_multi_browsers, sent.import_multi_skipped], [1, 2, 1]);
});

test("a second Continue on Choose doesn't carry a browser with several profiles past its profile step", async () => {
  const two = { ...chromium("chrome", "Chrome"), profiles: [chromium("chrome", "Chrome").profiles[0], { id: "Work", name: "Work", path: "w", isDefault: false, available: ["bookmarks"] }] };
  pick([two], ["chrome"]);
  continueImport("choose", turnNow());
  continueImport("choose", turnNow());
  assert.equal(step().name, "profiles");
  await settle();
  assert.deepEqual(readCalls, []);
});

test("an access check that answers after its browser was skipped never changes the browser list", async () => {
  reads = { chrome: { bookmarks: [], tabs: [], credentials: [] }, brave: { bookmarks: [], tabs: [], credentials: [] } };
  const answer = deferred();
  native.listBrowsers = () => answer.promise;
  pick([{ ...chromium("locked", "Locked"), needsFullDiskAccess: true }, chromium("chrome", "Chrome"), chromium("brave", "Brave")], ["locked", "chrome", "brave"]);
  continueImport("choose", turnNow());
  await until("access");
  const checking = recheckAccess(turnNow());
  skipSource(turnNow());
  answer.resolve(JSON.stringify([chromium("locked", "Locked"), chromium("chrome", "Chrome")]));
  await checking;
  const done = await until("done");
  assert.deepEqual(readCalls, ["chrome", "brave"]);
  assert.deepEqual(done.sources.map((x) => x.name), ["Chrome", "Brave"]);
  assert.deepEqual(flow.useImportFlow.getState().browsers.map((b) => b.id), ["locked", "chrome", "brave"]);
});

test("password saves are counted under the consent of the turn that read them, the choice under the consent when it's made", async () => {
  stub.passwordStores.get(null).set("https://bank.example\nme", { origin: "https://bank.example/", url: "https://bank.example", username: "me", password: "already", created: 1 });
  reads = {
    chrome: { bookmarks: [], tabs: [], credentials: [cred("https://bank.example/", "me", "a", now - DAY)] },
    brave: { bookmarks: [], tabs: [], credentials: [cred("https://bank.example/", "me", "b", now)] },
  };
  pick([chromium("chrome", "Chrome"), chromium("brave", "Brave")], ["chrome", "brave"]);
  continueImport("choose", turnNow());
  await until("conflicts");
  telemetry.setSharing(false, "settings");
  telemetry.setSharing(true, "settings");
  takeImportRuns();
  outcome.pickConflictVersions("chrome", step().token);
  await outcome.importChosenPasswords(step().token);
  const done = await until("done");
  assert.deepEqual(done.notes, ["1 password wasn't changed: Ardia already has a different one saved for that account."]);
  const sent = takeImportRuns();
  assert.deepEqual([sent.import_conflicts_browser, sent.import_passwords_kept_existing], [1, 0], "the kept password was read under the consent before the change");
});

test("a save refused for an account the profile doesn't have is a failure, not a password Ardia kept", async () => {
  reads = { chrome: { bookmarks: [], tabs: [], credentials: [cred("android://com.example.app", "me", "x", now)] }, brave: { bookmarks: [], tabs: [], credentials: [] } };
  pick([chromium("chrome", "Chrome"), chromium("brave", "Brave")], ["chrome", "brave"]);
  continueImport("choose", turnNow());
  const done = await until("done");
  assert.deepEqual(done.notes, []);
  assert.deepEqual(done.failures, [{ kind: "passwords", profiles: [], browser: "Chrome" }]);
  const sent = takeImportRuns();
  assert.deepEqual([sent.import_passwords_kept_existing, sent.import_passwords_not_saved], [0, 1]);
});

test("a Skip pressed for Safari, delivered again after Chrome's turn began, doesn't skip Chrome", async () => {
  reads = { brave: { bookmarks: [], tabs: [], credentials: [] } };
  pick([SAFARI, { ...chromium("chrome", "Chrome"), needsFullDiskAccess: true }, chromium("brave", "Brave")], ["safari", "chrome", "brave"]);
  continueImport("choose", turnNow());
  await until("safari");
  const safariToken = turnNow();
  skipSource(safariToken);
  assert.equal(step().name, "access");
  skipSource(safariToken);
  assert.equal(step().name, "access");
  assert.equal(flow.importNow().source.id, "chrome");
});

test("neither the Linux unlock entry nor a bare read starts an import from the profile step", async () => {
  const chrome = chromium("chrome", "Chrome");
  chrome.profiles.push({ id: "Work", name: "Work", path: "w", isDefault: false, available: ["bookmarks"] });
  reads = { chrome: { bookmarks: [], tabs: [], credentials: [] } };
  pick([chrome], ["chrome"]);
  continueImport("choose", turnNow());
  assert.equal(step().name, "profiles");
  await importUnlocked(turnNow(), flow.importNow().kinds, true);
  await runImport(flow.importNow().kinds, true);
  await settle();
  assert.deepEqual(readCalls, []);
});

test("a Safari read whose writes are under way when a new run starts adds no tab after it", async () => {
  const url = "https://old-safari.example/";
  native.importSafariDirect = async () => JSON.stringify({ ...JSON.parse(safariExport([])), tabs: [{ url, title: url, pinned: false, windowIndex: 0, active: false }], vaultToken: "vault-1" });
  native.onWrite = () => flow.startImport(0);
  flow.useImportFlow.setState({ safariCookies: true });
  pick([SAFARI], ["safari"]);
  continueImport("choose", turnNow());
  await until("safari");
  await importSafariDirect(turnNow());
  assert.equal(Object.values(S().tabs).some((tab) => tab.url === url), false);
});

test("a browser import whose native write ends after a new session started saves no password and opens no tab", async () => {
  const chrome = chromium("chrome", "Chrome");
  chrome.profiles[0].available.push("cookies");
  reads = { chrome: { bookmarks: [], tabs: ["https://old-tab.example/"], vaultToken: "vault-1", credentials: [cred("https://old-chrome.example/", "me", "old", now)] } };
  const written = deferred();
  native.onWrite = () => {
    flow.startImport(0);
    written.resolve();
  };
  pick([chrome], ["chrome"]);
  continueImport("choose", turnNow());
  await written.promise;
  await settle();
  assert.deepEqual(storedLogins(), []);
  assert.equal(Object.values(S().tabs).some((tab) => tab.url === "https://old-tab.example/"), false);
});

test("an access check that answers just as its browser is skipped never clears the next browser's access", async () => {
  const chrome = { ...chromium("chrome", "Chrome"), needsFullDiskAccess: true };
  const brave = { ...chromium("brave", "Brave"), needsFullDiskAccess: true };
  reads = { chrome: { bookmarks: [], tabs: [], credentials: [] }, brave: { bookmarks: [], tabs: [], credentials: [] } };
  const answer = deferred();
  native.listBrowsers = () => answer.promise;
  pick([chrome, brave], ["chrome", "brave"]);
  continueImport("choose", turnNow());
  await until("access");
  const chromeToken = turnNow();
  const checking = recheckAccess(chromeToken);
  answer.resolve(JSON.stringify([{ ...chrome, needsFullDiskAccess: false }, { ...brave, needsFullDiskAccess: false }]));
  queueMicrotask(() => queueMicrotask(() => skipSource(chromeToken)));
  await checking;
  const { source } = flow.importNow();
  if (source.id === "brave") assert.equal(source.needsFullDiskAccess, true, "the skipped browser's answer never reached Brave's turn");
  else assert.equal(source.id, "chrome");
});

test("a Safari export or a browser read that answers after its import ended gives its vault token back", async () => {
  const late = deferred();
  native.importSafariExport = () => late.promise;
  pick([SAFARI], ["safari"]);
  continueImport("choose", turnNow());
  await until("safari");
  const reading = importSafariExport("/tmp/late.zip", turnNow());
  flow.startImport(0);
  late.resolve(JSON.stringify({ ...JSON.parse(safariExport([])), vaultToken: "vault-safari" }));
  await reading;
  assert.deepEqual(discarded, ["vault-safari"]);

  reads = { chrome: { bookmarks: ["https://late.example/"], tabs: [], credentials: [], vaultToken: "vault-chrome" } };
  duringRead = () => flow.startImport(0);
  const chrome = chromium("chrome", "Chrome");
  chrome.profiles[0].available.push("cookies");
  pick([chrome], ["chrome"]);
  continueImport("choose", turnNow());
  await settle();
  assert.deepEqual(discarded, ["vault-safari", "vault-chrome"]);
});

test("Back drawn for Safari does nothing once Chrome's turn has begun", async () => {
  const two = { ...chromium("chrome", "Chrome"), profiles: [chromium("chrome", "Chrome").profiles[0], { id: "Work", name: "Work", path: "w", isDefault: false, available: ["bookmarks"] }] };
  pick([SAFARI, two], ["safari", "chrome"]);
  continueImport("choose", turnNow());
  await until("safari");
  const safariToken = turnNow();
  skipSource(safariToken);
  assert.equal(step().name, "profiles");
  flow.backTo("choose", safariToken);
  flow.toggleSourceProfile("Work", true, safariToken);
  assert.equal(step().name, "profiles");
  assert.deepEqual(flow.importNow().sourceProfiles, ["Default"]);
  assert.ok(flow.importNow().run);
});

test("only the latest keychain unlock may change the unlock step", async () => {
  reads = { chrome: { bookmarks: [], tabs: [], credentials: [] } };
  unlocked = false;
  const attempts = [deferred(), deferred()];
  let asked = 0;
  native.unlockBrowser = () => attempts[asked++].promise;
  const two = { ...chromium("chrome", "Chrome"), needsKeychain: true, profiles: [chromium("chrome", "Chrome").profiles[0], { id: "Work", name: "Work", path: "w", isDefault: false, available: ["bookmarks"] }] };
  pick([two], ["chrome"]);
  continueImport("choose", turnNow());
  continueImport("profiles", turnNow());
  assert.equal(step().name, "unlock");
  const first = unlockAndImport(turnNow());
  flow.backTo("profiles", turnNow());
  continueImport("profiles", turnNow());
  const second = unlockAndImport(turnNow());
  assert.equal(step().unlocking, true);
  attempts[0].resolve(Promise.reject(new Error("denied")));
  await first;
  assert.equal(step().name, "unlock");
  assert.equal(step().unlocking, true, "the first attempt's denial leaves the second waiting");
  assert.equal(step().error, null);
  attempts[1].resolve(null);
  await second;
  await until("done");
  assert.deepEqual(readCalls, ["chrome"]);
  native.unlockBrowser = async () => null;
});

test("while a run is live, the Choose screen's rows, kinds and Bookmarks HTML import change nothing", async () => {
  reads = { chrome: { bookmarks: ["https://chrome.example/"], tabs: [], credentials: [] }, brave: { bookmarks: [], tabs: [], credentials: [] } };
  pick([SAFARI, chromium("chrome", "Chrome")], ["safari", "chrome"]);
  continueImport("choose", turnNow());
  await until("safari");
  const live = flow.importNow();
  flow.toggleSource(chromium("chrome", "Chrome"));
  flow.pickSources([]);
  flow.chooseSource(chromium("chrome", "Chrome"));
  flow.toggleImportKind("bookmarks", false);
  assert.equal(step().name, "safari");
  assert.equal(flow.importNow().run, live.run);
  assert.equal(flow.importNow().kinds, live.kinds);

  const picked = deferred();
  native.chooseImportFile = () => picked.promise;
  let braveRead = deferred();
  duringRead = (id) => (id === "brave" ? braveRead.promise : undefined);
  pick([chromium("chrome", "Chrome"), chromium("brave", "Brave")], ["chrome", "brave"]);
  const html = importBookmarksHtml();
  continueImport("choose", turnNow());
  picked.resolve("/tmp/bookmarks.html");
  await html;
  await settle();
  assert.equal(step().name, "progress", "Chrome's progress and Brave's wait are left alone");
  assert.ok(flow.importNow().run);
  braveRead.resolve();
  const done = await until("done");
  assert.deepEqual(done.sources.map((x) => x.name), ["Chrome", "Brave"]);
  assert.equal(Object.values(S().bookmarks.nodes).some((n) => n.url === "https://html.example/"), false);
});

test("two Ardia profiles that share one password store are one account for conflicts", async () => {
  S().hydrate({});
  S().createWindow({ url: "https://start.example/" });
  useBrowser.setState((s) => ({
    profiles: { ...s.profiles, work: { ...s.profiles.default, id: "work", name: "Work", dataId: "default" } },
    profileOrder: [...s.profileOrder, "work"],
  }));
  const signal = new AbortController().signal;
  outcome.forgetCollectedLogins();
  outcome.collectLogins("chrome", null, [{ profileId: "default", credentials: [cred("https://bank.example/", "me", "chrome", now - DAY)] }]);
  outcome.collectLogins("edge", null, [{ profileId: "work", credentials: [cred("https://bank.example/", "me", "edge", now)] }]);
  const ran = (id, name) => ({ source: { id, name, family: "chromium" }, counts: emptyCounts(), failures: [], notes: [], extensions: { profileId: "", found: [], groups: [] }, engines: [], skipped: false, consent: null, passwordsWritten: { keptExisting: 0, failed: 0 } });
  flow.useImportFlow.setState({ run: { ids: ["chrome", "edge"], at: 1, chosen: [], offered: [], outcomes: [] } });
  await outcome.finishRun([ran("chrome", "Chrome"), ran("edge", "Edge")], signal);
  const conflicts = await until("conflicts");
  assert.equal(conflicts.conflicts.length, 1);
  assert.deepEqual(conflicts.conflicts[0].profileIds, ["default", "work"]);
  assert.deepEqual(storedLogins(), []);
});
