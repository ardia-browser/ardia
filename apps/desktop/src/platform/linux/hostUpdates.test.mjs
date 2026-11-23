import assert from "node:assert/strict";
import test from "node:test";
import { CHECK_EVERY_MS, FIRST_CHECK_AFTER_MS, UPDATE_CHECK_LOCK, UPDATE_PREFERENCES, WATCH_EVERY_MS, installsUpdates, linuxUpdater, scheduleUpdateChecks } from "./hostUpdates.ts";
import { SELF_UPDATE_METHODS } from "../../hostCapabilities.ts";
import { compareVersions, linuxReleases, newestRelease } from "./updateReleases.ts";
import { takeUpdateCounts } from "../../../../browser/src/state/telemetry/updateCounts.ts";
import { setConsentPeriod } from "../../../../browser/src/state/telemetry/consentPeriod.ts";

setConsentPeriod(true, "host-updates-test");

const page = (tag) => `https://github.com/ardia-browser/ardia/releases/tag/${tag}`;
const release = (tag, { prerelease = false, draft = false, assets = [`Ardia-${tag.replace(/^v/, "")}-linux-x64.tar.xz`] } = {}) =>
  ({ tag_name: tag, html_url: page(tag), prerelease, draft, assets: assets.map((name) => ({ name })) });
const LIST = [
  release("engine-0be922b5d707", { prerelease: true, assets: ["ArdiaCore-0be922b5d707-linux-x64.tar.xz"] }),
  release("v0.2.47-nightly.3", { prerelease: true }),
  release("v0.2.47-nightly.2", { prerelease: true }),
  release("v0.2.46", { assets: ["Ardia-0.2.46.dmg", "Ardia-0.2.46-linux-x64.tar.xz", "Ardia-0.2.46-linux-x64.deb"] }),
  release("v0.2.48", { assets: ["Ardia-0.2.48.dmg"] }),
  release("v0.2.49", { draft: true }),
  { ...release("v0.2.50"), html_url: "https://evil.example/ardia" },
];

