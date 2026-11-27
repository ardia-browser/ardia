import assert from "node:assert/strict";
import test from "node:test";
import {
  CHECK_EVERY_MS,
  FIRST_CHECK_AFTER_MS,
  UPDATE_CHECK_LOCK,
  UPDATE_PREFERENCES,
  UPDATE_RUN_LOCK,
  WATCH_EVERY_MS,
  WINDOWS_RELEASE_PAGE,
  WINDOWS_UPDATE_METHODS,
  installsUpdates,
  readCheckAnswer,
  readEngineStatus,
  scheduleUpdateChecks,
  updatesAvailable,
  windowsUpdater,
} from "./hostUpdates.ts";
import { SELF_UPDATE_METHODS } from "../../hostCapabilities.ts";
import { takeUpdateCounts } from "../../../../browser/src/state/telemetry/updateCounts.ts";
import { consentToken, setConsentPeriod } from "../../../../browser/src/state/telemetry/consentPeriod.ts";
import { windowsUpdateCounts } from "../../../../browser/src/platform/windowsUpdateCounts.win.ts";
import { HOSTILE_VALUES } from "../../../../../scripts/security/hostile-inputs.mjs";

setConsentPeriod(true, "windows-updates-test");
windowsUpdateCounts.setConsentEpoch("windows-updates-test");

const CURRENT = { version: "0.2.45", build: 7000 };
const OFFER = { version: "0.2.46", build: 7100, bytes: 180 * 1024 * 1024 };

