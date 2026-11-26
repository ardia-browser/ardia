import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
const { S, socketClient, freshWindow, tick } = await import("./fixtures/socketHarness.mjs");
const stub = await import("../../test-native/index.ts");
const { useVaultApproval, answerApproval } = await import("../vault/approval.ts");
const { flushVaultActivity, useVaultActivity } = await import("../vault/activity.ts");
const { setLogShowsReasons } = await import("../vault/prefs.ts");
const { engineProfile } = await import("../browser/model.ts");
const { saveVerificationSecret } = await import("../site/vaultCodes.ts");
const { accessProblem, methodSpec, methodsCatalog } = await import("./socketCatalog.ts");
const { takeVaultCounts } = await import("../telemetry/vaultCounts.ts");
const { dropTask } = await import("../vault/tasks.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { emitEvent } = await import("../../test-native/ardiacore.ts");
setConsentPeriod(true, "socket-vault-test");
const sitesModule = stub.ardiaCoreNativeModules.ArdiaSites;
const nativeSites = sitesModule.call;
sitesModule.call = (verb, profile, json) => (verb === "registrableDomains" ? Promise.resolve(JSON.stringify({ domains: JSON.parse(json).hosts.map((host) => host.split(".").slice(-2).join(".")) })) : nativeSites(verb, profile, json));

const APP = { pid: 41, path: "/Applications/Agent.app/Contents/MacOS/Agent", name: "Agent", identifier: "com.example.agent", teamId: "TEAM123456", signer: "Developer ID Application: Example (TEAM123456)", signed: true, valid: true, adhoc: false, platform: false, lookupMs: 1 };
const NODE = { pid: 42, path: "/opt/homebrew/bin/node", name: "node", signed: false, valid: true, adhoc: true, platform: false, lookupMs: 1 };

const login = (origin, username, password = "hunter2") => [`${origin}\n${username}`, { origin, url: origin, username, password, created: 1 }];

const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await tick();
};

async function approved(started, answer = "allow") {
  for (let i = 0; i < 200 && !useVaultApproval.getState().request; i++) await tick();
  const request = useVaultApproval.getState().request;
  assert.ok(request, "the approval sheet is up");
  answerApproval(request.id, answer);
  return { request, reply: await started };
}

beforeEach(() => {
  stub.vaultFake.signIns.length = 0;
  stub.vaultFake.signInResult = { status: "signed_in", readyMs: 4, fillMs: 3, totalMs: 9 };
  stub.vaultFake.authenticate = { granted: true, how: "granted", ms: 1 };
  stub.vaultFake.locked = false;
  stub.passwordStores.set(null, new Map([login("https://one.example", "me"), login("https://two.example", "a"), login("https://two.example", "b")]));
});

after(() => S().updateSettings({ cliControl: false }));

test("vault methods are listed with schemas and refused to plugin sessions", async () => {
  await freshWindow();
  const names = methodsCatalog().map((m) => m.name);
  for (const name of ["vault.taskStart", "vault.taskEnd", "vault.login", "vault.log", "vault.status"]) {
    assert.ok(names.includes(name), name);
    assert.equal(accessProblem("plugin", methodSpec(name))?.code, "refused");
  }
});

test("a task starts only after the person allows it on Ardia's sheet and Touch ID", async () => {
  await freshWindow();
  stub.controlSocket.peers[701] = APP;
  const { call, ok } = socketClient(701);
  assert.equal((await call("vault.taskStart", { sites: ["http://one.example"] })).error.code, "bad_request");
  takeVaultCounts();

  const denied = await approved(call("vault.taskStart", { sites: ["one.example"], why: "book a table" }), "deny");
  assert.equal(denied.reply.error.code, "denied");
  assert.equal(denied.request.program.name, "Agent");
  assert.equal(denied.request.mayAlways, true);
  assert.deepEqual(denied.request.sites, ["https://one.example"]);
  assert.equal(denied.request.why, "book a table");
  assert.equal(takeVaultCounts().vault_refusals_denied, 1);

  stub.vaultFake.authenticate = { granted: false, how: "cancelled", ms: 1 };
  assert.equal((await approved(call("vault.taskStart", { sites: ["one.example"] }))).reply.error.code, "denied");
  stub.vaultFake.authenticate = { granted: true, how: "granted", ms: 1 };

  const { reply } = await approved(call("vault.taskStart", { sites: ["https://One.example/login", "two.example"], why: "check orders" }));
  const task = reply.result;
  assert.match(task.task, /^[0-9a-f]{32}$/);
  assert.deepEqual(task.sites, ["https://one.example", "https://two.example"]);
  assert.equal(task.via, "sheet");
  assert.ok(task.expiresAt > Date.now());
  assert.equal(takeVaultCounts().vault_grants_sheet, 1);

  const signedIn = await ok("vault.login", { task: task.task, site: "one.example" });
  assert.equal(signedIn.status, "signed_in");
  assert.equal(JSON.stringify(signedIn).includes("hunter2"), false);
  assert.deepEqual(stub.vaultFake.signIns.at(-1), { profile: stub.vaultFake.signIns.at(-1).profile, url: "https://one.example/", origin: "https://one.example", username: "me", code: false });

  assert.equal((await call("vault.login", { task: task.task, site: "three.example" })).error.code, "not_granted");
  assert.equal((await call("vault.login", { task: task.task, site: "two.example" })).error.code, "bad_request");
  assert.equal((await ok("vault.login", { task: task.task, site: "two.example", account: "b" })).status, "signed_in");
  assert.equal((await call("vault.login", { task: task.task, site: "two.example", account: "zed" })).error.code, "no_login");

  stub.vaultFake.signInResult = { status: "still_on_login" };
  assert.equal((await call("vault.login", { task: task.task, site: "one.example" })).error.code, "needs_human");
  stub.vaultFake.signInResult = { status: "needs_passkey" };
  assert.equal((await call("vault.login", { task: task.task, site: "one.example" })).error.code, "needs_passkey");

  const other = socketClient(702);
  assert.equal((await other.call("vault.login", { task: task.task, site: "one.example" })).error.code, "denied");

  const status = await ok("vault.status");
  assert.equal(status.program.name, "Agent");
  assert.deepEqual(status.tasks.map((t) => t.task), [task.task]);

  await ok("vault.taskEnd", { task: task.task });
  assert.equal((await call("vault.login", { task: task.task, site: "one.example" })).error.code, "task_expired");
  const counts = takeVaultCounts();
  assert.equal(counts.vault_fills, 2);
  assert.equal(counts.vault_refusals_needs_human, 1);
  assert.equal(counts.vault_refusals_task_expired, 1);
  assert.ok(counts.vault_login_ms_count >= 2);
});