test("release tags compare by version, nightly builds before their stable release", () => {
  assert.equal(compareVersions("0.2.46", "0.2.46-nightly.9"), 1);
  assert.equal(compareVersions("0.2.47-nightly.2", "0.2.46"), 1);
  assert.equal(compareVersions("0.2.47-nightly.10", "0.2.47-nightly.9"), 1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.2.46", "0.2.46"), 0);
});

test("only published releases with a Linux package and a GitHub release page count, newest per channel", () => {
  const releases = linuxReleases(JSON.stringify(LIST));
  assert.deepEqual(releases.map((r) => r.version), ["0.2.47-nightly.3", "0.2.47-nightly.2", "0.2.46"]);
  assert.equal(newestRelease(releases, "stable")?.version, "0.2.46");
  assert.equal(newestRelease(releases, "nightly")?.version, "0.2.47-nightly.3");
  assert.throws(() => linuxReleases("{}"), /not a list/);
});

function fakeEngine({ kind = "deb", fail = null, failWhile = "downloading" } = {}) {
  const engine = { phase: "idle", version: null, reason: null, kind, run: 0, claims: [], updates: [], restarts: 0, unansweredClaims: 0 };
  const status = () => ({ phase: engine.phase, version: engine.version, reason: engine.reason, kind: engine.kind, run: engine.run });
  engine.status = status;
  engine.update = (version) => {
    engine.updates.push(version);
    if (engine.phase === "downloading" || engine.phase === "installing") return status();
    if (engine.phase === "ready") return status();
    Object.assign(engine, { phase: "downloading", version, reason: null, run: engine.run + 1 });
    return status();
  };
  engine.advance = () => {
    if (fail && engine.phase === failWhile) Object.assign(engine, { phase: "failed", reason: fail });
    else if (engine.phase === "downloading") engine.phase = "installing";
    else if (engine.phase === "installing") engine.phase = "ready";
  };
  engine.finish = () => {
    while (engine.phase === "downloading" || engine.phase === "installing") engine.advance();
  };
  engine.claim = (run) => {
    if (engine.unansweredClaims > 0) {
      engine.unansweredClaims--;
      throw new Error("the claim call failed");
    }
    const answer = run === engine.run && (engine.phase === "ready" || engine.phase === "failed") && !engine.claims.includes(run);
    if (answer) engine.claims.push(run);
    return answer;
  };
  return engine;
}

function lockManager() {
  const tails = new Map();
  return {
    request: (name, callback) => {
      const run = (tails.get(name) ?? Promise.resolve()).then(() => callback());
      tails.set(name, run.catch(() => {}));
      return run;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness({ version = "0.2.45", body = JSON.stringify(LIST), status = 200, launch = {}, capabilities = ["ArdiaUpdates.releases"], disk, engine, locks, slowDisk = false, wait, showsToasts } = {}) {
  const docs = new Map();
  const seen = { asked: [], told: [], offered: [], offeredInstalls: [], ready: [], managed: [], opened: [], requests: 0, statuses: 0 };
  const host = {
    bootstrap: { launchConfig: launch, capabilities: engine ? [...capabilities, ...SELF_UPDATE_METHODS] : capabilities },
    invoke: async (method, { args }) => {
      if (method === "ArdiaUpdates.status") return (seen.statuses++, engine.status());
      if (method === "ArdiaUpdates.update") return engine.update(...args);
      if (method === "ArdiaUpdates.claimOutcome") return engine.claim(...args);
      if (method === "ArdiaUpdates.restart") return (engine.restarts++, true);
      assert.equal(method, "ArdiaUpdates.releases");
      seen.requests++;
      return { status, body };
    },
  };
  const updater = linuxUpdater({
    host,
    appVersion: () => version,
    read: (name) => docs.get(name) ?? null,
    write: async (name, contents) => {
      if (slowDisk) await tick();
      docs.set(name, contents);
      disk?.set(name, contents);
    },
    refresh: async (name) => {
      if (slowDisk) await tick();
      if (disk?.has(name)) docs.set(name, disk.get(name));
    },
    ask: async (r, current, failed) => (seen.asked.push(failed ? [r.version, current, "failed"] : [r.version, current]), true),
    tell: async (title) => void seen.told.push(title),
    offer: (r, failed) => void seen.offered.push(failed ? `${r.version} failed` : r.version),
    offerInstall: (r, run) => void seen.offeredInstalls.push({ version: r.version, run }),
    ready: (v, restart) => void seen.ready.push({ version: v, restart }),
    managed: async (r, current, asked) => void seen.managed.push([r.version, current, asked]),
    open: (url) => void seen.opened.push(url),
    showsToasts,
    locks,
    wait: wait ?? (async () => (engine?.advance(), tick())),
    now: () => 1_000,
  });
  return { updater, docs, seen, host };
}

const settled = async (until) => {
  for (let i = 0; i < 100 && !until(); i++) await tick();
  assert.ok(until(), "the update flow settled");
};

const SELF_UPDATE_COUNTS = (counts) => Object.fromEntries(Object.entries(counts).filter(([field, n]) => /^update_(downloads?|installs?|install_failures|download_failures|restarts)/.test(field) && n));

test("Check Now finds the newest stable Linux release, offers its page and records the check", async () => {
  takeUpdateCounts();
  const { updater, docs, seen } = harness();
  await updater.methods.checkForUpdates();
  assert.deepEqual(seen.asked, [["0.2.46", "0.2.45"]]);
  assert.deepEqual(seen.opened, [page("v0.2.46")]);
  const state = await updater.methods.updaterState();
  assert.equal(state.configured, true);
  assert.equal(state.lastCheck, 1_000);
  assert.deepEqual(state.switchCheck, { phase: "found", channel: "stable", version: "0.2.46" });
  assert.equal(state.automaticDownloads, false);
  assert.equal(JSON.parse(docs.get(UPDATE_PREFERENCES)).lastCheck, 1_000);
  const counts = takeUpdateCounts();
  assert.equal(counts.update_checks_asked, 1);
  assert.equal(counts.update_checks_found, 1);
  assert.equal(counts.update_release_page_opens, 1);
});

test("a nightly build follows nightly releases, and switching channel checks again", async () => {
  const { updater, seen } = harness({ version: "0.2.47-nightly.2" });
  assert.equal((await updater.methods.updaterState()).channel, "nightly");
  await updater.methods.checkForUpdates();
  assert.deepEqual(seen.asked.at(-1), ["0.2.47-nightly.3", "0.2.47-nightly.2"]);
  await updater.methods.setUpdateChannel("stable");
  assert.equal((await updater.methods.updaterState()).channel, "stable");
  assert.deepEqual(seen.told, ["Ardia is up to date"], "0.2.46 is older than this nightly");
});

test("an automatic check offers a new release once and never opens a dialog", async () => {
  const { updater, seen } = harness();
  await updater.check(false);
  await updater.check(false);
  assert.deepEqual(seen.offered, ["0.2.46"]);
  assert.deepEqual(seen.asked, []);
});

test("a failed check says so when asked, counts the failure and shows failed in Settings", async () => {
  takeUpdateCounts();
  const { updater, seen } = harness({ status: 0, body: "" });
  await updater.methods.checkForUpdates();
  assert.deepEqual(seen.told, ["Ardia couldn't check for updates"]);
  assert.equal((await updater.methods.updaterState()).switchCheck.phase, "failed");
  assert.equal(takeUpdateCounts().update_check_failures, 1);
});

test("a dev build without a release version isn't set up to update and never asks GitHub", async () => {
  const { updater, seen } = harness({ version: "157.0.8103.50" });
  assert.equal((await updater.methods.updaterState()).configured, false);
  await updater.methods.checkForUpdates();
  assert.equal(seen.requests, 0);
  assert.equal(await updater.checksByItself(), false);
});

test("automatic checks stay off in hidden instances and when turned off, and run in one window only", async () => {
  assert.equal(await harness({ launch: { background: true } }).updater.checksByItself(), false);
  const { updater } = harness();
  assert.equal(await updater.checksByItself(), true);
  await updater.methods.setAutomaticUpdateChecks(false);
  assert.equal(await updater.checksByItself(), false);
  const requested = [];
  const timers = { setTimeout: (fn, ms) => requested.push(["timeout", ms]), setInterval: (fn, ms) => requested.push(["interval", ms]) };
  scheduleUpdateChecks(updater, { locks: { request: (name, callback) => (requested.push(["lock", name]), callback(), new Promise(() => {})) }, timers });
  assert.deepEqual(requested, [["lock", UPDATE_CHECK_LOCK], ["timeout", FIRST_CHECK_AFTER_MS], ["interval", CHECK_EVERY_MS], ["interval", WATCH_EVERY_MS]]);
});

test("turning automatic checks off or switching channel in the Settings window reaches the window that checks, and its next check keeps both", async () => {
  const disk = new Map();
  const browser = harness({ disk });
  const settings = harness({ disk });
  assert.equal(await browser.updater.checksByItself(), true);
  await settings.updater.methods.setAutomaticUpdateChecks(false);
  assert.equal(await browser.updater.checksByItself(), false);
  await browser.updater.check(false);
  assert.equal(browser.seen.requests, 0, "a scheduled check reads the switch again before it asks GitHub");
  await settings.updater.methods.setUpdateChannel("nightly");
  assert.equal((await browser.updater.methods.updaterState()).channel, "nightly");
  await browser.updater.methods.checkForUpdates();
  assert.deepEqual(browser.seen.asked.at(-1), ["0.2.47-nightly.3", "0.2.45"]);
  const saved = JSON.parse(disk.get(UPDATE_PREFERENCES));
  assert.equal(saved.automaticChecks, false, "recording the check doesn't write the old switch back");
  assert.equal(saved.channel, "nightly");
  assert.equal(saved.lastCheck, 1_000);
});

test("a launch started with --no-sandbox says why once, in the window that ran the launch, and counts it", async () => {
  const { noticeUnsandboxedLaunch, sandboxNotice } = await import("./sandboxNotice.ts");
  assert.equal(sandboxNotice(undefined), null);
  const reason = "Ardia was started with --no-sandbox";
  assert.equal(sandboxNotice(reason).message, "Ardia was started with --no-sandbox. Start Ardia without --no-sandbox to turn the sandbox back on.");
  assert.match(sandboxNotice("--no-sandbox was passed to chrome directly").message, /^--no-sandbox was passed to chrome directly\. Start Ardia without --no-sandbox/);
  takeUpdateCounts();
  const shown = [];
  const host = { bootstrap: { sandboxDecision: reason } };
  const noIntro = { open: () => false, closed: () => Promise.resolve() };
  assert.equal(await noticeUnsandboxedLaunch(host, "w1", Promise.resolve("alreadyDone"), (...args) => shown.push(args), noIntro), false);
  assert.equal(await noticeUnsandboxedLaunch({ bootstrap: {} }, "w1", Promise.resolve("ran"), (...args) => shown.push(args), noIntro), false);
  let close;
  const intro = { open: () => true, closed: () => new Promise((resolve) => (close = resolve)) };
  const pending = noticeUnsandboxedLaunch(host, "w1", Promise.resolve("ran"), (...args) => shown.push(args), intro);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(shown, [], "the first-run onboarding covers toasts, so the notice waits for it to close");
  close();
  assert.equal(await pending, true);
  assert.deepEqual(shown.map(([windowId, title]) => [windowId, title]), [["w1", "Ardia is running without Chromium's sandbox"]]);
  assert.equal(takeUpdateCounts().launches_without_sandbox, 1);
});

test("only the telemetry leader counts login-password confirmations, by outcome, and polkit's are left out", async () => {
  const { countLoginPasswordChecks } = await import("../../reauthCounts.ts");
  takeUpdateCounts();
  let emit;
  let leading = false;
  countLoginPasswordChecks(() => leading, (listener) => (emit = listener));
  emit({ method: "loginPassword", result: "granted" });
  leading = true;
  for (const result of ["granted", "denied", "denied", "cancelled", "unavailable"]) emit({ method: "loginPassword", result });
  emit({ method: "polkit", result: "granted" });
  const counts = takeUpdateCounts();
  assert.deepEqual([counts.login_password_checks_granted, counts.login_password_checks_denied, counts.login_password_checks_cancelled], [1, 2, 1]);
});

test("with self-update, an automatic check starts the engine's run, follows it to ready, says so once, and Check Now restarts", async () => {
  takeUpdateCounts();
  const engine = fakeEngine({ kind: "deb" });
  const { updater, seen, host } = harness({ engine });
  assert.equal((await updater.methods.updaterState()).automaticDownloads, true, "self-update turns the shared toggle on by default");
  assert.equal(installsUpdates(host), true, "Settings shows Automatically update Ardia");
  await updater.check(false);
  await settled(() => seen.ready.length === 1);
  assert.deepEqual(engine.updates, ["0.2.46"]);
  assert.deepEqual(seen.ready.map((r) => r.version), ["0.2.46"]);
  assert.deepEqual([seen.asked, seen.offered, seen.opened], [[], [], []], "no release page while self-update works");
  assert.deepEqual((await updater.methods.updaterState()).switchCheck, { phase: "ready", channel: "stable", version: "0.2.46" });
  assert.equal(await updater.menuItem(), "restart");
  await updater.methods.checkForUpdates();
  assert.equal(engine.restarts, 1);
  assert.equal(seen.requests, 1, "Restart to Update doesn't check again");
  seen.ready[0].restart();
  await settled(() => engine.restarts === 2);
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), { update_downloads_started: 1, update_downloads_finished: 1, update_installs_deb: 1, update_restarts: 2 });
});

test("Check Now starts the run and answers at once; Settings shows the engine's progress", async () => {
  const engine = fakeEngine({ kind: "tarball" });
  const { updater, seen } = harness({ engine, wait: () => new Promise(() => {}) });
  await updater.methods.checkForUpdates();
  const state = await updater.methods.updaterState();
  assert.deepEqual([state.switchCheck, state.sessionInProgress, state.canCheck], [{ phase: "downloading", channel: "stable", version: "0.2.46" }, true, false]);
  engine.advance();
  assert.deepEqual((await updater.methods.updaterState()).switchCheck, { phase: "installing", channel: "stable", version: "0.2.46" });
  assert.deepEqual(seen.asked, [], "no dialog");
});

test("closing Settings mid-run loses nothing: the engine finishes, and the leader claims it and says it's ready exactly once", async () => {
  takeUpdateCounts();
  const engine = fakeEngine({ kind: "deb" });
  const settings = harness({ engine, wait: () => new Promise(() => {}) });
  const leader = harness({ engine });
  const other = harness({ engine });
  await settings.updater.methods.checkForUpdates();
  assert.equal(engine.phase, "downloading");
  engine.finish();
  for (const window of [leader, other]) await window.updater.watch();
  assert.deepEqual([leader.seen.ready, other.seen.ready], [[], []], "a finished run waits one more look, so the window that started it can claim it first");
  for (const window of [leader, other, leader, other]) await window.updater.watch();
  assert.deepEqual(leader.seen.ready.map((r) => r.version), ["0.2.46"]);
  assert.deepEqual(other.seen.ready, [], "exactly one window claims the run");
  assert.deepEqual(engine.claims, [1]);
  assert.deepEqual((await other.updater.methods.updaterState()).switchCheck, { phase: "ready", channel: "stable", version: "0.2.46" }, "every window shows ready");
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), { update_downloads_started: 1, update_downloads_finished: 1, update_installs_deb: 1 });
});