function fakeEngine({ kind = "installer", current = CURRENT, answer = { status: "ok", ...OFFER }, failWith = null, background = false, isolated = false, testFeed = false, launches = true, instant = false } = {}) {
  const engine = { phase: "idle", offer: null, reason: null, run: 0, claimed: false, kind, current, background, isolated, testFeed, answer, checks: 0, updates: [], restarts: 0, claims: [] };
  engine.status = () => ({
    phase: engine.phase,
    kind: engine.kind,
    reason: engine.reason,
    run: engine.run,
    version: engine.offer?.version ?? null,
    build: engine.offer?.build ?? null,
    bytes: engine.offer?.bytes ?? null,
    current: engine.current,
    background: engine.background,
    isolated: engine.isolated,
    testFeed: engine.testFeed,
  });
  engine.check = () => {
    engine.checks++;
    if (["checking", "downloading", "ready"].includes(engine.phase)) return { status: "busy" };
    const reply = typeof engine.answer === "function" ? engine.answer() : engine.answer;
    if (reply?.status === "ok") Object.assign(engine, { phase: "available", offer: { version: reply.version, build: reply.build, bytes: reply.bytes }, reason: null });
    else if (reply?.status === "upToDate" || reply?.status === "notPublished") Object.assign(engine, { phase: "upToDate", offer: null, reason: null });
    else Object.assign(engine, { phase: "idle", offer: null, reason: reply?.reason ?? "other" });
    return reply;
  };
  engine.update = (build) => {
    engine.updates.push(build);
    const starts = engine.kind === "installer" && engine.phase === "available" && engine.offer?.build === build;
    if (starts) Object.assign(engine, { phase: instant ? "ready" : "downloading", run: engine.run + 1, claimed: false, reason: null });
    return { ...engine.status(), started: starts };
  };
  engine.advance = () => {
    if (engine.phase !== "downloading") return;
    if (failWith) Object.assign(engine, { phase: "failed", reason: failWith });
    else engine.phase = "ready";
  };
  engine.claim = (run) => {
    const answer = run === engine.run && !engine.claimed && (engine.phase === "ready" || engine.phase === "failed");
    if (answer) {
      engine.claimed = true;
      engine.claims.push(run);
    }
    return answer ? engine.status() : false;
  };
  engine.installing = false;
  engine.launched = 0;
  engine.restart = async () => {
    engine.restarts++;
    if (engine.phase === "ready" && engine.installing) return "busy";
    if (engine.phase === "ready" && launches && !engine.background) {
      engine.installing = true;
      await tick();
      engine.launched++;
      return true;
    }
    if (!launches || engine.phase !== "ready" || engine.background) {
      if (engine.phase === "ready" && !engine.background) Object.assign(engine, { phase: "failed", reason: "checksum", claimed: false });
      return false;
    }
    return true;
  };
  return engine;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

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

function harness({ engine = fakeEngine(), capabilities = WINDOWS_UPDATE_METHODS, showsToasts, docs = new Map(), answers = true, locks, write } = {}) {
  const seen = { asked: [], told: [], offered: [], offeredInstalls: [], ready: [], opened: [], calls: [] };
  const host = {
    bootstrap: { windowId: "main", capabilities: [...capabilities] },
    invoke: async (method, { args }) => {
      seen.calls.push([method, ...args]);
      if (method === "ArdiaUpdates.status") return engine.status();
      if (method === "ArdiaUpdates.check") return engine.check();
      if (method === "ArdiaUpdates.update") return engine.update(...args);
      if (method === "ArdiaUpdates.claimOutcome") return engine.claim(...args);
      if (method === "ArdiaUpdates.restart") return engine.restart();
      throw new Error(`unexpected ${method}`);
    },
  };
  const updater = windowsUpdater({
    host,
    read: (name) => docs.get(name) ?? null,
    write: write ?? (async (name, contents) => void docs.set(name, contents)),
    pointToRelease: (title, message) => {
      seen.asked.push({ title, message });
      if (answers) seen.opened.push(WINDOWS_RELEASE_PAGE);
    },
    tell: async (title, message) => void seen.told.push({ title, message }),
    offer: (update, failed) => void seen.offered.push(failed ? `${update.build} failed` : `${update.build}`),
    offerInstall: (update, install) => void seen.offeredInstalls.push({ build: update.build, install }),
    ready: (update, restart) => void seen.ready.push({ build: update.build, restart }),
    open: (url) => void seen.opened.push(url),
    showsToasts,
    locks,
    wait: async () => (engine.advance(), tick()),
    now: () => 1_000,
  });
  return { updater, engine, seen, docs, host };
}

const settled = async (until) => {
  for (let i = 0; i < 100 && !until(); i++) await tick();
  assert.ok(until(), "the update flow settled");
};

const SELF_UPDATE_COUNTS = (counts) => Object.fromEntries(Object.entries(counts).filter(([field, n]) => /^update_(downloads?|installs?|install_failures|download_failures|restarts)/.test(field) && n));

test("the Windows WebUI updater needs every ArdiaUpdates call, the Linux five plus check", () => {
  assert.deepEqual(WINDOWS_UPDATE_METHODS, [...SELF_UPDATE_METHODS, "ArdiaUpdates.check"]);
  assert.equal(updatesAvailable(harness().host), true);
  assert.equal(updatesAvailable(harness({ capabilities: SELF_UPDATE_METHODS }).host), false, "an engine without ArdiaUpdates.check is not the Windows updater");
  assert.equal(updatesAvailable(harness({ capabilities: WINDOWS_UPDATE_METHODS.slice(1) }).host), false);
});

test("Check Now verifies the feed, downloads the newer build and offers Restart, counting each step", async () => {
  takeUpdateCounts();
  windowsUpdateCounts.takeCounts();
  const { updater, engine, seen, docs, host } = harness();
  await updater.methods.checkForUpdates();
  await settled(() => seen.ready.length === 1);
  assert.deepEqual(engine.updates, [OFFER.build], "the renderer names only the verified build, never a URL or hash");
  assert.ok(seen.calls.every(([, ...args]) => args.every((arg) => typeof arg === "number")), "no call carries text from the feed");
  assert.equal(seen.ready[0].build, OFFER.build);
  assert.equal(installsUpdates(host), true);
  const state = await updater.methods.updaterState();
  assert.equal(state.configured, true);
  assert.equal(state.displayVersion, "0.2.45, Windows alpha 7000");
  assert.deepEqual(state.switchCheck, { phase: "ready", channel: "stable", version: OFFER.version });
  assert.equal(state.channel, undefined, "Windows has one feed, so Settings shows no channel picker");
  assert.equal(JSON.parse(docs.get(UPDATE_PREFERENCES)).lastCheck, 1_000);
  assert.equal(await updater.menuItem(), "restart");
  const counts = takeUpdateCounts();
  assert.equal(counts.update_checks_asked, 1);
  assert.equal(counts.update_checks_found, 1);
  assert.deepEqual(SELF_UPDATE_COUNTS(counts), { update_downloads_started: 1, update_downloads_finished: 1 });
  assert.equal(windowsUpdateCounts.takeCounts()["windows-updates-test"].verified, 1);
});

test("Restart to Update claims the run, counts the restart and asks the engine to run the installer", async () => {
  takeUpdateCounts();
  const { updater, engine, seen } = harness();
  await updater.check(true);
  await settled(() => seen.ready.length === 1);
  await seen.ready[0].restart();
  await settled(() => engine.restarts === 1);
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), { update_downloads_started: 1, update_downloads_finished: 1, update_restarts: 1 });
  assert.deepEqual(seen.told, []);
});