test("a task dies with its connection", async () => {
  await freshWindow();
  stub.controlSocket.peers[703] = APP;
  const { call } = socketClient(703);
  const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"] }));
  stub.emitControlClose(703);
  await settle();
  const again = socketClient(703);
  assert.equal((await again.call("vault.login", { task: reply.result.task, site: "one.example" })).error.code, "task_expired");
});

test("always allow is kept for a signed app, never for an interpreter or the ardia command", async () => {
  await freshWindow();
  stub.vaultFake.always = [];
  stub.controlSocket.peers[704] = APP;
  const app = socketClient(704);
  await approved(app.call("vault.taskStart", { sites: ["one.example"] }), "always");
  assert.equal(stub.vaultFake.always.length, 1);
  const quiet = await app.call("vault.taskStart", { sites: ["one.example"] });
  assert.equal(quiet.result.via, "always");
  assert.equal(useVaultApproval.getState().request, null);

  stub.controlSocket.peers[705] = NODE;
  const node = socketClient(705);
  const { request, reply } = await approved(node.call("vault.taskStart", { sites: ["one.example"] }), "always");
  assert.equal(request.mayAlways, false);
  assert.equal(request.program.kind, "interpreter");
  assert.equal(reply.result.via, "sheet");
  assert.equal(stub.vaultFake.always.length, 1);
});

test("a locked screen refuses at once instead of waiting for a sheet nobody sees", async () => {
  await freshWindow();
  stub.controlSocket.peers[706] = NODE;
  stub.vaultFake.locked = true;
  assert.equal((await socketClient(706).call("vault.taskStart", { sites: ["one.example"] })).error.code, "locked");
  assert.equal(useVaultApproval.getState().request, null);
});

test("a sign-in form in a tab the task drives fills on Chrome's event, once", async () => {
  const { tab } = await freshWindow("https://one.example/login");
  stub.controlSocket.peers[707] = NODE;
  const { call } = socketClient(707);
  await approved(call("vault.taskStart", { sites: ["one.example"], tabs: [tab] }));
  const before = stub.vaultFake.signIns.length;
  emitEvent("vault.loginFormSeen", { epoch: "socket-vault-test", tab, origin: "https://one.example", hasUsername: true, hasPassword: true, hasOneTimeCode: false, at: 1 });
  emitEvent("vault.loginFormSeen", { epoch: "socket-vault-test", tab, origin: "https://one.example", hasUsername: true, hasPassword: true, hasOneTimeCode: false, at: 2 });
  emitEvent("vault.loginFormSeen", { epoch: "socket-vault-test", tab, origin: "https://elsewhere.example", hasUsername: true, hasPassword: true, hasOneTimeCode: false, at: 3 });
  await settle();
  assert.equal(stub.vaultFake.signIns.length, before + 1);
  assert.equal(stub.vaultFake.signIns.at(-1).url, "https://one.example/login");
  assert.equal(takeVaultCounts().vault_autofills, 1);
});

test("a kept verification code goes with the sign-in, and the log hides reasons unless the person shows them", async () => {
  await freshWindow();
  stub.controlSocket.peers[708] = NODE;
  const { call, ok } = socketClient(708);
  const profile = engineProfile(S(), S().settings.defaultProfileId);
  assert.equal(await saveVerificationSecret(profile, "https://one.example/", "me", "otpauth://totp/One:me?secret=JBSWY3DPEHPK3PXP"), true);
  const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"], why: "pay the invoice" }));
  const signedIn = await ok("vault.login", { task: reply.result.task, site: "one.example" });
  assert.equal(signedIn.usedCode, true);
  assert.equal(stub.vaultFake.signIns.at(-1).code, true);

  const log = await ok("vault.log", { limit: 5 });
  assert.ok(log.length >= 2);
  assert.ok(log.every((e) => !("reason" in e)));
  assert.ok(log.some((e) => e.kind === "fill" && e.site === "https://one.example" && e.account === "me"));
  setLogShowsReasons(true);
  assert.ok((await ok("vault.log", { limit: 5 })).some((e) => e.reason === "pay the invoice"));
  setLogShowsReasons(false);
  assert.ok(useVaultActivity.getState().events.some((e) => e.reason === "pay the invoice"));
  flushVaultActivity();
  await settle();
  assert.ok(stub.vaultFake.log.length > 0, "the log reached the native store in a batch");
});

test("a profile whose passwords a plugin keeps refuses agent sign-ins, naming the plugin", async () => {
  const { readFileSync } = await import("node:fs");
  const { startPlugins } = await import("../plugins/start.ts");
  const lifecycle = await import("../plugins/lifecycle.ts");
  const { usePlugins } = await import("../plugins/store.ts");
  const { choosePasswordManager } = await import("../site/passwordManager.ts");
  const { pluginChoice } = await import("../site/passwordManagerChoice.ts");
  const { consentToken } = await import("../telemetry/consentPeriod.ts");
  await freshWindow();
  const profile = S().settings.defaultProfileId;
  startPlugins();
  stub.pluginHost.folders = [{ name: "password-manager", status: "ok", text: readFileSync(new URL("../../../../../tests/fixtures/plugins/password-manager/plugin.json", import.meta.url), "utf8") }];
  await lifecycle.rescanPlugins(consentToken());
  await settle();
  assert.ok(lifecycle.requestPluginConsent("password-manager"));
  assert.ok(lifecycle.enablePlugin("password-manager", usePlugins.getState().consent.hash));
  await settle();
  choosePasswordManager(profile, pluginChoice("password-manager"));
  await settle();
  stub.controlSocket.peers[709] = NODE;
  const refused = await socketClient(709).call("vault.taskStart", { sites: ["one.example"] });
  assert.equal(refused.error.code, "password_manager_plugin");
  assert.match(refused.error.message, new RegExp(usePlugins.getState().listings["password-manager"].manifest.title));
  assert.equal(useVaultApproval.getState().request, null);
  choosePasswordManager(profile, "ardia");
  lifecycle.disablePlugin("password-manager");
  await settle();
});

const held = async (n = 200) => {
  for (let i = 0; i < n && !stub.vaultFake.heldSignIns.size; i++) await tick();
  return [...stub.vaultFake.heldSignIns.keys()].at(-1);
};