test("a claim call that fails leaves the run for the next look, so its toast and counts aren't lost", async () => {
  takeUpdateCounts();
  const engine = fakeEngine({ kind: "deb" });
  const leader = harness({ engine });
  await engine.update("0.2.46");
  engine.finish();
  engine.unansweredClaims = 1;
  for (let i = 0; i < 2; i++) await leader.updater.watch();
  assert.deepEqual([leader.seen.ready, engine.claims], [[], []]);
  await leader.updater.watch();
  assert.deepEqual(leader.seen.ready.map((r) => r.version), ["0.2.46"]);
  assert.deepEqual(engine.claims, [1]);
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), { update_downloads_started: 1, update_downloads_finished: 1, update_installs_deb: 1 });
});

test("a restart whose claim call fails leaves the run for a later claim, so its counts aren't lost", async () => {
  takeUpdateCounts();
  const engine = fakeEngine({ kind: "deb" });
  const leader = harness({ engine });
  await engine.update("0.2.46");
  engine.finish();
  engine.unansweredClaims = 1;
  await leader.updater.restartWhenReady();
  assert.deepEqual([engine.restarts, engine.claims], [1, []]);
  await leader.updater.restartWhenReady();
  assert.deepEqual([engine.restarts, engine.claims], [2, [1]]);
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), { update_downloads_started: 1, update_downloads_finished: 1, update_installs_deb: 1, update_restarts: 2 });
});