test("two windows restarting at once launch one installer, and the second says nothing", async () => {
  takeUpdateCounts();
  const engine = fakeEngine();
  const docs = new Map();
  const first = harness({ engine, docs });
  await first.updater.check(true);
  await settled(() => first.seen.ready.length === 1);
  const second = harness({ engine, docs });
  await Promise.all([first.updater.restartWhenReady(), second.updater.restartWhenReady(), first.updater.restartWhenReady()]);
  assert.equal(engine.restarts, 3);
  assert.equal(engine.launched, 1, "the engine reserves the install, so only one installer starts");
  assert.deepEqual([...first.seen.told, ...second.seen.told], [], "a restart the engine is already handling isn't an error");
  assert.equal(engine.claims.length, 1);
  assert.equal(SELF_UPDATE_COUNTS(takeUpdateCounts()).update_downloads_finished, 1);
});

test("an installer that doesn't start says so, and the failed run is counted once as an install failure", async () => {
  takeUpdateCounts();
  const { updater, engine, seen } = harness({ engine: fakeEngine({ launches: false }) });
  await updater.check(true);
  await settled(() => seen.ready.length === 1);
  await updater.restartWhenReady();
  assert.equal(engine.restarts, 1);
  assert.deepEqual(seen.told.map((told) => told.title), ["Ardia couldn't install the update"]);
  await updater.watch();
  await updater.watch();
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), {
    update_downloads_started: 1,
    update_downloads_finished: 1,
    update_restarts: 1,
    update_install_failures_checksum: 1,
  });
  assert.deepEqual(seen.offered, [], "the failure was already told, so no second notice follows");
});

test("the Settings window's Check Now restarts once the update is ready", async () => {
  const { updater, engine, seen } = harness();
  await updater.check(true);
  await settled(() => seen.ready.length === 1);
  assert.equal((await updater.methods.updaterState()).switchCheck.phase, "ready");
  await updater.methods.checkForUpdates();
  assert.equal(engine.restarts, 1);
  assert.equal(engine.checks, 1, "a ready update restarts instead of checking again");
});

test("up to date and not yet published both say so when asked and record the check", async () => {
  takeUpdateCounts();
  windowsUpdateCounts.takeCounts();
  for (const status of ["upToDate", "notPublished"]) {
    const { updater, seen, engine } = harness({ engine: fakeEngine({ answer: { status } }) });
    await updater.methods.checkForUpdates();
    assert.deepEqual(seen.told.map((told) => told.title), [status === "upToDate" ? "Ardia is up to date" : "No Windows update published yet"]);
    assert.deepEqual(engine.updates, []);
    assert.equal((await updater.methods.updaterState()).lastCheck, 1_000);
  }
  const counts = takeUpdateCounts();
  assert.equal(counts.update_checks_asked, 2);
  assert.equal(counts.update_check_failures, 0);
  const verify = windowsUpdateCounts.takeCounts()["windows-updates-test"];
  assert.equal(verify.verified, 1);
  assert.equal(verify.network, 1);
});

test("a test feed that isn't there is a failure, not up to date", async () => {
  takeUpdateCounts();
  const { updater, seen } = harness({ engine: fakeEngine({ answer: { status: "notPublished" }, isolated: true, testFeed: true }) });
  await updater.methods.checkForUpdates();
  assert.deepEqual(seen.told.map((told) => told.title), ["Ardia couldn't check for updates"]);
  assert.equal(takeUpdateCounts().update_check_failures, 1);
});

test("a feed that fails verification is refused, counted by reason, and never downloaded", async () => {
  takeUpdateCounts();
  windowsUpdateCounts.takeCounts();
  for (const reason of ["signature", "manifest", "tooLarge", "missing", "network", "verifier"]) {
    const { updater, seen, engine } = harness({ engine: fakeEngine({ answer: { status: "failed", reason, message: "the update signature could not be verified" } }) });
    await updater.methods.checkForUpdates();
    assert.deepEqual(seen.told.map((told) => told.title), ["Ardia couldn't check for updates"], reason);
    assert.match(seen.told[0].message, /^The update signature could not be verified\./);
    assert.deepEqual(engine.updates, [], reason);
    assert.equal((await updater.methods.updaterState()).switchCheck.phase, "failed");
  }
  assert.equal(takeUpdateCounts().update_check_failures, 6);
  assert.deepEqual(windowsUpdateCounts.takeCounts()["windows-updates-test"], { verified: 0, signature: 1, manifest: 1, tooLarge: 1, missing: 1, network: 1, verifier: 1, other: 0 });
});