test("ending a task, closing its connection or locking the Mac cancels a sign-in already running, and the tab isn't reloaded", async () => {
  const { tab } = await freshWindow("https://one.example/login");
  stub.vaultFake.holdSignIns = true;
  try {
    for (const end of ["taskEnd", "close", "lock"]) {
      const connection = { taskEnd: 711, close: 712, lock: 713 }[end];
      stub.controlSocket.peers[connection] = NODE;
      const { call } = socketClient(connection);
      const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"] }));
      const pending = call("vault.login", { task: reply.result.task, site: "one.example", tab });
      const attempt = await held();
      assert.ok(attempt, `${end}: the sign-in reached the engine`);
      if (end === "taskEnd") dropTask(reply.result.task, "ended");
      if (end === "close") stub.emitControlClose(connection);
      if (end === "lock") stub.emitAppEvent({ type: "lockedOrAsleep" });
      await settle();
      assert.ok(stub.vaultFake.cancelledSignIns.includes(attempt), `${end}: the engine was told to stop`);
      if (end !== "close") assert.equal((await pending).error.code, end === "lock" ? "locked" : "task_expired");
    }
  } finally {
    stub.vaultFake.holdSignIns = false;
  }
});

test("moving a driven tab to another profile cancels its sign-in and stops driving it", async () => {
  const { tab } = await freshWindow("https://one.example/login");
  const other = S().createProfile({ name: "Work" });
  stub.vaultFake.holdSignIns = true;
  try {
    stub.controlSocket.peers[714] = NODE;
    const { call } = socketClient(714);
    const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"], tabs: [tab] }));
    const pending = call("vault.login", { task: reply.result.task, site: "one.example", tab });
    const attempt = await held();
    S().moveTabToProfile(tab, other);
    assert.equal(S().tabs[tab]?.profileId ?? other, other);
    await settle();
    assert.ok(stub.vaultFake.cancelledSignIns.includes(attempt));
    assert.equal((await pending).error.code, "denied");
    assert.deepEqual((await socketClient(714).ok("vault.status")).tasks[0].tabs, []);
  } finally {
    stub.vaultFake.holdSignIns = false;
  }
});

test("the sheet's request lives until Touch ID answers, and the client leaving dismisses Touch ID", async () => {
  await freshWindow();
  stub.vaultFake.holdAuth = true;
  try {
    stub.controlSocket.peers[715] = NODE;
    const { call } = socketClient(715);
    const started = call("vault.taskStart", { sites: ["one.example"] });
    for (let i = 0; i < 200 && !useVaultApproval.getState().request; i++) await tick();
    const { id } = useVaultApproval.getState().request;
    answerApproval(id, "allow");
    await settle();
    assert.equal(useVaultApproval.getState().request?.id, id, "the request stays while Touch ID is up");
    assert.equal(useVaultApproval.getState().checking, true);
    answerApproval(id, "deny");
    assert.equal(useVaultApproval.getState().request?.id, id, "a second answer while Touch ID is up changes nothing");
    stub.emitControlClose(715);
    await settle();
    assert.ok(stub.vaultFake.cancelledAuth.includes(id), "Touch ID was dismissed");
    assert.equal(useVaultApproval.getState().request, null);
    void started;
  } finally {
    stub.vaultFake.holdAuth = false;
  }
});

test("the reload after an automatic sign-in doesn't sign in again, even though it's a new document", async () => {
  const { tab } = await freshWindow("https://one.example/login");
  stub.controlSocket.peers[722] = NODE;
  const { call } = socketClient(722);
  await approved(call("vault.taskStart", { sites: ["one.example"], tabs: [tab] }));
  const before = stub.vaultFake.signIns.length;
  const form = (document) => emitEvent("vault.loginFormSeen", { epoch: "socket-vault-test", tab, origin: "https://one.example", hasUsername: true, hasPassword: true, hasOneTimeCode: false, mainFrame: true, document, at: 1 });
  form(40);
  await settle();
  form(41);
  await settle();
  assert.equal(stub.vaultFake.signIns.length, before + 1);
});

test("auto-fill runs once per tab at a time, never repeats a signed-in document, and gives up after a few transient failures", async () => {
  const { tab } = await freshWindow("https://one.example/login");
  stub.controlSocket.peers[716] = NODE;
  const { call } = socketClient(716);
  await approved(call("vault.taskStart", { sites: ["one.example"], tabs: [tab] }));
  const form = (document) => emitEvent("vault.loginFormSeen", { epoch: "socket-vault-test", tab, origin: "https://one.example", hasUsername: true, hasPassword: true, hasOneTimeCode: false, mainFrame: true, document, at: 1 });
  const before = stub.vaultFake.signIns.length;
  stub.vaultFake.holdSignIns = true;
  form(1);
  form(1);
  form(2);
  await settle();
  assert.equal(stub.vaultFake.signIns.length, before + 1, "one attempt at a time for the tab");
  stub.vaultFake.heldSignIns.get(await held())("submitted");
  stub.vaultFake.holdSignIns = false;
  await settle();
  form(1);
  await settle();
  assert.equal(stub.vaultFake.signIns.length, before + 1, "a submitted document isn't signed in again");
  stub.vaultFake.signInResult = { status: "failed" };
  stub.controlSocket.peers[723] = NODE;
  const fresh = socketClient(723);
  const { reply } = await approved(fresh.call("vault.taskStart", { sites: ["one.example"], tabs: [tab] }));
  dropTask((await socketClient(716).ok("vault.status")).tasks[0].task, "ended");
  const failingFrom = stub.vaultFake.signIns.length;
  for (const doc of [3, 4, 5, 6, 7]) {
    form(doc);
    await settle();
  }
  assert.equal(stub.vaultFake.signIns.length, failingFrom + 3, "three transient failures, then it stops");
  void reply;
});

test("a cold login shares the saved-login lookup the task started", async () => {
  await freshWindow();
  stub.controlSocket.peers[717] = NODE;
  const { call, ok } = socketClient(717);
  const lists = () => stub.engineCalls.filter((c) => c.domain === "passwords" && c.verb === "list").length;
  let open;
  stub.vaultFake.listGate = new Promise((resolve) => (open = resolve));
  try {
    const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"] }));
    const after = lists();
    const signedIn = ok("vault.login", { task: reply.result.task, site: "one.example" });
    await settle();
    open();
    await signedIn;
    assert.equal(lists(), after, "no second lookup");
  } finally {
    stub.vaultFake.listGate = null;
  }
});

test("docs/vault-methods.json, which the ardia command's CI checks against, is what the app's schemas write", async () => {
  const { readFileSync } = await import("node:fs");
  const { vaultMethodsJson } = await import("./socketVault.ts");
  const published = readFileSync(new URL("../../../../../docs/vault-methods.json", import.meta.url), "utf8");
  assert.equal(vaultMethodsJson(), published, "regenerate docs/vault-methods.json: node --no-warnings --import ./src/test-loader.mjs scripts/write-vault-methods.mjs");
});