test("Settings left open never claims a finished update, so a browser window says it's ready", async () => {
  takeUpdateCounts();
  const engine = fakeEngine({ kind: "deb" });
  const settings = harness({ engine, showsToasts: false });
  const leader = harness({ engine });
  await settings.updater.methods.checkForUpdates();
  await settled(() => engine.phase === "ready");
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(engine.claims, [], "Settings leaves the ready run unclaimed");
  assert.deepEqual((await settings.updater.methods.updaterState()).switchCheck, { phase: "ready", channel: "stable", version: "0.2.46" });
  for (let i = 0; i < 2; i++) await leader.updater.watch();
  assert.deepEqual(leader.seen.ready.map((r) => r.version), ["0.2.46"]);
  assert.deepEqual(engine.claims, [1]);
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), { update_downloads_started: 1, update_downloads_finished: 1, update_installs_deb: 1 });
});

test("restarting from Settings before a browser window claims the update still counts it, and checking while ready says so without restarting", async () => {
  takeUpdateCounts();
  const engine = fakeEngine({ kind: "tarball" });
  const settings = harness({ engine, showsToasts: false });
  await settings.updater.methods.checkForUpdates();
  await settled(() => engine.phase === "ready");
  const browser = harness({ engine });
  await browser.updater.check(true);
  assert.deepEqual([browser.seen.ready.map((r) => r.version), engine.restarts], [["0.2.46"], 0], "Check for Updates while ready says it's ready and never restarts");
  const offline = harness({ engine, status: 503 });
  await offline.updater.check(true);
  assert.deepEqual([offline.seen.ready.map((r) => r.version), offline.seen.told, offline.seen.requests], [["0.2.46"], [], 0], "a ready update is shown before GitHub is asked, so a failed check can't hide it");
  await settings.updater.methods.checkForUpdates();
  assert.equal(engine.restarts, 0, "a Check Now drawn before the update was ready checks instead of restarting");
  assert.equal((await settings.updater.methods.updaterState()).switchCheck?.phase, "ready");
  await settings.updater.methods.checkForUpdates();
  assert.equal(engine.restarts, 1, "Restart to Update restarts");
  assert.deepEqual(engine.claims, [1]);
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), { update_downloads_started: 1, update_downloads_finished: 1, update_installs_tarball: 1, update_restarts: 1 });
});