test("a busy engine and a download under way are reported, not checked twice", async () => {
  const busy = harness({ engine: fakeEngine({ answer: { status: "busy" } }) });
  await busy.updater.methods.checkForUpdates();
  assert.deepEqual(busy.seen.told.map((told) => told.title), ["Ardia is already checking for updates"]);
  const engine = fakeEngine();
  engine.check();
  engine.update(OFFER.build);
  const downloading = harness({ engine });
  await downloading.updater.methods.checkForUpdates();
  assert.equal(engine.checks, 1);
  assert.deepEqual(downloading.seen.told.map((told) => told.title), [`Downloading Ardia ${OFFER.version}`]);
  assert.equal((await downloading.updater.methods.updaterState()).canCheck, false);
});

test("a download that fails offers the release page once and isn't retried automatically", async () => {
  takeUpdateCounts();
  const docs = new Map();
  const engine = fakeEngine({ failWith: "checksum" });
  const { updater, seen } = harness({ engine, docs });
  await updater.check(false);
  await settled(() => seen.offered.length === 1);
  assert.deepEqual(seen.offered, [`${OFFER.build} failed`]);
  assert.equal(JSON.parse(docs.get(UPDATE_PREFERENCES)).failed, OFFER.build);
  const counts = SELF_UPDATE_COUNTS(takeUpdateCounts());
  assert.equal(counts.update_downloads_finished, 1);
  assert.equal(counts.update_install_failures_checksum, 1);
  await updater.check(false);
  assert.deepEqual(engine.updates, [OFFER.build], "an automatic check skips the build that failed");
  await updater.check(true);
  await settled(() => seen.asked.length === 1);
  assert.equal(seen.asked[0].title, "Ardia couldn't install the update");
  assert.deepEqual(seen.opened, [WINDOWS_RELEASE_PAGE]);
});

test("with automatic downloads off an automatic check offers Update once, and accepting downloads", async () => {
  const docs = new Map([[UPDATE_PREFERENCES, JSON.stringify({ automaticDownloads: false })]]);
  const { updater, engine, seen } = harness({ docs });
  await updater.check(false);
  await updater.check(false);
  assert.equal(seen.offeredInstalls.length, 1);
  assert.deepEqual(engine.updates, []);
  seen.offeredInstalls[0].install();
  await settled(() => seen.ready.length === 1);
  assert.deepEqual(engine.updates, [OFFER.build]);
  assert.equal((await updater.methods.updaterState()).automaticDownloads, false);
});