test("no answer from the iPhone (its Don't Allow resolves null) or an answer with another nonce leaves the Mac sheet up", async () => {
  await freshWindow();
  const { phoneAnswered } = await import("../vault/approval.ts");
  stub.controlSocket.peers[718] = NODE;
  const { call } = socketClient(718);
  const started = call("vault.taskStart", { sites: ["one.example"] });
  for (let i = 0; i < 200 && !useVaultApproval.getState().request; i++) await tick();
  const { id } = useVaultApproval.getState().request;
  phoneAnswered(id, null);
  phoneAnswered(id, { allow: true, always: false, nonce: "not-the-request-nonce" });
  assert.equal(useVaultApproval.getState().request?.id, id, "a denial or a wrong nonce from the phone doesn't touch the Mac sheet");
  answerApproval(id, "deny");
  assert.equal((await started).error.code, "denied");
});

test("the iPhone's Allow grants the task and closes the Mac sheet only with the request's own nonce, while the request and its client are live", async () => {
  const { mock } = await import("node:test");
  const { phoneApprovals } = await import("../vault/approval.ts");
  const { liveTaskCount } = await import("../vault/tasks.ts");
  const real = { ...phoneApprovals };
  const asks = [];
  const cancelled = [];
  phoneApprovals.ask = (ask) => new Promise((answer) => asks.push({ ask, answer }));
  phoneApprovals.cancel = (id) => void cancelled.push(id);
  const sheetUp = async () => {
    for (let i = 0; i < 200 && !(useVaultApproval.getState().request && asks.length); i++) await tick();
    return asks.at(-1);
  };
  try {
    await freshWindow();
    stub.controlSocket.peers[719] = NODE;
    const { call } = socketClient(719);

    const granted = call("vault.taskStart", { sites: ["one.example"] });
    const first = await sheetUp();
    first.answer({ allow: true, always: false, nonce: first.ask.nonce, phone: "p1", signature: "s" });
    const reply = await granted;
    assert.equal(reply.result.via, "phone");
    assert.equal(useVaultApproval.getState().request, null, "the Mac sheet closed");
    assert.ok(!cancelled.includes(first.ask.id), "the phone's own answer isn't withdrawn");

    const wrong = call("vault.taskStart", { sites: ["one.example"] });
    const second = await sheetUp();
    second.answer({ allow: true, always: true, nonce: "f".repeat(32), phone: "p1", signature: "s" });
    await settle();
    assert.equal(useVaultApproval.getState().request?.id, second.ask.id, "an Allow with another nonce grants nothing");
    answerApproval(second.ask.id, "deny");
    assert.equal((await wrong).error.code, "denied");

    void call("vault.taskStart", { sites: ["one.example"] });
    const third = await sheetUp();
    stub.emitControlClose(719);
    await settle();
    const tasksBefore = liveTaskCount();
    third.answer({ allow: true, always: false, nonce: third.ask.nonce, phone: "p1", signature: "s" });
    await settle();
    assert.equal(liveTaskCount(), tasksBefore, "an Allow after the client left grants nothing");
    assert.ok(cancelled.includes(third.ask.id), "the phone side was withdrawn when the client left");

    stub.controlSocket.peers[720] = NODE;
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      const late = socketClient(720).call("vault.taskStart", { sites: ["one.example"] });
      const fourth = await sheetUp();
      mock.timers.tick(61_000);
      await settle();
      fourth.answer({ allow: true, always: false, nonce: fourth.ask.nonce, phone: "p1", signature: "s" });
      assert.equal((await late).error.code, "denied", "an Allow after the request ran out grants nothing");
      assert.equal(liveTaskCount(), tasksBefore);
    } finally {
      mock.timers.reset();
    }
  } finally {
    Object.assign(phoneApprovals, real);
  }
});

test("the session's move into the profile decides the answer: keys the person changed meanwhile are a conflict that still reloads, a partial or unconfirmed move is an error, and busy is its own code", async () => {
  const { tabReloads } = await import("../vault/signIn.ts");
  const real = tabReloads.reload;
  const reloaded = [];
  tabReloads.reload = async (tabId) => (reloaded.push(tabId), true);
  try {
    const { tab } = await freshWindow("https://one.example/login");
    stub.controlSocket.peers[721] = NODE;
    const { call } = socketClient(721);
    const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"] }));
    const login = (result) => ((stub.vaultFake.signInResult = result), call("vault.login", { task: reply.result.task, site: "one.example", tab }));

    const conflict = await login({ status: "signed_in", transfer: "complete", conflicts: 2 });
    assert.equal(conflict.error.code, "conflict");
    assert.deepEqual(reloaded, [tab], "a conflict still reloads: the profile has a session either way");
    assert.equal((await login({ status: "signed_in", transfer: "partial" })).error.code, "failed");
    assert.match((await login({ status: "signed_in", transfer: "sent" })).error.message, /couldn't confirm/);
    assert.equal((await login({ status: "signed_in", transfer: "timed_out" })).error.code, "failed");
    const busy = await login({ status: "busy" });
    assert.equal(busy.error.code, "busy");
    assert.match(busy.error.message, /try again shortly/);
    assert.equal(reloaded.length, 1, "nothing else reloaded");

    assert.equal((await login({ status: "submitted", transfer: "complete" })).result.status, "submitted");
    assert.equal(reloaded.length, 1, "submitted alone doesn't reload");
    const signedIn = await login({ status: "signed_in", transfer: "complete", profileMs: 2, seedMs: 1, loadMs: 30, scanMs: 1, transferMs: 3, blockedRequests: 2 });
    assert.equal(signedIn.result.transfer, "complete");
    assert.equal(signedIn.result.loadMs, 30);
    assert.equal(signedIn.result.conflicts, 0);
    assert.deepEqual(reloaded, [tab, tab]);

    assert.match((await login({ status: "cross_origin" })).error.message, /identity provider/);
    const counts = takeVaultCounts();
    assert.equal(counts.vault_conflict_keys, 2);
    assert.equal(counts.vault_refusals_conflict, 1);
    assert.equal(counts.vault_refusals_busy, 1);
    assert.equal(counts.vault_transfers_sent, 1);
    assert.equal(counts.vault_blocked_requests, 2);
    assert.ok(counts.vault_load_ms_count >= 1);
  } finally {
    tabReloads.reload = real;
  }
});

test("a failed sign-in names the engine's reason, and decideMs comes back with a success", async () => {
  const { tab } = await freshWindow("https://one.example/login");
  stub.controlSocket.peers[724] = NODE;
  const { call } = socketClient(724);
  const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"] }));
  takeVaultCounts();
  for (const reason of ["unreachable", "field_missing", "field_changed", "steps"]) {
    stub.vaultFake.signInResult = { status: "failed", reason };
    const failed = await call("vault.login", { task: reply.result.task, site: "one.example", tab });
    assert.equal(failed.error.code, "failed");
    assert.match(failed.error.message, new RegExp(`reason: ${reason}`));
  }
  stub.vaultFake.signInResult = { status: "signed_in", transfer: "complete", decideMs: 12, refills: 2 };
  const ok = await call("vault.login", { task: reply.result.task, site: "one.example", tab });
  assert.equal(ok.result.decideMs, 12);
  assert.equal(ok.result.refills, 2);
  const counts = takeVaultCounts();
  assert.equal(counts.vault_failures_steps, 1);
  assert.equal(counts.vault_failures_unreachable, 1);
  assert.equal(counts.vault_decide_ms_count, 1);
});

const heldCount = async (n) => {
  for (let i = 0; i < 200 && stub.vaultFake.heldSignIns.size < n; i++) await tick();
  return [...stub.vaultFake.heldSignIns.keys()];
};

function concurrentClient(connection) {
  let nextId = 1000;
  return (method, params) => {
    const id = ++nextId;
    stub.emitControlRequest({ connection, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, params }) });
    return (async () => {
      const mine = () => stub.controlSocket.replies.filter((r) => r.connection === connection).map((r) => JSON.parse(r.line)).filter((r) => r.id === id);
      for (let i = 0; i < 400 && !mine().length; i++) await tick();
      assert.equal(mine().length, 1, `one reply to ${method} ${id}`);
      return mine()[0];
    })();
  };
}

