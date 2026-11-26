import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, socketClient, freshWindow, tick } = await import("./fixtures/socketHarness.mjs");
const stub = await import("../../test-native/index.ts");
const { useVaultApproval, answerApproval } = await import("../vault/approval.ts");
const { dropTask, taskFor } = await import("../vault/tasks.ts");
const { liveAttempts, runningSignIns, tabReloads, vaultClock } = await import("../vault/signIn.ts");
const { takeVaultCounts } = await import("../telemetry/vaultCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { forgetRegistrableDomains } = await import("../engines/siteDataMerge.ts");
const { resetRegistrableLookupsForTest } = await import("../engines/siteDataDomains.ts");
const { emitEvent } = await import("../../test-native/ardiacore.ts");
setConsentPeriod(true, "socket-vault-races");
const sitesModule = stub.ardiaCoreNativeModules.ArdiaSites;
const nativeSites = sitesModule.call;
sitesModule.call = (verb, profile, json) => (verb === "registrableDomains" ? Promise.resolve(JSON.stringify({ domains: JSON.parse(json).hosts.map((host) => host.split(".").slice(-2).join(".")) })) : nativeSites(verb, profile, json));

const wait = async (predicate, what = "condition") => {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(`${what} did not settle`);
};
const waitFor = async (predicate, ms, what) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`${what} did not happen within ${ms} ms`);
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
};
const holds = stub.vaultFake.heldSignIns;
const releaseFirst = (status) => [...holds.values()][0](status);
const realNow = Date.now;
const realClock = vaultClock.now;
const realReload = tabReloads.reload;
const realSites = stub.ardiaCoreNativeModules.ArdiaSites.call;
let connection = 9000;

async function setup(origins, names, { driven = false } = {}) {
  const c = ++connection;
  resetRegistrableLookupsForTest();
  forgetRegistrableDomains();
  Object.assign(stub.vaultFake, { listGate: null, holdSignIns: false, transferStarted: false, signInResult: { status: "signed_in", transfer: "complete" } });
  stub.vaultFake.signIns.length = 0;
  stub.passwordStores.set(null, new Map(origins.flatMap((origin) => names.map((username) => [`https://${origin}\n${username}`, { origin: `https://${origin}`, url: `https://${origin}`, username, password: "test", created: 1 }]))));
  const { tab } = await freshWindow(`https://${origins[0]}/login`);
  const { call } = socketClient(c);
  stub.controlSocket.peers[c] = { pid: 42, path: "/opt/homebrew/bin/node", name: "node", signed: false, valid: true, adhoc: true, platform: false, lookupMs: 1 };
  const starting = call("vault.taskStart", { sites: origins, ...(driven ? { tabs: [tab] } : {}) });
  await wait(() => useVaultApproval.getState().request, "approval sheet");
  answerApproval(useVaultApproval.getState().request.id, "allow");
  const task = (await starting).result.task;
  const reloads = [];
  tabReloads.reload = async (id, allowed) => (allowed() && reloads.push(id), true);
  let id = 100;
  const login = (site, rest = {}, onTask = task) => {
    const request = ++id;
    stub.emitControlRequest({ connection: c, generation: stub.controlSocket.generation, line: JSON.stringify({ id: request, method: "vault.login", params: { task: onTask, site, ...rest } }) });
    const reply = () => stub.controlSocket.replies.filter((r) => r.connection === c).map((r) => JSON.parse(r.line)).find((r) => r.id === request);
    return async () => (await wait(reply, `reply ${request}`), reply());
  };
  const form = (document, origin = `https://${origins[0]}`) => emitEvent("vault.loginFormSeen", { epoch: "socket-vault-races", tab, origin, hasUsername: true, hasPassword: true, hasOneTimeCode: false, mainFrame: true, document, at: 1 });
  const startTask = async (sites) => {
    const starting = call("vault.taskStart", { sites });
    await wait(() => useVaultApproval.getState().request, "approval sheet");
    answerApproval(useVaultApproval.getState().request.id, "allow");
    return (await starting).result.task;
  };
  const close = () => {
    Date.now = realNow;
    vaultClock.now = realClock;
    tabReloads.reload = realReload;
    stub.ardiaCoreNativeModules.ArdiaSites.call = realSites;
    stub.vaultFake.transferStarted = false;
    dropTask(task, "ended");
    for (const release of [...holds.values()]) release("cancelled");
    stub.vaultFake.holdSignIns = false;
  };
  return { c, call, task, tab, login, form, reloads, close, startTask, state: taskFor(task, c).task };
}