test("the app menu reads the engine fresh, so it offers Restart to Update after another window's install, and a later check never starts another run", async () => {
  const engine = fakeEngine({ kind: "appimage" });
  const first = harness({ engine });
  const second = harness({ engine });
  assert.equal(await second.updater.menuItem(), "check");
  await first.updater.check(false);
  await settled(() => first.seen.ready.length === 1);
  assert.equal(await second.updater.menuItem(), "restart");
  await second.updater.check(false);
  await first.updater.check(false);
  assert.deepEqual(engine.updates, ["0.2.46"], "a ready update is never downloaded again");
  await second.updater.methods.checkForUpdates();
  assert.equal(engine.restarts, 0, "a Check Now drawn before the update was ready never restarts");
  await second.updater.restartWhenReady();
  assert.equal(engine.restarts, 1, "the menu's Restart to Update restarts");
});

test("with automatic updates off, the automatic check offers the update once, and Update starts the same run", async () => {
  takeUpdateCounts();
  const engine = fakeEngine({ kind: "appimage" });
  const { updater, seen } = harness({ engine });
  await updater.methods.setAutomaticUpdateDownloads(false);
  assert.equal((await updater.methods.updaterState()).automaticDownloads, false);
  await updater.check(false);
  await updater.check(false);
  assert.deepEqual(seen.offeredInstalls.map((o) => o.version), ["0.2.46"], "offered once");
  assert.deepEqual(engine.updates, []);
  seen.offeredInstalls[0].run();
  await settled(() => seen.ready.length === 1);
  assert.deepEqual(engine.updates, ["0.2.46"]);
  assert.equal(takeUpdateCounts().update_installs_appimage, 1);
});