const later = (ms) => {
  const real = Date.now;
  Date.now = () => real() + ms;
  return () => (Date.now = real);
};

test("auto-fill waits while the task's own login for the site runs and for 30 s after it, then uses that login's account", async () => {
  const { tab } = await freshWindow("https://two.example/login");
  stub.controlSocket.peers[731] = NODE;
  const { call } = socketClient(731);
  const { reply } = await approved(call("vault.taskStart", { sites: ["two.example"], tabs: [tab] }));
  const form = (document) => emitEvent("vault.loginFormSeen", { epoch: "socket-vault-test", tab, origin: "https://two.example", hasUsername: true, hasPassword: true, hasOneTimeCode: false, mainFrame: true, document, at: 1 });
  takeVaultCounts();
  const before = stub.vaultFake.signIns.length;
  stub.vaultFake.holdSignIns = true;
  try {
    const manual = call("vault.login", { task: reply.result.task, site: "two.example", account: "b", tab });
    const [attempt] = await heldCount(1);
    form(50);
    await settle();
    assert.equal(stub.vaultFake.signIns.length, before + 1, "no auto-fill while the program's login runs");
    stub.vaultFake.heldSignIns.get(attempt)();
    assert.equal((await manual).result.status, "signed_in");
    form(51);
    await settle();
    assert.equal(stub.vaultFake.signIns.length, before + 1, "nor within 30 s after it");
  } finally {
    stub.vaultFake.holdSignIns = false;
  }
  const restore = later(31_000);
  try {
    form(52);
    await settle();
  } finally {
    restore();
  }
  assert.equal(stub.vaultFake.signIns.length, before + 2, "auto-fill comes back after the quiet");
  assert.equal(stub.vaultFake.signIns.at(-1).username, "b", "with the account the program used");
  const counts = takeVaultCounts();
  assert.equal(counts.vault_autofill_held_for_login, 2);
  assert.equal(counts.vault_refusals_bad_request ?? 0, 0);
});

test("a site with several saved logins and none named skips auto-fill and logs it, never a bad_request", async () => {
  const { tab } = await freshWindow("https://two.example/login");
  stub.controlSocket.peers[732] = NODE;
  const { call, ok } = socketClient(732);
  await approved(call("vault.taskStart", { sites: ["two.example"], tabs: [tab] }));
  const form = (document) => emitEvent("vault.loginFormSeen", { epoch: "socket-vault-test", tab, origin: "https://two.example", hasUsername: true, hasPassword: true, hasOneTimeCode: false, mainFrame: true, document, at: 1 });
  takeVaultCounts();
  const before = stub.vaultFake.signIns.length;
  form(60);
  await settle();
  form(60);
  await settle();
  assert.equal(stub.vaultFake.signIns.length, before, "nothing was signed in");
  const counts = takeVaultCounts();
  assert.equal(counts.vault_autofill_skipped_several, 1, "once per document");
  assert.equal(counts.vault_refusals_bad_request ?? 0, 0);
  const log = await ok("vault.log", { limit: 5 });
  assert.ok(log.some((e) => e.kind === "skip" && e.site === "https://two.example" && e.outcome === "several_logins" && e.via === "auto"));
  assert.ok(!log.some((e) => e.kind === "refusal" && e.outcome === "bad_request"));
});

const withoutAppMs = ({ appMs, reloaded, ...rest }) => rest;
const formOn = (tab, origin) => (document) => emitEvent("vault.loginFormSeen", { epoch: "socket-vault-test", tab, origin, hasUsername: true, hasPassword: true, hasOneTimeCode: false, mainFrame: true, document, at: 1 });
const releaseAll = () => {
  for (const resolve of [...stub.vaultFake.heldSignIns.values()]) resolve();
};

test("a second login for the same site, task and resolved account joins the running one instead of busy; another account runs after it, another site alongside", async () => {
  const { tab } = await freshWindow("https://one.example/login");
  stub.controlSocket.peers[733] = NODE;
  const { call } = socketClient(733);
  const { reply } = await approved(call("vault.taskStart", { sites: ["one.example", "two.example"] }));
  const task = reply.result.task;
  const together = concurrentClient(733);
  takeVaultCounts();
  const before = stub.vaultFake.signIns.length;
  stub.vaultFake.holdSignIns = true;
  try {
    const first = together("vault.login", { task, site: "one.example", tab });
    await heldCount(1);
    const named = together("vault.login", { task, site: "one.example", account: "me" });
    const twoA = together("vault.login", { task, site: "two.example", account: "a" });
    await heldCount(2);
    const twoB = together("vault.login", { task, site: "two.example", account: "b" });
    await settle();
    assert.equal(stub.vaultFake.signIns.length, before + 2, "one per site; the join and the other account don't reach the engine yet");
    releaseAll();
    const [a, b, c] = await Promise.all([first, named, twoA]);
    assert.equal(a.result.status, "signed_in");
    assert.deepEqual(withoutAppMs(b.result), withoutAppMs(a.result), "an account named the same as the running one's resolved account joins it");
    assert.equal(c.result.status, "signed_in");
    const [nextB] = await heldCount(1);
    assert.equal(stub.vaultFake.signIns.at(-1).username, "b", "the other account ran after the first");
    stub.vaultFake.heldSignIns.get(nextB)();
    assert.equal((await twoB).result.status, "signed_in");
  } finally {
    stub.vaultFake.holdSignIns = false;
  }
  const counts = takeVaultCounts();
  assert.equal(counts.vault_logins_joined, 1);
  assert.equal(counts.vault_refusals_busy ?? 0, 0);
  assert.equal(counts.vault_fills, 3, "a joined sign-in counts once");
});