test("a copy that isn't installed points to the release page and never downloads", async () => {
  const { updater, engine, seen, host } = harness({ engine: fakeEngine({ kind: "portable" }) });
  await updater.methods.checkForUpdates();
  assert.equal(seen.asked.length, 1);
  assert.match(seen.asked[0].message, /isn't installed/);
  assert.deepEqual(seen.opened, [WINDOWS_RELEASE_PAGE]);
  assert.deepEqual(engine.updates, []);
  assert.equal(installsUpdates(host), false);
  const state = await updater.methods.updaterState();
  assert.equal(state.configured, false);
  assert.equal(state.switchCheck, null);
  assert.equal(await updater.checksByItself(), false);
});

test("a build without its verifier, key or build file isn't set up and never checks", async () => {
  for (const engine of [fakeEngine({ kind: "unsupported" }), fakeEngine({ current: null })]) {
    const { updater, seen } = harness({ engine });
    await updater.methods.checkForUpdates();
    assert.equal(engine.checks, 0);
    assert.deepEqual(seen.told.map((told) => told.title), ["Updates aren't set up for this build"]);
    assert.equal((await updater.methods.updaterState()).configured, false);
    assert.equal(await updater.checksByItself(), false);
  }
});

test("automatic checks stay off in hidden and scratch instances and when turned off, and run in one window only", async () => {
  assert.equal(await harness({ engine: fakeEngine({ background: true }) }).updater.checksByItself(), false);
  assert.equal(await harness({ engine: fakeEngine({ isolated: true }) }).updater.checksByItself(), false);
  assert.equal(await harness({ engine: fakeEngine({ isolated: true, testFeed: true }) }).updater.checksByItself(), true, "a test instance naming a feed checks it");
  const { updater, engine } = harness();
  assert.equal(await updater.checksByItself(), true);
  await updater.methods.setAutomaticUpdateChecks(false);
  assert.equal(await updater.checksByItself(), false);
  await updater.check(false);
  assert.equal(engine.checks, 0);
  const requested = [];
  const timers = { setTimeout: (fn, ms) => requested.push(["timeout", ms]), setInterval: (fn, ms) => requested.push(["interval", ms]) };
  scheduleUpdateChecks(updater, { locks: { request: (name, callback) => (requested.push(["lock", name]), callback(), new Promise(() => {})) }, timers });
  assert.deepEqual(requested, [["lock", UPDATE_CHECK_LOCK], ["timeout", FIRST_CHECK_AFTER_MS], ["interval", CHECK_EVERY_MS], ["interval", WATCH_EVERY_MS]]);
});

test("the Settings window leaves the ready toast to a browser window, which shows it once", async () => {
  const engine = fakeEngine();
  const docs = new Map();
  const settings = harness({ engine, docs, showsToasts: false });
  await settings.updater.check(true);
  await settled(() => engine.phase === "ready");
  await tick();
  assert.deepEqual(settings.seen.ready, [], "the Settings window shows no toast");
  assert.equal((await settings.updater.methods.updaterState()).switchCheck.phase, "ready", "its status line says the update is ready");
  assert.deepEqual(engine.claims, []);
  const browser = harness({ engine, docs });
  await browser.updater.watch();
  assert.equal(browser.seen.ready.length, 0, "a run is settled only once it has been seen twice");
  await browser.updater.watch();
  assert.equal(browser.seen.ready.length, 1);
  assert.deepEqual(engine.claims, [1]);
  await browser.updater.watch();
  assert.equal(browser.seen.ready.length, 1);
});

test("hostile preferences fall back to the defaults", async () => {
  for (const { id, value } of HOSTILE_VALUES) {
    const text = typeof value === "string" ? value : JSON.stringify({ automaticChecks: value, automaticDownloads: value, lastCheck: value, notified: value, failed: value, readyNotified: value });
    const { updater } = harness({ docs: new Map([[UPDATE_PREFERENCES, text ?? "null"]]) });
    const state = await updater.methods.updaterState();
    assert.equal(typeof state.automaticChecks, "boolean", id);
    assert.ok(state.lastCheck === null || Number.isFinite(state.lastCheck), id);
  }
  assert.equal(Object.prototype.polluted, undefined);
});

test("windows webui update replies refuse every hostile input while passing a valid control", () => {
  const control = readCheckAnswer({ status: "ok", ...OFFER }, CURRENT);
  assert.deepEqual(control, { status: "ok", ...OFFER }, "positive control check answer passes");
  const status = readEngineStatus({ phase: "ready", kind: "installer", reason: null, run: 2, ...OFFER, current: CURRENT, background: false, isolated: false, testFeed: false });
  assert.deepEqual(status?.offer, OFFER, "positive control status passes");
  assert.deepEqual(status?.current, CURRENT);
  assert.equal(readCheckAnswer({ status: "ok", ...OFFER, build: CURRENT.build }, CURRENT), null, "an offer no newer than this build is refused");
  assert.equal(readCheckAnswer({ status: "ok", ...OFFER, bytes: 2 ** 30 + 1 }, CURRENT), null);
  const ready = { phase: "ready", kind: "installer", run: 2, ...OFFER, current: CURRENT };
  assert.equal(readEngineStatus({ ...ready, reason: "checksum" }).reason, "checksum");
  for (const reason of ["notAReason", "Checksum", "toString", "__proto__", "x".repeat(20)]) assert.equal(readEngineStatus({ ...ready, reason }).reason, "other", reason);
  assert.equal(readEngineStatus({ ...ready, reason: null }).reason, null);
  for (const build of [CURRENT.build, CURRENT.build - 1, 1]) assert.equal(readEngineStatus({ ...ready, build }).offer, null, `an offer of build ${build} isn't newer than ${CURRENT.build}`);
  assert.equal(readEngineStatus({ ...ready, current: null }).offer, null, "an offer can't be judged without the running build");
  assert.deepEqual(readEngineStatus({ ...ready, build: CURRENT.build + 1 }).offer, { ...OFFER, build: CURRENT.build + 1 });

  for (const { id, value } of HOSTILE_VALUES) {
    assert.equal(readCheckAnswer(value, CURRENT), null, `${id} raw check answer`);
    assert.equal(readEngineStatus(value), null, `${id} raw status`);
    for (const forged of [{ status: "ok", ...OFFER, version: value }, { status: "ok", ...OFFER, build: value }, { status: "ok", ...OFFER, bytes: value }, { status: value }]) {
      const answer = readCheckAnswer(forged, CURRENT);
      if (answer?.status === "ok") {
        assert.match(answer.version, /^[0-9][0-9A-Za-z.+-]{0,63}$/, `${id} version`);
        assert.ok(Number.isSafeInteger(answer.build) && answer.build > CURRENT.build, `${id} build`);
        assert.ok(Number.isSafeInteger(answer.bytes) && answer.bytes >= 1 && answer.bytes <= 2 ** 30, `${id} bytes`);
      } else {
        assert.ok(answer === null || ["upToDate", "notPublished", "busy"].includes(answer.status), `${id} ${JSON.stringify(forged).slice(0, 60)}`);
      }
    }
    const failed = readCheckAnswer({ status: "failed", reason: value, message: value }, CURRENT);
    assert.equal(failed?.status, "failed", id);
    assert.ok(["signature", "manifest", "tooLarge", "missing", "network", "verifier", "other"].includes(failed.reason), `${id} reason`);
    assert.ok(failed.message.length <= 200 && [...failed.message].every((character) => character.charCodeAt(0) >= 0x20 && character !== "\u007f"), `${id} message`);
    const read = readEngineStatus({ phase: value, run: 1 });
    assert.equal(read, null, `${id} phase`);
    const fields = readEngineStatus({ phase: "ready", kind: value, reason: value, run: 1, version: value, build: value, bytes: value, current: value, background: value, isolated: value, testFeed: value });
    assert.ok(fields, id);
    assert.ok(["installer", "portable", "unsupported"].includes(fields.kind), `${id} kind`);
    assert.ok(fields.reason === null || ["network", "tooLarge", "disk", "version", "busy", "checksum", "signature", "manifest", "missing", "verifier", "kind", "install", "other"].includes(fields.reason), `${id} reason`);
    assert.ok(fields.offer === null || /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(fields.offer.version), `${id} offer`);
    assert.ok(fields.current === null || /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(fields.current.version), `${id} current`);
    assert.equal(fields.background || fields.isolated || fields.testFeed, value === true, `${id} flags`);
  }
  assert.equal(Object.prototype.polluted, undefined);
});

test("a download started while sharing was off is never counted, even when another window settles it after sharing turns on", async () => {
  takeUpdateCounts();
  setConsentPeriod(false, null);
  try {
    const engine = fakeEngine();
    const docs = new Map();
    const settings = harness({ engine, docs, showsToasts: false });
    await settings.updater.check(true);
    await settled(() => engine.phase === "ready");
    assert.equal(JSON.parse(docs.get(UPDATE_PREFERENCES)).started.consent, null, "the run keeps the period it started in");
    setConsentPeriod(true, "windows-updates-later");
    const browser = harness({ engine, docs });
    await browser.updater.watch();
    await browser.updater.watch();
    assert.equal(browser.seen.ready.length, 1, "the browser window still shows the ready notice");
    assert.deepEqual(engine.claims, [1]);
    const counts = takeUpdateCounts();
    assert.equal(counts.update_downloads_started, 0);
    assert.equal(counts.update_downloads_finished, 0);
  } finally {
    setConsentPeriod(true, "windows-updates-test");
  }
});

test("a run settled by another window counts once under the period it started in", async () => {
  takeUpdateCounts();
  const engine = fakeEngine();
  const docs = new Map();
  const settings = harness({ engine, docs, showsToasts: false });
  await settings.updater.check(true);
  await settled(() => engine.phase === "ready");
  assert.equal(JSON.parse(docs.get(UPDATE_PREFERENCES)).started.consent, consentToken());
  const browser = harness({ engine, docs });
  await browser.updater.watch();
  await browser.updater.watch();
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), { update_downloads_started: 1, update_downloads_finished: 1 });
});