test("an install the package manager owns says to update there, and never opens the release page", async () => {
  const engine = fakeEngine({ kind: "managed" });
  const { updater, seen, host } = harness({ engine });
  await updater.methods.checkForUpdates();
  await updater.check(false);
  await updater.check(false);
  assert.deepEqual(seen.managed, [["0.2.46", "0.2.45", true], ["0.2.46", "0.2.45", false]]);
  assert.deepEqual([seen.asked, seen.offered, seen.opened, engine.updates], [[], [], [], []]);
  assert.equal((await updater.methods.updaterState()).automaticDownloads, false);
  assert.equal(installsUpdates(host), false, "Settings hides Automatically update Ardia");
});

test("an install that can't update itself, and an engine without self-update, keep the release page", async () => {
  for (const engine of [fakeEngine({ kind: "unsupported noPkexec" }), undefined]) {
    const { updater, seen, host } = harness({ engine });
    await updater.methods.checkForUpdates();
    await updater.check(false);
    assert.deepEqual(seen.asked, [["0.2.46", "0.2.45"]]);
    assert.deepEqual(seen.opened, [page("v0.2.46")]);
    assert.deepEqual(seen.offered, ["0.2.46"]);
    assert.deepEqual([seen.ready, seen.managed, engine?.updates ?? []], [[], [], []]);
    assert.equal((await updater.methods.updaterState()).automaticDownloads, false);
    assert.equal(installsUpdates(host), false);
    if (!engine) assert.equal(seen.statuses, 0, "an old engine is never asked for its update status");
  }
});