test("when the first login fails choosing its account, a login waiting on the same lookup signs in on its own", async () => {
  await freshWindow();
  stub.controlSocket.peers[735] = NODE;
  const { call } = socketClient(735);
  let open;
  stub.vaultFake.listGate = new Promise((resolve) => (open = resolve));
  try {
    const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"] }));
    const together = concurrentClient(735);
    const before = stub.vaultFake.signIns.length;
    const wrong = together("vault.login", { task: reply.result.task, site: "one.example", account: "nobody" });
    const plain = together("vault.login", { task: reply.result.task, site: "one.example" });
    await settle();
    open();
    assert.equal((await wrong).error.code, "no_login");
    assert.equal((await plain).result.status, "signed_in");
    assert.equal(stub.vaultFake.signIns.length, before + 1);
  } finally {
    stub.vaultFake.listGate = null;
  }
});

test("a login arriving during an auto-fill joins it for the same account and takes over for another, without counting against auto-fill", async () => {
  const { tab } = await freshWindow("https://one.example/login");
  stub.controlSocket.peers[736] = NODE;
  const { call } = socketClient(736);
  const { reply } = await approved(call("vault.taskStart", { sites: ["one.example", "two.example"], tabs: [tab] }));
  const task = reply.result.task;
  const together = concurrentClient(736);
  takeVaultCounts();
  const before = stub.vaultFake.signIns.length;
  stub.vaultFake.holdSignIns = true;
  try {
    formOn(tab, "https://one.example")(70);
    await heldCount(1);
    const manual = together("vault.login", { task, site: "one.example", tab });
    await settle();
    assert.equal(stub.vaultFake.signIns.length, before + 1, "the login joined the auto-fill already signing in as the same account");
    releaseAll();
    assert.equal((await manual).result.status, "signed_in");
  } finally {
    stub.vaultFake.holdSignIns = false;
  }

  assert.equal((await call("vault.login", { task, site: "two.example", account: "a", tab })).result.status, "signed_in");
  const restore = later(31_000);
  stub.vaultFake.holdSignIns = true;
  try {
    formOn(tab, "https://two.example")(71);
    const [autoAttempt] = await heldCount(1);
    assert.equal(stub.vaultFake.signIns.at(-1).username, "a");
    const other = together("vault.login", { task, site: "two.example", account: "b", tab });
    for (let i = 0; i < 200 && !stub.vaultFake.cancelledSignIns.includes(autoAttempt); i++) await tick();
    assert.ok(stub.vaultFake.cancelledSignIns.includes(autoAttempt), "the auto-fill for another account was stopped");
    const [next] = await heldCount(1);
    assert.equal(stub.vaultFake.signIns.at(-1).username, "b");
    stub.vaultFake.heldSignIns.get(next)();
    assert.equal((await other).result.status, "signed_in");
  } finally {
    stub.vaultFake.holdSignIns = false;
    restore();
  }
  const counts = takeVaultCounts();
  assert.equal(counts.vault_logins_joined, 1);
  assert.equal(counts.vault_refusals_busy ?? 0, 0, "stepping aside isn't a refusal");
  assert.equal(counts.vault_refusals_task_expired ?? 0, 0);
});

test("a login that joined an auto-fill keeps its answer when a login for another account arrives, which waits its turn", async () => {
  const { tab } = await freshWindow("https://two.example/login");
  stub.controlSocket.peers[744] = NODE;
  const { call } = socketClient(744);
  const { reply } = await approved(call("vault.taskStart", { sites: ["two.example"], tabs: [tab] }));
  const task = reply.result.task;
  assert.equal((await call("vault.login", { task, site: "two.example", account: "a", tab })).result.status, "signed_in");
  const together = concurrentClient(744);
  const restore = later(31_000);
  stub.vaultFake.holdSignIns = true;
  try {
    formOn(tab, "https://two.example")(90);
    const [autoAttempt] = await heldCount(1);
    const joined = together("vault.login", { task, site: "two.example", account: "a" });
    await settle();
    const other = together("vault.login", { task, site: "two.example", account: "b" });
    await settle();
    assert.ok(!stub.vaultFake.cancelledSignIns.includes(autoAttempt), "a run a program's login shares isn't stopped");
    stub.vaultFake.heldSignIns.get(autoAttempt)();
    assert.equal((await joined).result?.status, "signed_in");
    const [next] = await heldCount(1);
    assert.equal(stub.vaultFake.signIns.at(-1).username, "b");
    stub.vaultFake.heldSignIns.get(next)();
    assert.equal((await other).result?.status, "signed_in");
  } finally {
    stub.vaultFake.holdSignIns = false;
    restore();
  }
});

test("ending the task answers every waiting login at once: running, joined, queued and still looking up", async () => {
  await freshWindow();
  stub.controlSocket.peers[737] = NODE;
  const { call } = socketClient(737);
  const { reply } = await approved(call("vault.taskStart", { sites: ["two.example"] }));
  const task = reply.result.task;
  const together = concurrentClient(737);
  stub.vaultFake.holdSignIns = true;
  try {
    const lead = together("vault.login", { task, site: "two.example", account: "a" });
    const [attempt] = await heldCount(1);
    const joined = together("vault.login", { task, site: "two.example", account: "a" });
    const queued = together("vault.login", { task, site: "two.example", account: "b" });
    await settle();
    dropTask(task, "ended");
    const answers = await Promise.all([lead, joined, queued]);
    assert.deepEqual(answers.map((a) => a.error?.code), ["task_expired", "task_expired", "task_expired"]);
    assert.ok(stub.vaultFake.cancelledSignIns.includes(attempt), "the engine was told to stop");
    assert.equal(stub.vaultFake.heldSignIns.size, 0);
  } finally {
    stub.vaultFake.holdSignIns = false;
  }

  stub.controlSocket.peers[738] = NODE;
  const second = socketClient(738);
  let open;
  stub.vaultFake.listGate = new Promise((resolve) => (open = resolve));
  try {
    const { reply: fresh } = await approved(second.call("vault.taskStart", { sites: ["one.example"] }));
    const looking = second.call("vault.login", { task: fresh.result.task, site: "one.example" });
    await settle();
    const before = stub.vaultFake.signIns.length;
    dropTask(fresh.result.task, "ended");
    assert.equal((await looking).error.code, "task_expired", "answered while the lookup still hangs");
    open();
    await settle();
    assert.equal(stub.vaultFake.signIns.length, before, "the late lookup starts nothing");
  } finally {
    stub.vaultFake.listGate = null;
  }
});