test("a window counts and shows only the outcome its claim consumed, never ready for a launch that failed", async () => {
  takeUpdateCounts();
  const engine = fakeEngine({ launches: false });
  const docs = new Map();
  const first = harness({ engine, docs });
  await first.updater.check(true);
  await settled(() => first.seen.ready.length === 1);
  takeUpdateCounts();
  const status = engine.status();
  await engine.restart();
  assert.equal(engine.phase, "failed");
  const second = harness({ engine, docs });
  second.host.invoke = async (method, { args }) => {
    if (method === "ArdiaUpdates.status") return status;
    if (method === "ArdiaUpdates.claimOutcome") return engine.claim(...args);
    throw new Error(`unexpected ${method}`);
  };
  await second.updater.watch();
  await second.updater.watch();
  assert.deepEqual(second.seen.ready, [], "the claim consumed the failed launch, so no Ready notice");
  assert.deepEqual(second.seen.offered, [`${OFFER.build} failed`]);
});

test("following a run stops when the engine has moved on to another run", async () => {
  const engine = fakeEngine();
  const { seen } = harness({ engine });
  let polls = 0;
  const followed = windowsUpdater({
    host: harness({ engine }).host,
    read: () => null,
    write: async () => {},
    pointToRelease: () => {},
    tell: async () => {},
    offer: () => {},
    offerInstall: () => {},
    ready: (update) => seen.ready.push({ build: update.build }),
    open: () => {},
    wait: async () => {
      polls++;
      if (polls === 1) Object.assign(engine, { phase: "downloading", run: engine.run + 1, claimed: false });
      else engine.advance();
      await tick();
    },
    now: () => 1_000,
  });
  await followed.check(true);
  await settled(() => polls >= 1);
  await tick();
  assert.deepEqual(engine.claims, [], "run 1's follower never claims run 2");
  assert.deepEqual(seen.ready, []);
});