after(() => S().updateSettings({ cliControl: false }));

test("a site that isn't a valid https origin is a bad_request before the sheet, and nothing is granted", async () => {
  const x = await setup(["valid.example"], ["a"]);
  try {
    const before = (await x.call("vault.status")).result.tasks.length;
    for (const site of ["bad.example:65536", "https://bad.example:99999/", "https://exa mple.com"]) {
      const reply = await x.call("vault.taskStart", { sites: ["valid.example", site], tabs: [x.tab] });
      assert.equal(reply.error?.code, "bad_request", site);
      assert.equal(useVaultApproval.getState().request, null, "no sheet was shown");
    }
    assert.equal((await x.call("vault.status")).result.tasks.length, before);
    x.form(44);
    await settle();
    assert.equal(stub.vaultFake.signIns.length, 0, "no auto-fill from a refused start");
    const { siteOrigin } = await import("../vault/tasks.ts");
    assert.equal(siteOrigin("HTTPS://Valid.Example:443/path", false), "https://valid.example");
    assert.equal(siteOrigin("bad.example:65536", false), null);
    assert.equal(siteOrigin("https://xn--bcher-kva.example", false), "https://xn--bcher-kva.example");
  } finally {
    x.close();
  }
});

test("once the engine has started moving the session, a login for another account waits for the engine's own reply, and that sign-in is still recorded", async () => {
  const x = await setup(["commit.example"], ["a", "b"], { driven: true });
  try {
    assert.equal((await x.login("commit.example", { account: "a", tab: x.tab })()).result.status, "signed_in");
    Date.now = () => realNow() + 31_000;
    stub.vaultFake.holdSignIns = true;
    stub.vaultFake.transferStarted = true;
    takeVaultCounts();
    x.form(1);
    await wait(() => holds.size === 1, "auto-fill reached the engine");
    const other = x.login("commit.example", { account: "b" });
    await settle();
    assert.equal(stub.vaultFake.cancelledSignIns.at(-1), [...holds.keys()][0], "the auto-fill was asked to stop");
    assert.equal(holds.size, 1, "the login doesn't start while the engine is still moving the session");
    stub.vaultFake.transferStarted = false;
    releaseFirst();
    await wait(() => holds.size === 1 && stub.vaultFake.signIns.at(-1).username === "b", "the login starts after the reply");
    releaseFirst();
    assert.equal((await other()).result.status, "signed_in");
    const counts = takeVaultCounts();
    assert.equal(counts.vault_autofills, 1, "the auto-fill's moved session is recorded");
    assert.equal(counts.vault_fills, 1, "and the program's login once");
    assert.equal(counts.vault_refusals_busy ?? 0, 0);
  } finally {
    x.close();
  }
});

test("ending a task while its session is moving answers at once, and the next task's sign-in for that site waits for the engine to finish", async () => {
  const x = await setup(["drain.example"], ["a"]);
  try {
    stub.vaultFake.holdSignIns = true;
    stub.vaultFake.transferStarted = true;
    takeVaultCounts();
    const first = x.login("drain.example");
    await wait(() => holds.size === 1);
    dropTask(x.task, "ended");
    assert.equal((await first()).error.code, "task_expired", "the caller hears at once");
    assert.equal(holds.size, 1, "the engine is still finishing");
    const taskId = await x.startTask(["drain.example"]);
    const waiting = x.login("drain.example", {}, taskId);
    await settle();
    assert.equal(stub.vaultFake.signIns.length, 1, "the next sign-in waits for the drain");
    stub.vaultFake.transferStarted = false;
    stub.vaultFake.signInResult = { status: "cancelled", transfer: "sent", cookies: 2 };
    releaseFirst("cancelled");
    stub.vaultFake.signInResult = { status: "signed_in", transfer: "complete" };
    await wait(() => holds.size === 1 && stub.vaultFake.signIns.length === 2, "the next sign-in starts after the drain");
    releaseFirst();
    assert.equal((await waiting()).result.status, "signed_in");
    const counts = takeVaultCounts();
    assert.equal(counts.vault_transfers_sent, 1, "the cut-short move is recorded as sent, not lost");
    dropTask(taskId, "ended");
  } finally {
    x.close();
  }
});