test("a joined login whose task ran out by the time the sign-in finished answers task_expired, not the shared success", async () => {
  const { tabReloads } = await import("../vault/signIn.ts");
  const real = tabReloads.reload;
  const reloaded = [];
  tabReloads.reload = async (tabId, mayAct) => (mayAct() && reloaded.push(tabId), true);
  const { tab } = await freshWindow("https://one.example/login");
  stub.controlSocket.peers[739] = NODE;
  const { call } = socketClient(739);
  const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"] }));
  const together = concurrentClient(739);
  stub.vaultFake.holdSignIns = true;
  let restore = () => undefined;
  try {
    const lead = together("vault.login", { task: reply.result.task, site: "one.example", tab });
    await heldCount(1);
    const joined = together("vault.login", { task: reply.result.task, site: "one.example" });
    await settle();
    restore = later(16 * 60_000);
    releaseAll();
    const answers = await Promise.all([lead, joined]);
    assert.deepEqual(answers.map((a) => a.error?.code), ["task_expired", "task_expired"]);
    assert.deepEqual(reloaded, [], "no tab reloads for a task that ran out");
  } finally {
    restore();
    stub.vaultFake.holdSignIns = false;
    tabReloads.reload = real;
  }
});

test("a joined login whose tab moved to another profile answers denied and isn't driven, while the login it joined still signs in", async () => {
  const { tab } = await freshWindow("https://one.example/login");
  const other = S().createProfile({ name: "Elsewhere" });
  stub.controlSocket.peers[743] = NODE;
  const { call, ok } = socketClient(743);
  const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"] }));
  const together = concurrentClient(743);
  stub.vaultFake.holdSignIns = true;
  try {
    const lead = together("vault.login", { task: reply.result.task, site: "one.example" });
    const [attempt] = await heldCount(1);
    const joined = together("vault.login", { task: reply.result.task, site: "one.example", tab });
    await settle();
    S().moveTabToProfile(tab, other);
    await settle();
    assert.ok(!stub.vaultFake.cancelledSignIns.includes(attempt), "the lead still wants the sign-in");
    stub.vaultFake.heldSignIns.get(attempt)();
    const [a, b] = await Promise.all([lead, joined]);
    assert.equal(a.result?.status, "signed_in");
    assert.equal(b.error?.code, "denied");
    assert.deepEqual((await ok("vault.status")).tasks[0].tabs, []);
  } finally {
    stub.vaultFake.holdSignIns = false;
  }
});

test("sibling origins of one site take turns instead of meeting the engine's busy, and only the exact origin shares a result", async () => {
  const { resetRegistrableLookupsForTest } = await import("../engines/siteDataDomains.ts");
  resetRegistrableLookupsForTest();
  const sites = stub.ardiaCoreNativeModules.ArdiaSites;
  const real = sites.call;
  sites.call = (verb, profile, json) => (verb === "registrableDomains" ? Promise.resolve(JSON.stringify({ domains: JSON.parse(json).hosts.map((h) => h.split(".").slice(-2).join(".")) })) : real(verb, profile, json));
  stub.passwordStores.set(null, new Map([login("https://a.three.example", "me"), login("https://b.three.example", "me")]));
  try {
    await freshWindow();
    stub.controlSocket.peers[740] = NODE;
    const { call } = socketClient(740);
    const { reply } = await approved(call("vault.taskStart", { sites: ["a.three.example", "b.three.example"] }));
    const together = concurrentClient(740);
    takeVaultCounts();
    const before = stub.vaultFake.signIns.length;
    stub.vaultFake.holdSignIns = true;
    try {
      const a = together("vault.login", { task: reply.result.task, site: "a.three.example" });
      const [first] = await heldCount(1);
      const b = together("vault.login", { task: reply.result.task, site: "b.three.example" });
      await settle();
      assert.equal(stub.vaultFake.signIns.length, before + 1, "the sibling waits its turn");
      stub.vaultFake.heldSignIns.get(first)();
      assert.equal((await a).result.status, "signed_in");
      const [second] = await heldCount(1);
      assert.equal(stub.vaultFake.signIns.at(-1).origin, "https://b.three.example", "and then signs in itself");
      stub.vaultFake.heldSignIns.get(second)();
      assert.equal((await b).result.status, "signed_in");
    } finally {
      stub.vaultFake.holdSignIns = false;
    }
    const counts = takeVaultCounts();
    assert.equal(counts.vault_logins_joined ?? 0, 0);
    assert.equal(counts.vault_refusals_busy ?? 0, 0);
  } finally {
    sites.call = real;
    resetRegistrableLookupsForTest();
  }
});

test("a site the task wasn't granted allocates no per-site state, and a tab the task stops driving drops its auto-fill memory", async () => {
  const { taskFor, undriveTab } = await import("../vault/tasks.ts");
  const { runningSignIns } = await import("../vault/signIn.ts");
  const { tab } = await freshWindow("https://one.example/login");
  stub.controlSocket.peers[741] = NODE;
  const { call } = socketClient(741);
  const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"], tabs: [tab] }));
  const { task } = taskFor(reply.result.task, 741);
  for (const site of ["two.example", "three.example", "four.example"]) assert.equal((await call("vault.login", { task: reply.result.task, site })).error.code, "not_granted");
  assert.equal(task.sites.size, 0);
  assert.equal(task.siteKeys.size, 0);
  assert.equal(runningSignIns(task), 0);
  formOn(tab, "https://one.example")(80);
  await settle();
  assert.equal(task.auto.size, 1);
  undriveTab(task, tab);
  assert.equal(task.auto.size, 0);
});

test("the conflict a sign-in reports stays a conflict even while the task's other sign-ins run", async () => {
  stub.controlSocket.peers[734] = NODE;
  const { call } = socketClient(734);
  const { reply } = await approved(call("vault.taskStart", { sites: ["one.example", "two.example"] }));
  const task = reply.result.task;
  const together = concurrentClient(734);
  stub.vaultFake.holdSignIns = true;
  try {
    const one = together("vault.login", { task, site: "one.example" });
    const two = together("vault.login", { task, site: "two.example", account: "a" });
    await heldCount(2);
    stub.vaultFake.signInResult = { status: "signed_in", transfer: "complete", conflicts: 1 };
    releaseAll();
    const answers = await Promise.all([one, two]);
    assert.deepEqual(answers.map((a) => a.error?.code), ["conflict", "conflict"]);
  } finally {
    stub.vaultFake.holdSignIns = false;
  }
});