test("Check for Updates during an automatic check says one is under way and starts no second check", async () => {
  let release;
  const engine = fakeEngine({ answer: () => ({ status: "upToDate" }) });
  const { updater, seen, host } = harness({ engine });
  const invoke = host.invoke;
  host.invoke = async (method, options) => {
    if (method === "ArdiaUpdates.check") await new Promise((resolve) => (release = resolve));
    return invoke(method, options);
  };
  const automatic = updater.check(false);
  await settled(() => typeof release === "function");
  await updater.check(true);
  assert.deepEqual(seen.told.map((told) => told.title), ["Ardia is already checking for updates"]);
  release();
  await automatic;
  assert.equal(engine.checks, 1);
  assert.deepEqual(seen.told.map((told) => told.title), ["Ardia is already checking for updates"], "the automatic check stays quiet");
});

test("an old Update toast clicked in another window never takes over a run that started with sharing off", async () => {
  takeUpdateCounts();
  setConsentPeriod(false, null);
  try {
    const engine = fakeEngine();
    const docs = new Map([[UPDATE_PREFERENCES, JSON.stringify({ automaticDownloads: false })]]);
    const browser = harness({ engine, docs });
    await browser.updater.check(false);
    assert.equal(browser.seen.offeredInstalls.length, 1, "window B shows Update");
    const settings = harness({ engine, docs, showsToasts: false });
    await settings.updater.check(true);
    assert.equal(engine.run, 1);
    assert.equal(JSON.parse(docs.get(UPDATE_PREFERENCES)).started.consent, null);
    setConsentPeriod(true, "windows-updates-later");
    browser.seen.offeredInstalls[0].install();
    await settled(() => engine.updates.length === 2);
    await settled(() => engine.phase === "ready");
    await browser.updater.watch();
    await browser.updater.watch();
    await tick();
    assert.equal(engine.run, 1, "the stale click started no second run");
    assert.equal(JSON.parse(docs.get(UPDATE_PREFERENCES)).started.consent, null, "the run keeps the period it started in");
    const counts = takeUpdateCounts();
    assert.equal(counts.update_downloads_started, 0);
    assert.equal(counts.update_downloads_finished, 0);
  } finally {
    setConsentPeriod(true, "windows-updates-test");
  }
});

test("an old Update toast clicked after another window prepared a newer build is declined without counting anything", async () => {
  takeUpdateCounts();
  const NEWER = { version: "0.2.47", build: 7200, bytes: OFFER.bytes };
  let answer = { status: "ok", ...OFFER };
  const engine = fakeEngine({ answer: () => answer });
  const docs = new Map([[UPDATE_PREFERENCES, JSON.stringify({ automaticDownloads: false })]]);
  const browser = harness({ engine, docs });
  await browser.updater.check(false);
  assert.equal(browser.seen.offeredInstalls.length, 1);
  answer = { status: "ok", ...NEWER };
  const settings = harness({ engine, docs, showsToasts: false });
  await settings.updater.check(true);
  await settled(() => engine.phase === "ready");
  takeUpdateCounts();
  browser.seen.offeredInstalls[0].install();
  await settled(() => engine.updates.length === 2);
  await tick();
  await tick();
  assert.deepEqual(engine.updates, [NEWER.build, OFFER.build]);
  assert.deepEqual(browser.seen.offered, [], "a decline offers no release page");
  assert.deepEqual(browser.seen.asked, []);
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), {}, "neither a download start nor a failure is counted");
});