test("a call accepts an engine answer only within its own 28 s, even when the answer beats the timer", async () => {
  const x = await setup(["deadline.example"], ["a", "b"]);
  try {
    let shift = 0;
    vaultClock.now = () => realClock() + shift;
    stub.vaultFake.holdSignIns = true;
    const lead = x.login("deadline.example", { account: "a" });
    await wait(() => holds.size === 1);
    const queued = x.login("deadline.example", { account: "b", tab: x.tab });
    await wait(() => liveAttempts() === 2);
    shift = 20_000;
    releaseFirst();
    assert.equal((await lead()).result.status, "signed_in");
    await wait(() => holds.size === 1);
    shift = 37_000;
    releaseFirst();
    const answer = await queued();
    assert.equal(answer.error?.code, "failed");
    assert.match(answer.error.message, /took too long/);
    assert.deepEqual(x.reloads, []);
  } finally {
    x.close();
  }
});

test("the deadline timer counts the time spent waiting for a turn", async (t) => {
  const x = await setup(["budget.example"], ["a", "b"]);
  try {
    stub.vaultFake.holdSignIns = true;
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: realNow() });
    vaultClock.now = () => Date.now();
    const lead = x.login("budget.example", { account: "a" });
    await wait(() => holds.size === 1);
    const queued = x.login("budget.example", { account: "b", tab: x.tab });
    await wait(() => liveAttempts() === 2);
    t.mock.timers.tick(20_000);
    releaseFirst();
    assert.equal((await lead()).result.status, "signed_in");
    await wait(() => holds.size === 1);
    t.mock.timers.tick(7_999);
    await settle();
    assert.equal(holds.size, 1);
    t.mock.timers.tick(1);
    assert.equal((await queued()).error.code, "failed");
    assert.deepEqual(x.reloads, []);
  } finally {
    t.mock.timers.reset();
    x.close();
  }
});

test("an engine answer that arrives after the task ran out is recorded only if the session moved, and the caller hears task_expired", async () => {
  const x = await setup(["expired.example"], ["a"]);
  try {
    for (const [transfer, fills] of [["none", 0], ["complete", 1]]) {
      stub.vaultFake.holdSignIns = true;
      stub.vaultFake.signInResult = { status: transfer === "none" ? "submitted" : "signed_in", evidence: "none", transfer };
      const task = transfer === "none" ? x.task : await x.startTask(["expired.example"]);
      const answer = x.login("expired.example", { tab: x.tab }, task);
      await wait(() => holds.size === 1);
      takeVaultCounts();
      Date.now = () => realNow() + 16 * 60_000;
      releaseFirst();
      assert.equal((await answer()).error.code, "task_expired");
      Date.now = realNow;
      const counts = takeVaultCounts();
      assert.equal(counts.vault_fills ?? 0, fills, `transfer ${transfer}`);
      assert.deepEqual(x.reloads, []);
      dropTask(task, "ended");
    }
  } finally {
    x.close();
  }
});

test("a site key is fixed for the task: a login that started before the domain lookup answered is joined, not started twice, and a forgotten cache doesn't change it", async () => {
  const x = await setup(["a.late.example"], ["a"]);
  try {
    resetRegistrableLookupsForTest();
    forgetRegistrableDomains();
    let answerLookup;
    stub.ardiaCoreNativeModules.ArdiaSites.call = (verb, ...args) => (verb === "registrableDomains" ? new Promise((resolve) => (answerLookup = () => resolve(JSON.stringify({ domains: ["late.example"] })))) : realSites(verb, ...args));
    stub.vaultFake.holdSignIns = true;
    const a = x.login("a.late.example");
    await waitFor(() => holds.size === 1, 2000, "the sign-in past the lookup deadline");
    answerLookup();
    await settle();
    const b = x.login("a.late.example");
    await settle();
    assert.equal(stub.vaultFake.signIns.length, 1, "one engine sign-in");
    releaseFirst();
    assert.equal((await a()).result.status, "signed_in");
    assert.equal((await b()).result.status, "signed_in");
    assert.equal(x.state.siteKeys.get("https://a.late.example"), "https://late.example");
    forgetRegistrableDomains();
    assert.equal(runningSignIns(x.state), 0);
    x.login("a.late.example");
    await waitFor(() => stub.vaultFake.signIns.length === 2, 2000, "the second sign-in past the lookup deadline");
    assert.equal(x.state.siteKeys.get("https://a.late.example"), "https://late.example", "the key stays");
  } finally {
    x.close();
  }
});