test("evidence reaches the caller, and a weak submitted sign-in whose session moved reloads the tab while one with no evidence doesn't", async () => {
  const { tabReloads } = await import("../vault/signIn.ts");
  const real = tabReloads.reload;
  const reloaded = [];
  tabReloads.reload = async (tabId) => (reloaded.push(tabId), true);
  try {
    const { tab } = await freshWindow("https://one.example/login");
    stub.controlSocket.peers[742] = NODE;
    const { call } = socketClient(742);
    const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"] }));
    const login = (result) => ((stub.vaultFake.signInResult = result), call("vault.login", { task: reply.result.task, site: "one.example", tab }));
    takeVaultCounts();
    const weak = await login({ status: "submitted", evidence: "weak", transfer: "complete" });
    assert.equal(weak.result.status, "submitted");
    assert.equal(weak.result.evidence, "weak");
    assert.equal(weak.result.transfer, "complete");
    assert.deepEqual(reloaded, [tab], "the agent can check its page");
    const none = await login({ status: "submitted", evidence: "none", transfer: "none" });
    assert.equal(none.result.evidence, "none");
    assert.equal(none.result.transfer, "none");
    assert.equal((await login({ status: "submitted", evidence: "weak", transfer: "none" })).result.evidence, "weak");
    assert.deepEqual(reloaded, [tab], "nothing moved, nothing reloads");
    const strong = await login({ status: "signed_in", evidence: "strong", transfer: "complete" });
    assert.equal(strong.result.evidence, "strong");
    assert.equal((await login({ status: "signed_in", transfer: "complete" })).result.evidence, null);
    assert.deepEqual(reloaded, [tab, tab, tab]);
    const counts = takeVaultCounts();
    assert.equal(counts.vault_submitted_evidence_weak, 2);
    assert.equal(counts.vault_submitted_evidence_none, 1);
  } finally {
    tabReloads.reload = real;
  }
});

test("signals reach the caller as the engine's booleans and are counted, and get_form and error_page name themselves", async () => {
  stub.controlSocket.peers[748] = NODE;
  const { call } = socketClient(748);
  const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"] }));
  const login = (result) => ((stub.vaultFake.signInResult = result), call("vault.login", { task: reply.result.task, site: "one.example" }));
  takeVaultCounts();
  const weak = await login({ status: "submitted", evidence: "weak", transfer: "complete", signals: { navigated: false, httpOnlyCookie: true, formGone: true, pathChanged: false, extra: "x" } });
  assert.deepEqual(weak.result.signals, { navigated: false, httpOnlyCookie: true, formGone: true, pathChanged: false });
  assert.equal((await login({ status: "signed_in", transfer: "complete" })).result.signals, null);
  const getForm = await login({ status: "failed", reason: "get_form" });
  assert.equal(getForm.error.code, "failed");
  assert.match(getForm.error.message, /password in the page's address.*\(reason: get_form\)/);
  const errorPage = await login({ status: "failed", reason: "error_page" });
  assert.equal(errorPage.error.code, "failed");
  assert.match(errorPage.error.message, /error page \(reason: error_page\)/);
  const counts = takeVaultCounts();
  assert.equal(counts.vault_signals_session_cookie, 1);
  assert.equal(counts.vault_signals_form_gone, 1);
  assert.equal(counts.vault_signals_navigated ?? 0, 0);
  assert.equal(counts.vault_failures_get_form, 1);
  assert.equal(counts.vault_failures_error_page, 1);
});

test("cancelRequested reaches the caller and is counted when the engine finished a move it was asked to stop", async () => {
  stub.controlSocket.peers[749] = NODE;
  const { call } = socketClient(749);
  const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"] }));
  takeVaultCounts();
  stub.vaultFake.signInResult = { status: "signed_in", transfer: "complete", cancelRequested: true, cookies: 7 };
  const stopped = await call("vault.login", { task: reply.result.task, site: "one.example" });
  assert.equal(stopped.result.cancelRequested, true);
  assert.equal(stopped.result.transfer, "complete");
  stub.vaultFake.signInResult = { status: "signed_in", transfer: "complete" };
  assert.equal((await call("vault.login", { task: reply.result.task, site: "one.example" })).result.cancelRequested, false);
  assert.equal(takeVaultCounts().vault_stops_after_move, 1);
});

test("failed with no_submit_control names it", async () => {
  stub.controlSocket.peers[745] = NODE;
  const { call } = socketClient(745);
  const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"] }));
  takeVaultCounts();
  stub.vaultFake.signInResult = { status: "failed", reason: "no_submit_control" };
  const answer = await call("vault.login", { task: reply.result.task, site: "one.example" });
  assert.equal(answer.error.code, "failed");
  assert.match(answer.error.message, /no button or key that sends it \(reason: no_submit_control\)/);
  assert.equal(takeVaultCounts().vault_failures_no_submit_control, 1);
});

test("interrupted comes with any status but signed_in: an error names it, a submitted answer carries it as its reason", async () => {
  stub.controlSocket.peers[746] = NODE;
  const { call } = socketClient(746);
  const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"] }));
  const login = (result) => ((stub.vaultFake.signInResult = result), call("vault.login", { task: reply.result.task, site: "one.example" }));
  takeVaultCounts();
  const failed = await login({ status: "failed", reason: "interrupted" });
  assert.equal(failed.error.code, "failed");
  assert.match(failed.error.message, /interrupted before it finished \(reason: interrupted\)/);
  const noForm = await login({ status: "no_form", reason: "interrupted" });
  assert.equal(noForm.error.code, "no_form");
  assert.match(noForm.error.message, /didn't find a sign-in form.*\(reason: interrupted\)/);
  const stillOnLogin = await login({ status: "still_on_login", reason: "interrupted" });
  assert.equal(stillOnLogin.error.code, "needs_human");
  assert.match(stillOnLogin.error.message, /\(reason: interrupted\)/);
  const submitted = await login({ status: "submitted", evidence: "none", reason: "interrupted" });
  assert.equal(submitted.result.status, "submitted");
  assert.equal(submitted.result.reason, "interrupted");
  assert.equal(takeVaultCounts().vault_failures_interrupted, 4);
});

test("needs_human names the browser's own password dialog for a site (basic_auth) or a proxy (proxy_auth)", async () => {
  stub.controlSocket.peers[747] = NODE;
  const { call } = socketClient(747);
  const { reply } = await approved(call("vault.taskStart", { sites: ["one.example"] }));
  takeVaultCounts();
  for (const [reason, who] of [["basic_auth", /The site asks/], ["proxy_auth", /A proxy asks/]]) {
    stub.vaultFake.signInResult = { status: "needs_human", reason };
    const answer = await call("vault.login", { task: reply.result.task, site: "one.example" });
    assert.equal(answer.error.code, "needs_human");
    assert.match(answer.error.message, who);
    assert.match(answer.error.message, new RegExp(`\\(reason: ${reason}\\)`));
  }
  stub.vaultFake.signInResult = { status: "failed", reason: "something_new" };
  assert.match((await call("vault.login", { task: reply.result.task, site: "one.example" })).error.message, /\(reason: something_new\)/);
  const counts = takeVaultCounts();
  assert.equal(counts.vault_failures_basic_auth, 1);
  assert.equal(counts.vault_failures_proxy_auth, 1);
});