test("a watcher in another window waits for the starter to record the run's consent before it claims the run", async () => {
  takeUpdateCounts();
  const locks = lockManager();
  const engine = fakeEngine({ instant: true });
  const docs = new Map();
  let releaseWrite;
  let holding = false;
  const write = async (name, contents) => {
    if (JSON.parse(contents).started && !holding) {
      holding = true;
      await new Promise((resolve) => (releaseWrite = resolve));
    }
    docs.set(name, contents);
  };
  const starter = harness({ engine, docs, showsToasts: false, locks, write });
  const watcher = harness({ engine, docs, locks });
  const checking = starter.updater.check(true);
  await settled(() => typeof releaseWrite === "function");
  assert.equal(engine.phase, "ready", "the run finished while the starter's write is still pending");
  await watcher.updater.watch();
  const second = watcher.updater.watch();
  await tick();
  await tick();
  assert.deepEqual(engine.claims, [], "the watcher can't claim while the start is being recorded");
  releaseWrite();
  await second;
  await checking;
  assert.deepEqual(engine.claims, [1]);
  assert.equal(watcher.seen.ready.length, 1);
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), { update_downloads_started: 1, update_downloads_finished: 1 });
});

test("after a relaunch the same build ready again shows Restart, whatever an earlier session remembered", async () => {
  const engine = fakeEngine();
  const docs = new Map([[UPDATE_PREFERENCES, JSON.stringify({ readyNotified: OFFER.build, notified: OFFER.build })]]);
  const first = harness({ engine, docs });
  await first.updater.check(true);
  await settled(() => first.seen.ready.length === 1);
  const relaunched = fakeEngine();
  relaunched.check();
  relaunched.update(OFFER.build);
  relaunched.advance();
  const fresh = harness({ engine: relaunched, docs });
  await fresh.updater.watch();
  await fresh.updater.watch();
  assert.equal(fresh.seen.ready.length, 1, "a fresh session shows the Restart toast for its own ready run");
  await fresh.updater.watch();
  assert.equal(fresh.seen.ready.length, 1, "and only once for that run");
});

test("clicking Update while another window's check is running keeps the offer and counts nothing", async () => {
  takeUpdateCounts();
  const engine = fakeEngine();
  const docs = new Map([[UPDATE_PREFERENCES, JSON.stringify({ automaticDownloads: false })]]);
  const browser = harness({ engine, docs });
  await browser.updater.check(false);
  assert.equal(browser.seen.offeredInstalls.length, 1);
  assert.equal(JSON.parse(docs.get(UPDATE_PREFERENCES)).notified, OFFER.build);
  takeUpdateCounts();
  engine.phase = "checking";
  browser.seen.offeredInstalls[0].install();
  await settled(() => browser.seen.told.length === 1);
  assert.deepEqual(browser.seen.told.map((told) => told.title), ["Ardia is checking for updates"]);
  assert.equal(engine.run, 0, "no download started");
  assert.equal(JSON.parse(docs.get(UPDATE_PREFERENCES)).notified, null, "the offer can be shown again");
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), {});
  engine.phase = "idle";
  await browser.updater.check(false);
  assert.equal(browser.seen.offeredInstalls.length, 2, "the finished check offers Update again");
  browser.seen.offeredInstalls[1].install();
  await settled(() => browser.seen.ready.length === 1);
  assert.equal(engine.run, 1);
});

test("a watcher and a manual check queued behind the run lock show one Restart toast for the run", async () => {
  const locks = lockManager();
  const engine = fakeEngine();
  engine.check();
  engine.update(OFFER.build);
  engine.advance();
  const { updater, seen } = harness({ engine, locks });
  await updater.watch();
  let releaseLock;
  locks.request(UPDATE_RUN_LOCK, () => new Promise((resolve) => (releaseLock = resolve)));
  await tick();
  const watching = updater.watch();
  const asking = updater.check(true);
  await tick();
  await tick();
  assert.deepEqual(engine.claims, []);
  releaseLock();
  await Promise.all([watching, asking]);
  assert.deepEqual(engine.claims, [1]);
  assert.equal(seen.ready.length, 1, "only the claim that consumed the run shows Restart");
  await updater.check(true);
  assert.equal(seen.ready.length, 2, "a later Check for Updates still shows it again on request");
});