test("a failed run falls back to the release page in the window that claims it, once per version, and counts why", async () => {
  takeUpdateCounts();
  const offline = fakeEngine({ kind: "deb", fail: "network" });
  const asking = harness({ engine: offline });
  await asking.updater.methods.checkForUpdates();
  await settled(() => asking.seen.opened.length === 1);
  assert.deepEqual(asking.seen.asked, [["0.2.46", "0.2.45", "failed"]]);
  assert.deepEqual(asking.seen.opened, [page("v0.2.46")]);
  assert.deepEqual((await asking.updater.methods.updaterState()).switchCheck, { phase: "found", channel: "stable", version: "0.2.46" });
  const refused = fakeEngine({ kind: "tarball", fail: "polkit", failWhile: "installing" });
  const automatic = harness({ engine: refused });
  await automatic.updater.check(false);
  await settled(() => automatic.seen.offered.length === 1);
  await automatic.updater.check(false);
  assert.deepEqual(automatic.seen.offered, ["0.2.46 failed"], "an automatic failure offers the page once");
  assert.deepEqual(refused.updates, ["0.2.46"], "and doesn't retry the same release by itself");
  const busyInstall = fakeEngine({ kind: "appimage", fail: "busy", failWhile: "installing" });
  const watched = harness({ engine: busyInstall });
  await watched.updater.check(false);
  await settled(() => watched.seen.offered.length === 1);
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), {
    update_downloads_started: 3,
    update_downloads_finished: 2,
    update_download_failures_network: 1,
    update_install_failures_polkit: 1,
    update_install_failures_busy: 1,
  });
});

test("self-update counts nothing while sharing is off", async () => {
  takeUpdateCounts();
  setConsentPeriod(false, null);
  try {
    const engine = fakeEngine({ kind: "deb" });
    const { updater, seen } = harness({ engine });
    await updater.check(false);
    await settled(() => seen.ready.length === 1);
    seen.ready[0].restart();
    await settled(() => engine.restarts === 1);
    const failing = harness({ engine: fakeEngine({ kind: "deb", fail: "disk" }) });
    await failing.updater.check(false);
    await settled(() => failing.seen.offered.length === 1);
  } finally {
    setConsentPeriod(true, "host-updates-test");
  }
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), {});
});

test("two windows changing update preferences at once both keep their change", async () => {
  const race = async (locks) => {
    const disk = new Map([[UPDATE_PREFERENCES, JSON.stringify({ channel: "stable" })]]);
    const browser = harness({ disk, locks, slowDisk: true });
    const settings = harness({ disk, locks, slowDisk: true });
    await Promise.all([browser.updater.methods.setAutomaticUpdateChecks(false), settings.updater.methods.setAutomaticUpdateDownloads(false)]);
    const saved = JSON.parse(disk.get(UPDATE_PREFERENCES));
    return [saved.automaticChecks, saved.automaticDownloads];
  };
  assert.notDeepEqual(await race(undefined), [false, false], "without the lock one change is lost");
  assert.deepEqual(await race(lockManager()), [false, false]);
});