test("when the domain lookup fails, sibling origins still take turns instead of meeting the engine's busy", async () => {
  const x = await setup(["a.failed.example", "b.failed.example"], ["a"]);
  try {
    resetRegistrableLookupsForTest();
    forgetRegistrableDomains();
    stub.ardiaCoreNativeModules.ArdiaSites.call = (verb, ...args) => (verb === "registrableDomains" ? Promise.reject(new Error("bridge unavailable")) : realSites(verb, ...args));
    stub.vaultFake.holdSignIns = true;
    const a = x.login("a.failed.example");
    await wait(() => holds.size === 1);
    const b = x.login("b.failed.example");
    await settle();
    assert.equal(stub.vaultFake.signIns.length, 1, "b waits");
    releaseFirst();
    assert.equal((await a()).result.status, "signed_in");
    await wait(() => holds.size === 1);
    releaseFirst();
    assert.equal((await b()).result.status, "signed_in");
  } finally {
    x.close();
  }
});

test("auto-fill opens its ticket on the form event: a task ending during the lookup records no skip, and a stalled lookup gets one 28 s budget", async (t) => {
  const x = await setup(["autolookup.example"], ["a", "b"], { driven: true });
  try {
    takeVaultCounts();
    const names = x.state.logins.get("https://autolookup.example");
    x.state.logins.clear();
    let answerLookup;
    x.state.loginsLoading = new Promise((resolve) => (answerLookup = () => (x.state.logins.set("https://autolookup.example", names), resolve())));
    x.form(1);
    await wait(() => liveAttempts() === 1, "a ticket at the form event");
    dropTask(x.task, "ended");
    answerLookup();
    await settle();
    assert.equal(takeVaultCounts().vault_autofill_skipped_several ?? 0, 0);
    assert.equal(liveAttempts(), 0);
  } finally {
    x.close();
  }
  const y = await setup(["autobudget.example"], ["a"], { driven: true });
  try {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: realNow() });
    vaultClock.now = () => Date.now();
    y.state.logins.clear();
    y.state.loginsLoading = new Promise(() => {});
    y.form(1);
    await wait(() => liveAttempts() === 1);
    t.mock.timers.tick(28_000);
    await wait(() => liveAttempts() === 0, "the one budget ran out");
    await settle();
    assert.equal(liveAttempts(), 0, "no second budget");
  } finally {
    t.mock.timers.reset();
    y.close();
  }
});

test("the reply says whether the tab reloaded, and callers sharing a tab share one reload", async () => {
  const x = await setup(["reload.example"], ["a"]);
  try {
    let calls = 0;
    tabReloads.reload = async () => (calls++, false);
    const unavailable = await x.login("reload.example", { tab: x.tab })();
    assert.equal(unavailable.result.status, "signed_in");
    assert.equal(unavailable.result.transfer, "complete");
    assert.equal(unavailable.result.reloaded, false);
    tabReloads.reload = async () => (calls++, true);
    calls = 0;
    stub.vaultFake.holdSignIns = true;
    const lead = x.login("reload.example", { tab: x.tab });
    await wait(() => holds.size === 1);
    const joined = x.login("reload.example", { tab: x.tab, account: "a" });
    await wait(() => liveAttempts() === 2);
    await settle();
    releaseFirst();
    const answers = await Promise.all([lead(), joined()]);
    assert.deepEqual(answers.map((a) => a.result.reloaded), [true, true]);
    assert.equal(calls, 1);
    stub.vaultFake.holdSignIns = false;
    assert.equal((await x.login("reload.example")()).result.reloaded, null, "no tab, no reload");
  } finally {
    x.close();
  }
});

test("a partial move that also met the person's changes keeps the partial failure and names the conflicts", async () => {
  const x = await setup(["partial.example"], ["a"]);
  try {
    stub.vaultFake.signInResult = { status: "signed_in", transfer: "partial", conflicts: 2, transferFailed: 1 };
    const answer = await x.login("partial.example", { tab: x.tab })();
    assert.equal(answer.error.code, "failed");
    assert.match(answer.error.message, /only part of the session/);
    assert.match(answer.error.message, /conflicts: 2/);
    assert.deepEqual(x.reloads, []);
  } finally {
    x.close();
  }
});

test("auto-fill's document memory keeps the 64 most recently seen, refreshing one seen again", async () => {
  const x = await setup(["memory.example"], ["a", "b"], { driven: true });
  try {
    for (let id = 1; id <= 64; id++) {
      x.form(id);
      await wait(() => !x.state.busyTabs.size);
    }
    x.form(1);
    await wait(() => !x.state.busyTabs.size);
    x.form(65);
    await wait(() => !x.state.busyTabs.size);
    const [{ skipped }] = x.state.auto.values();
    assert.equal(skipped.size, 64);
    assert.ok(skipped.has("1"), "the one seen again stays");
    assert.ok(!skipped.has("2"), "the least recently seen goes");
  } finally {
    x.close();
  }
});
