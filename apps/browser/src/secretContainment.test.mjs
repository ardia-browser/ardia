import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

globalThis.__DEV__ = false;

const CANARY = {
  password: "Canary-Pw-7f3k!x-passw0rd",
  oauthToken: ["ghp", "CanaryOAuthToken0123456789abcdefXYZ"].join("_"),
  apiToken: "CanaryApiToken-9q8w7e6r5t4y3u2i",
  oauthClientSecret: "GOCSPX-CanaryClientSecret42zz",
  pluginSecret: "canary-plugin-secret-55-kv",
  syncPhrase: "canaryword alpha bravo charlie delta echo",
  devtoolsToken: "CanaryDevtoolsToken_q1w2e3r4t5y6u7i8o9p0",
};

const keychain = new Map([
  ["ardia.plugin.notes.apiKey", CANARY.pluginSecret],
  ["github", CANARY.oauthToken],
  ["notion", CANARY.apiToken],
  ["gdrive", JSON.stringify({ access_token: CANARY.oauthToken, refresh_token: `${CANARY.oauthToken}-refresh`, expires_at: Date.now() + 3_600_000, client_secret: CANARY.oauthClientSecret })],
]);
const keychainWrites = [];
globalThis.acTestNativeModules = {
  ArdiaKeychain: {
    get: async (account) => {
      const value = keychain.get(account) ?? null;
      if (heldKeychain) await heldKeychain;
      return value;
    },
    read: async (account) => (keychain.has(account) ? { status: "ok", value: keychain.get(account) } : { status: "missing" }),
    set: async (account, value) => (keychainWrites.push({ account, value }), keychain.set(account, value), !account.startsWith("ardia.plugin.refuse.")),
    delete: async (account) => keychain.delete(account),
  },
  ArdiaSync: {
    recoveryWords: async () => CANARY.syncPhrase.split(" "),
    enterPhrase: async (_account, text) => (enteredPhrases.push(text), { error: "mismatch" }),
    newDeviceId: () => "device-1",
  },
};
const enteredPhrases = [];

const posted = [];
let heldGithub = null;
let heldKeychain = null;
let heldGoogle = null;
let githubAnswers = false;
globalThis.fetch = async (url, init = {}) => {
  if (heldGoogle && /google\/token|oauth2\.googleapis/.test(String(url))) await heldGoogle;
  if ((heldGithub || githubAnswers) && String(url).includes("graphql")) {
    if (heldGithub) await heldGithub;
    const body = JSON.stringify({ data: { rateLimit: null, search: { nodes: [] }, viewer: { login: "me", name: null, avatarUrl: "" } } });
    return { status: 200, ok: true, headers: new Headers(), text: async () => body, json: async () => JSON.parse(body) };
  }
  posted.push({ url: String(url), headers: JSON.stringify(init.headers ?? {}), body: String(init.body ?? "") });
  const echoed = `Bad credentials: ${JSON.stringify(init.headers ?? {})} ${String(init.body ?? "")}`;
  const status = acceptTelemetry && String(url).includes("otel") ? 200 : 503;
  return { status, ok: status === 200, headers: new Headers(), text: async () => echoed, json: async () => ({}) };
};
let acceptTelemetry = false;

const stub = await import("./test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.0", appBuild: "300", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false });
stub.passwordStores.set(stub.current.device, new Map());
stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: true, decidedAt: 1, askDoneAt: 1, installId: "install-1", crashCursor: 0, lastVersion: "0.3.0", sessionOpen: false }));

const core = await import("../../../packages/core/src/secret.ts");
const { asSecret, reveal, isSecret, SECRET_KINDS, SecretEscapeError, secretsDropped, setSecretEscapeMode } = core;
const client = await import("./state/telemetry/client.ts");
const local = await import("./state/telemetry/localStore.ts");
const { recordLog } = await import("./state/telemetry/logs.ts");
const { captureException, installErrorReporting } = await import("./state/telemetry/errors.ts");
const { watchSecretDrops, takeSecretValuesDropped } = await import("./state/telemetry/secretDrops.ts");
const { fittedEvent, fittedReply } = await import("./state/automation/socketWire.ts");
const { getPluginSecret, setPluginSecret } = await import("./state/plugins/secrets.ts");
const { secretsMethod } = await import("./state/plugins/channelData.ts");
const { getSecret, googleTokensOf, bearer, basic } = await import("./state/live/net.ts");
const { getPassword, savePassword } = await import("./platform/passwords.ts");
const { recoveryWords } = await import("./state/sync/recoveryKit.ts");
const { controlDevtoolsEndpoint } = await import("./platform/automation.ts");
const { devtoolsEndpointLine } = await import("./state/automation/socketDevtools.ts");
const { Clock } = await import("../../../packages/sync/src/hlc.ts");
const { syncScope } = await import("../../../packages/sync/src/scope.ts");
const { emptyScope } = await import("../../../packages/sync/src/scopeState.ts");

client.startClient();
watchSecretDrops();
installErrorReporting();
after(() => {
  client.setSharing(false, "settings");
  local.flushLocal();
});

const PROFILE = "Default";
const ORIGIN = "https://login.example";

const SOURCES = {
  password: async () => {
    await savePassword(PROFILE, ORIGIN, "someone", asSecret("password", CANARY.password));
    return getPassword(PROFILE, ORIGIN, "someone");
  },
  oauthToken: async () => getSecret("github"),
  apiToken: async () => getSecret("notion"),
  oauthClientSecret: async () => googleTokensOf(await getSecret("gdrive")).client_secret,
  pluginSecret: async () => {
    const read = await getPluginSecret("notes", "apiKey");
    assert.ok(read.ok);
    return read.value;
  },
  syncPhrase: async () => recoveryWords(),
  devtoolsToken: async () => {
    stub.controlSocket.devtoolsEndpoint = () => ({ port: 41234, generation: 3, token: CANARY.devtoolsToken });
    const read = await controlDevtoolsEndpoint(1);
    assert.ok(!("problem" in read));
    return read.token;
  },
};

const SHAPED = new Set(["oauthToken"]);

async function telemetryText() {
  await client.saveQueueNow();
  local.flushLocal();
  return [stub.docs.get("telemetry-queue.json") ?? "", JSON.stringify(stub.telemetryLocal.records()), ...posted.filter((p) => p.url.includes("otel")).map((p) => p.body)].join("\n");
}

const queued = () => JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[],"logs":[]}');

const leaked = (text, kind) => [CANARY[kind], CANARY[kind].slice(6, 22)].filter((needle) => text.includes(needle));

function dropping(run) {
  const previous = setSecretEscapeMode("drop");
  try {
    return run();
  } finally {
    setSecretEscapeMode(previous);
  }
}

async function droppingAsync(run) {
  const previous = setSecretEscapeMode("drop");
  try {
    return await run();
  } finally {
    setSecretEscapeMode(previous);
  }
}

function memoryTransport() {
  const files = [];
  return {
    files,
    transport: {
      write: async (_scope, payload) => (files.push(payload), `f${files.length}`),
      read: async (_scope, known) => ({ files: files.map((payload, i) => ({ id: `f${i + 1}`, payload })).filter((f) => !known.includes(f.id)), pending: [], damaged: [], present: files.map((_, i) => `f${i + 1}`) }),
      remove: async () => {},
    },
  };
}

async function syncWith(mark, value) {
  const { files, transport } = memoryTransport();
  const t = 1_000_000;
  const adapter = { prefix: "x:", extract: () => ({ values: new Map([[`x:${mark}`, value]]) }), apply: () => {} };
  await syncScope({ scope: "s", state: emptyScope(), transport, adapters: [adapter], clock: new Clock("A", null, () => t), device: "A", now: () => t });
  return files.join("\n");
}

const SINKS = {
  async telemetryProps(secret, mark) {
    client.capture(`containment_${mark}`, { value: secret, label: "plain" }, client.consentNow());
    await client.saveQueueNow();
    return JSON.stringify(queued().events.filter((e) => e.event === `containment_${mark}`));
  },
  async telemetryRaw(secret, mark) {
    client.capture(`containment_${mark}`, { label: "plain" }, client.consentNow(), { raw: { nested: { deep: secret }, list: [secret] } });
    await client.saveQueueNow();
    return JSON.stringify(queued().events.filter((e) => e.event === `containment_${mark}`));
  },
  async localStore(secret, mark) {
    client.capture(`containment_${mark}`, { value: secret, label: "plain" }, client.consentNow());
    local.flushLocal();
    return JSON.stringify(stub.telemetryLocal.records().filter((r) => JSON.stringify(r).includes(`containment_${mark}`)));
  },
  async logArgument(secret, mark) {
    recordLog("error", [`[containment ${mark}] plain`, secret], client.consentToken());
    await client.saveQueueNow();
    return JSON.stringify(queued().logs.filter((l) => JSON.stringify(l).includes(mark)));
  },
  async logText(secret, mark) {
    recordLog("error", [`[containment ${mark}] failed with ${secret}`], client.consentToken());
    await client.saveQueueNow();
    return JSON.stringify(queued().logs.filter((l) => JSON.stringify(l).includes(mark)));
  },
  async consoleHook(secret, mark) {
    console.error(`[containment ${mark}] plain`, secret);
    await client.saveQueueNow();
    return JSON.stringify(queued().logs.filter((l) => JSON.stringify(l).includes(mark)));
  },
  async crashFields(secret, mark) {
    captureException(Object.assign(new Error(`crash ${mark}`), { token: secret, cause: secret }), "onerror");
    await client.saveQueueNow();
    return JSON.stringify(queued().events.filter((e) => JSON.stringify(e).includes(mark)));
  },
  async crashMessage(secret, mark) {
    captureException(new Error(`crash ${mark} while holding ${secret}`), "onerror");
    await client.saveQueueNow();
    return JSON.stringify(queued().events.filter((e) => JSON.stringify(e).includes(mark)));
  },
  async network(secret, mark) {
    client.capture(`containment_${mark}`, { value: secret }, client.consentNow());
    posted.length = 0;
    acceptTelemetry = true;
    try {
      await client.flush();
    } finally {
      acceptTelemetry = false;
    }
    return posted.filter((p) => p.url.includes("otel") && p.body.includes(`containment_${mark}`)).map((p) => p.body).join("\n");
  },
  async socketReply(secret, mark) {
    return fittedReply(2, { result: { mark, secret, list: [secret] } }, undefined, null);
  },
  async socketEvent(secret, mark) {
    return fittedEvent("tab.idle", 0, { mark, secret }, null);
  },
  async syncFiles(secret, mark) {
    return syncWith(mark, { s: secret, list: [secret] });
  },
};

const UNCOUNTED = new Set(["localStore", "network", "crashFields"]);

for (const kind of SECRET_KINDS) {
  test(`a ${kind} canary from its real source never reaches telemetry, logs, crash reports, sync files or the control socket`, async () => {
    const secret = await SOURCES[kind]();
    assert.ok(isSecret(secret), "the source hands out a branded secret");
    assert.equal(secret.kind, kind);
    assert.equal(reveal(secret), CANARY[kind], "positive control: the sink that needs it still gets the plaintext");

    assert.throws(() => JSON.stringify({ secret }), SecretEscapeError, "JSON refuses it in tests");
    assert.throws(() => `${secret}`, SecretEscapeError, "text refuses it in tests");
    assert.throws(() => client.capture("containment_throws", { secret }, client.consentNow()), SecretEscapeError, "capture doesn't swallow the refusal");
    assert.throws(() => fittedReply(1, { result: { secret } }, undefined, null), SecretEscapeError);
    assert.throws(() => fittedEvent("tab.idle", 0, { nested: [secret] }, null), SecretEscapeError);
    await assert.rejects(syncWith("throws", { v: secret }), SecretEscapeError);

    takeSecretValuesDropped();
    for (const [sink, run] of Object.entries(SINKS)) {
      const mark = `mk${sink}${kind}`;
      const before = secretsDropped();
      const output = await droppingAsync(() => run(secret, mark));
      assert.ok(output.includes(mark), `${sink} produced its output`);
      assert.deepEqual(leaked(output, kind), [], `${sink} leaked the canary`);
      if (!UNCOUNTED.has(sink)) assert.ok(secretsDropped() > before, `${sink} counted the dropped secret`);
    }
    assert.ok(takeSecretValuesDropped() > 0, "drops reach usage_counts while sharing");
    assert.deepEqual(leaked(await telemetryText(), kind), []);

    if (SHAPED.has(kind)) {
      const plain = reveal(secret);
      recordLog("error", ["[containment] shaped", new Error(`Bad credentials: ${plain}`)], client.consentToken());
      captureException(new Error(`request with ${plain} failed`), "onerror");
      client.capture("secret_containment_shaped", { reason: `token ${plain}` }, client.consentNow());
      assert.deepEqual(leaked(await telemetryText(), kind), [], "the scrubber catches the token's shape even once revealed");
    }
  });
}

test("a Linux follower window strips secrets before it relays telemetry to the leader", async () => {
  const { setTelemetryRelay } = await import("./state/telemetry/relay.ts");
  const relayed = [];
  setTelemetryRelay({
    capture: (event, props, _consent, options) => relayed.push({ event, props, raw: options.raw }),
    log: (_level, message, attributes) => relayed.push({ message, attributes }),
    resetId: async () => "",
    change: async () => true,
    installId: () => "install-1",
  });
  try {
    const secret = asSecret("apiToken", CANARY.apiToken);
    const before = secretsDropped();
    dropping(() => {
      client.capture("containment_relay", { value: secret, keep: 1 }, client.consentNow(), { raw: { deep: { secret } } });
      client.queueLog("error", "relay", { token: secret, keep: "yes" }, client.consentToken());
    });
    assert.deepEqual(relayed, [
      { event: "containment_relay", props: { keep: 1 }, raw: { deep: {} } },
      { message: "relay", attributes: { keep: "yes" } },
    ]);
    assert.equal(secretsDropped() - before, 3);
  } finally {
    setTelemetryRelay(null);
  }
});

test("dropped secrets are counted for usage_counts in production mode, and only while sharing", () => {
  takeSecretValuesDropped();
  const secret = asSecret("apiToken", CANARY.apiToken);
  dropping(() => {
    JSON.stringify({ secret });
    String(secret);
  });
  assert.equal(takeSecretValuesDropped(), 2);
  assert.equal(takeSecretValuesDropped(), 0);
  assert.equal(dropping(() => JSON.stringify({ a: 1, secret })), '{"a":1}');
  assert.equal(dropping(() => JSON.stringify([secret])), "[null]");
});

test("the legitimate sinks get the plaintext and nothing else does", async () => {
  const token = await getSecret("github");
  assert.equal(bearer(token), `Bearer ${CANARY.oauthToken}`);
  assert.ok(basic("me", token).startsWith("Basic "));
  const answered = await secretsMethod({ name: "notes", run: 1 }, { permissions: { secrets: true } }, "secrets.get", { key: "apiKey" });
  assert.deepEqual(answered, { result: CANARY.pluginSecret }, "the owning plugin reads its own secret");
  const refused = await secretsMethod({ name: "notes", run: 1 }, { permissions: { secrets: true } }, "secrets.set", { key: "bad key!", value: CANARY.pluginSecret });
  assert.deepEqual(leaked(JSON.stringify(refused), "pluginSecret"), []);
  const failed = await setPluginSecret("refuse", "apiKey", CANARY.pluginSecret);
  assert.equal(failed.ok, false);
  assert.deepEqual(leaked(JSON.stringify(failed), "pluginSecret"), []);
  assert.ok(keychainWrites.some((w) => w.account === "ardia.plugin.refuse.apiKey" && w.value === CANARY.pluginSecret), "the Keychain is the sink that stores it");
  const { enterRecoveryPhrase } = await import("./state/sync/engine.ts");
  await enterRecoveryPhrase("/sync", asSecret("syncPhrase", CANARY.syncPhrase)).catch(() => null);
  assert.deepEqual(enteredPhrases, [CANARY.syncPhrase], "the native sync module gets the phrase");
  const endpoint = await SOURCES.devtoolsToken();
  assert.deepEqual(JSON.parse(devtoolsEndpointLine(7, { port: 41234, generation: 3, token: endpoint })), { id: 7, result: { port: 41234, token: CANARY.devtoolsToken, generation: 3 } }, "control.devtoolsEndpoint's reply line carries the token to the admitted peer");
});

test("a malformed answer from a provider fails with Ardia's own words, not the provider's", async () => {
  const { request } = await import("./state/live/net.ts");
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, ok: true, headers: new Headers(), text: async () => "", json: async () => JSON.parse(`{"echo": ${CANARY.apiToken}`) });
  try {
    await assert.rejects(request("https://api.notion.com/v1/users/me"), (error) => error.kind === "other" && !String(error.message).includes(CANARY.apiToken));
  } finally {
    globalThis.fetch = saved;
  }
});

test("a provider that echoes the credential back can't put it into a Live folder's status or the socket's live.list", async () => {
  const { createFolder, live } = await import("./state/live/store.ts");
  const { refreshFolder } = await import("./state/live/engine.ts");
  const { useBrowser } = await import("./state/browser/store.ts");
  const profileId = useBrowser.getState().profileOrder[0] ?? "default";
  const folderId = createFolder(profileId, "documents", ["notion"]);
  posted.length = 0;
  await refreshFolder(folderId, true);
  const sent = posted.find((p) => p.url.includes("notion"));
  assert.ok(sent && sent.headers.includes(CANARY.apiToken), "positive control: the provider got the token");
  const status = live().status[folderId];
  assert.equal(status?.state, "error");
  assert.deepEqual(leaked(JSON.stringify(status), "apiToken"), []);
  assert.deepEqual(leaked(fittedReply(3, { result: { status } }, undefined, null), "apiToken"), []);
});

test("GitHub tokens are held only while their work runs, the stored account's is kept, and disconnecting lets it go", async () => {
  const { SOURCES: LIVE, connectGithub, disconnect, githubAccountsHeld } = await import("./state/live/sources.ts");
  const folder = { id: "f", profileId: "default", kind: "pullRequests", sources: ["github"], filters: { authored: true, review: true, team: false }, name: "PRs" };
  await LIVE.github.fetch(folder, { interactive: true }).catch(() => null);
  assert.equal(githubAccountsHeld(), 1, "the stored account's token stays held, so its rate limits are kept");
  const attempts = await Promise.allSettled(["a", "b", "c", "d", "e"].map((n) => connectGithub(`ghp_attempt${n}0123456789abcdefABCDEF`)));
  assert.ok(attempts.every((a) => a.status === "rejected"));
  assert.equal(githubAccountsHeld(), 1, "failed connection attempts don't keep their tokens");
  await disconnect("github");
  assert.equal(githubAccountsHeld(), 0);
  keychain.set("github", CANARY.oauthToken);
  let release;
  heldGithub = new Promise((resolve) => (release = resolve));
  const refreshing = LIVE.github.fetch(folder, { interactive: true }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(githubAccountsHeld(), 1, "a refresh in flight holds its token");
  await disconnect("github");
  release();
  heldGithub = null;
  assert.ok(Array.isArray(await refreshing), "positive control: the held refresh succeeds");
  assert.equal(githubAccountsHeld(), 0, "a refresh that settles after a disconnect lets the token go");
  keychain.set("github", CANARY.oauthToken);
  let releaseRead;
  heldKeychain = new Promise((resolve) => (releaseRead = resolve));
  const reading = LIVE.github.fetch(folder, { interactive: true }).then(() => "fetched", (error) => error.kind);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await disconnect("github");
  heldKeychain = null;
  releaseRead();
  assert.equal(await reading, "signedOut", "a token read before a disconnect isn't used after it");
  assert.equal(githubAccountsHeld(), 0);
  keychain.set("github", CANARY.oauthToken);
  let releaseOld;
  heldGithub = new Promise((resolve) => (releaseOld = resolve));
  const oldRefresh = LIVE.github.resolveGone([{ source: "github", id: "github:PR_old", section: "authored" }], { interactive: true }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await disconnect("github");
  heldGithub = null;
  githubAnswers = true;
  try {
    await connectGithub(CANARY.oauthToken);
    await LIVE.github.fetch(folder, { interactive: true });
  } finally {
    githubAnswers = false;
  }
  releaseOld();
  await oldRefresh;
  assert.equal(githubAccountsHeld(), 1, "a refresh from before a reconnect with the same token leaves the new account's kept scope alone");
});

test("Google's sign-in callback is consumed before tab state, events or recently closed tabs see its code", async () => {
  const { useBrowser } = await import("./state/browser/store.ts");
  const { connectGoogleDrive } = await import("./state/live/googleAuth.ts");
  const { consumedCallbackUrl } = await import("./state/tabs/callbackUrls.ts");
  const code = "4/0AcanaryAuthorizationCode";
  const windowId = useBrowser.getState().createWindow({ url: "https://a.example/" });
  const before = new Set(Object.keys(useBrowser.getState().tabs));
  const seen = [];
  const stopSeeing = useBrowser.subscribe((s) => seen.push(JSON.stringify(Object.values(s.tabs).map((t) => t.url))));
  posted.length = 0;
  const signIn = connectGoogleDrive(windowId, "client-id", CANARY.oauthClientSecret).catch(() => null);
  const tabId = Object.keys(useBrowser.getState().tabs).find((id) => !before.has(id));
  const state = new URL(useBrowser.getState().tabs[tabId].url).searchParams.get("state");
  const callback = `http://127.0.0.1:53682/ardia-oauth?state=${state}&code=${encodeURIComponent(code)}`;
  assert.equal(consumedCallbackUrl(tabId, "https://accounts.google.com/signin"), false, "other pages of the sign-in load as usual");
  assert.equal(consumedCallbackUrl(tabId, callback, callback), true, "the page's report of the callback is taken before tab state");
  await signIn;
  stopSeeing();
  assert.equal(useBrowser.getState().tabs[tabId], undefined, "the callback tab is closed");
  const token = posted.find((p) => p.url.includes("google/token") || p.url.includes("oauth2.googleapis.com"));
  assert.ok(token?.body.includes(encodeURIComponent(code)) && token.body.includes("code_verifier="), "positive control: the token request gets the code and verifier");
  const traces = [...seen, JSON.stringify(useBrowser.getState().closedTabs), JSON.stringify(useBrowser.getState().history ?? {})].join("\n");
  assert.ok(!traces.includes(callback) && !traces.includes("0AcanaryAuthorizationCode"), "no tab state, tab event or closed.list entry ever holds the callback");
  assert.equal(consumedCallbackUrl(tabId, callback), false, "the consumer is gone once the callback's tab is");
});

test("a superseded Google sign-in closes its tab unrecorded, and its late finish can't orphan the newer attempt", async () => {
  const { useBrowser } = await import("./state/browser/store.ts");
  const { connectGoogleDrive } = await import("./state/live/googleAuth.ts");
  const { consumedCallbackUrl } = await import("./state/tabs/callbackUrls.ts");
  const windowId = useBrowser.getState().createWindow({ url: "https://b.example/" });
  const opened = () => Object.keys(useBrowser.getState().tabs);
  const start = () => {
    const before = new Set(opened());
    const outcome = connectGoogleDrive(windowId, "client-id", CANARY.oauthClientSecret).then(() => "done", (error) => error.message);
    const tabId = opened().find((id) => !before.has(id));
    return { outcome, tabId, state: new URL(useBrowser.getState().tabs[tabId].url).searchParams.get("state") };
  };
  let releaseExchange;
  heldGoogle = new Promise((resolve) => (releaseExchange = resolve));
  const first = start();
  assert.equal(consumedCallbackUrl(first.tabId, `http://127.0.0.1:53682/ardia-oauth?state=${first.state}&code=4%2F0Afirst`), true);
  const second = start();
  assert.equal(await first.outcome, "Cancelled");
  heldGoogle = null;
  releaseExchange();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const third = start();
  assert.equal(await second.outcome, "Cancelled", "the newer attempt was still the one a later start cancels");
  assert.equal(useBrowser.getState().tabs[second.tabId], undefined, "a superseded attempt closes its tab");
  assert.ok(!JSON.stringify(useBrowser.getState().closedTabs).includes(second.state), "and leaves no recently closed entry");
  useBrowser.getState().closeTab(third.tabId);
  assert.equal(await third.outcome, "Sign-in was cancelled");
  const kept = start();
  const keptTab = useBrowser.getState().tabs[kept.tabId];
  const realClose = useBrowser.getState().closeTabs;
  useBrowser.setState({ closeTabs: () => {} });
  try {
    start();
    assert.equal(await kept.outcome, "Cancelled");
    assert.ok(keptTab && useBrowser.getState().tabs[kept.tabId], "a sign-in page that stays loaded, like a kept Top App");
    assert.equal(consumedCallbackUrl(kept.tabId, `http://127.0.0.1:53682/ardia-oauth?state=${kept.state}&code=4%2F0Alate`), true, "still has its callback taken while its tab lives");
  } finally {
    useBrowser.setState({ closeTabs: realClose });
  }
});

test("TabWebView hands a navigation to a callback consumer before anything records it", () => {
  const source = readFileSync(fileURLToPath(new URL("./components/window/TabWebView.tsx", import.meta.url)), "utf8");
  const handler = source.slice(source.indexOf("onNavigationChange={("));
  assert.match(handler.split("\n")[1] ?? "", /^\s*if \(consumedCallbackUrl\(tabId, reported, committedUrl\)\) return;$/);
});

test("an unreadable Google sign-in fails without echoing the stored value", () => {
  for (const stored of [`{"access_token": ${CANARY.oauthClientSecret}`, JSON.stringify({ access_token: CANARY.oauthClientSecret })]) {
    assert.throws(
      () => googleTokensOf(asSecret("oauthToken", stored)),
      (error) => !String(error.message).includes(CANARY.oauthClientSecret) && error.kind === "signedOut",
    );
  }
});

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCANNED = ["apps/browser/src", "apps/linux/src", "packages/core/src", "packages/sync/src", "packages/ardiacore/src", "packages/shell/src", "packages/import/src", "packages/phone/src"];
const SKIP = /\.test\.|\/secretSinkTypes\.ts$|\/test-native\/|\/node_modules\//;

const WRAP_SITES = {
  "apps/browser/src/platform/keychain.ts": ["*"],
  "apps/browser/src/platform/passwords.ts": ["password"],
  "apps/browser/src/state/site/savedPasswords.ts": ["password"],
  "apps/browser/src/state/import/apply.ts": ["password"],
  "apps/browser/src/components/settings/panes/ProfilePasswords.tsx": ["password"],
  "apps/browser/src/state/live/net.ts": ["oauthToken", "oauthClientSecret"],
  "apps/browser/src/state/live/sources.ts": ["oauthToken", "apiToken", "oauthClientSecret"],
  "apps/browser/src/state/live/googleAuth.ts": ["oauthToken"],
  "apps/browser/src/state/plugins/secrets.ts": ["pluginSecret"],
  "apps/browser/src/state/sync/recoveryKit.ts": ["syncPhrase"],
  "apps/browser/src/components/settings/panes/SyncSheets.tsx": ["syncPhrase"],
  "apps/linux/src/syncEngine.ts": ["syncPhrase"],
  "apps/linux/src/syncAuthority.ts": ["*"],
  "apps/browser/src/state/sync/engine.ts": ["syncPhrase"],
  "apps/browser/src/components/dev/devHarness.ts": ["syncPhrase"],
  "apps/browser/src/platform/automation.ts": ["devtoolsToken"],
};

const REVEAL_SINKS = {
  "apps/browser/src/platform/keychain.ts": { calls: 1, why: "the Keychain stores the plaintext" },
  "apps/browser/src/platform/passwords.ts": { calls: 2, why: "Chrome's password store saves and updates the plaintext" },
  "apps/browser/src/state/live/net.ts": { calls: 7, why: "Authorization headers and token request bodies to the account's own provider, and the Keychain copy of Google's tokens" },
  "apps/browser/src/state/plugins/channelData.ts": { calls: 1, why: "secrets.get answers the plugin that owns the secret" },
  "apps/browser/src/state/sync/engine.ts": { calls: 2, why: "the native sync module unlocks with the recovery phrase" },
  "apps/browser/src/components/settings/panes/ProfilePasswords.tsx": { calls: 1, why: "the password sheet shows and edits the password the user unlocked" },
  "apps/browser/src/components/settings/panes/SyncSheets.tsx": { calls: 1, why: "Show Words displays the recovery phrase to the user" },
  "apps/linux/src/importedPasswordSave.ts": { calls: 1, why: "Linux tells a CSV import handle, which its host resolves, from a typed password" },
  "apps/linux/src/liveSources.ts": { calls: 2, why: "Linux's host exchanges Google's authorization code and PKCE verifier for tokens" },
  "apps/browser/src/state/automation/socketDevtools.ts": { calls: 1, why: "control.devtoolsEndpoint writes the DevTools token on the reply line to the peer the socket admitted" },
  "apps/linux/src/syncAuthority.ts": { calls: 1, why: "a Linux window hands the recovery phrase to the window that runs sync, over the app's own channel, and it is branded again on arrival" },
};

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|tsx)$/.test(entry.name) && !SKIP.test(`/${path}`)) out.push(path);
    }
  };
  for (const dir of SCANNED) walk(dir);
  return out;
}

const ts = createRequire(import.meta.url)("typescript");
const CORE_MODULE = /^(?:@ardia\/core|.*\/packages\/core\/src(?:\/index(?:\.ts)?)?|\.{1,2}\/(?:.*\/)?secret(?:\.ts)?)$/;
const TRACKED = new Set(["asSecret", "reveal"]);

function secretUses(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bound = new Map();
  const namespaces = new Set();
  const uses = { kinds: new Set(), reveals: 0, problems: [] };
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !CORE_MODULE.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (TRACKED.has(imported)) bound.set(element.name.text, imported);
    }
  }
  for (const statement of tree.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier) || !CORE_MODULE.test(statement.moduleSpecifier.text)) continue;
    const named = statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements.map((e) => (e.propertyName ?? e.name).text) : null;
    if (!named || named.some((name) => TRACKED.has(name))) uses.problems.push("re-exports asSecret or reveal");
  }
  const trackedName = (node) => {
    if (ts.isIdentifier(node) && bound.has(node.text)) return bound.get(node.text);
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text) && TRACKED.has(node.name.text)) return node.name.text;
    return null;
  };
  const namespaceMember = (node) => ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node;
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isExportDeclaration(node)) {
      const local = !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : [];
      if (local.some((e) => bound.has((e.propertyName ?? e.name).text) || namespaces.has((e.propertyName ?? e.name).text))) uses.problems.push("re-exports asSecret or reveal");
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const target = node.arguments[0];
      if (!target || !ts.isStringLiteralLike(target) || CORE_MODULE.test(target.text)) uses.problems.push("requires the secret module");
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const target = node.arguments[0];
      if (!target || !ts.isStringLiteralLike(target) || CORE_MODULE.test(target.text)) uses.problems.push("imports the secret module dynamically");
    }
    if (ts.isCallExpression(node)) {
      const name = trackedName(node.expression);
      if (name === "reveal") uses.reveals++;
      if (name === "asSecret") {
        const kind = node.arguments[0];
        uses.kinds.add(kind && ts.isStringLiteral(kind) ? kind.text : "*");
      }
      if (name) {
        node.arguments.forEach(visit);
        return;
      }
    }
    if (ts.isIdentifier(node) && namespaces.has(node.text) && !namespaceMember(node)) {
      uses.problems.push(`namespace ${node.text} used other than as namespace.member`);
      return;
    }
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && trackedName(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      uses.problems.push(`${trackedName(node)} used as a value`);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return uses;
}

test("every secret kind has a containment case, and every place that makes or reveals a secret is registered", () => {
  assert.deepEqual(Object.keys(SOURCES).sort(), [...SECRET_KINDS].sort(), "a new secret kind needs a source in SOURCES and a canary in CANARY");
  assert.deepEqual(Object.keys(CANARY).sort(), [...SECRET_KINDS].sort());
  const wraps = {};
  const reveals = {};
  const problems = [];
  for (const file of sourceFiles()) {
    if (file.startsWith("packages/core/src/")) continue;
    const uses = secretUses(file, readFileSync(join(ROOT, file), "utf8"));
    if (uses.kinds.size) wraps[file] = [...uses.kinds].sort();
    if (uses.reveals) reveals[file] = uses.reveals;
    for (const problem of uses.problems) problems.push(`${file}: ${problem}`);
  }
  assert.deepEqual(problems, [], "call asSecret and reveal directly, so each call site is counted");
  const registered = Object.fromEntries(Object.entries(WRAP_SITES).map(([file, kinds]) => [file, [...kinds].sort()]));
  assert.deepEqual(wraps, registered, "a file that makes secrets is listed in WRAP_SITES with the kinds it makes");
  for (const kinds of Object.values(wraps)) for (const kind of kinds) assert.ok(kind === "*" || SECRET_KINDS.includes(kind), kind);
  assert.deepEqual(reveals, Object.fromEntries(Object.entries(REVEAL_SINKS).map(([file, sink]) => [file, sink.calls])), "reveal() runs only at a registered sink, as many times as REVEAL_SINKS says; add the call and why it needs the plaintext");
});

test("the registry scan finds aliased, namespaced and value uses of asSecret and reveal", () => {
  const uses = secretUses("x.ts", [
    'import { asSecret as brand, reveal as open } from "@ardia/core";',
    'import * as core from "../../packages/core/src/index.ts";',
    'brand("password", a); core.asSecret(kind, b); open(c); core.reveal(d);',
    "const leak = [x].map(open);",
    'const sneaky = core["reveal"](e);',
    "const { reveal: pulled } = core;",
    'export { reveal } from "@ardia/core";',
    "export { open as opened };",
    'const lazy = await import("@ardia/core");',
    'const { reveal: viaRequire } = require("@ardia/core");',
    'const other = require("./unrelated");',
  ].join("\n"));
  assert.deepEqual([...uses.kinds].sort(), ["*", "password"]);
  assert.equal(uses.reveals, 2);
  assert.deepEqual(uses.problems.sort(), ["imports the secret module dynamically", "requires the secret module", "namespace core used other than as namespace.member", "namespace core used other than as namespace.member", "re-exports asSecret or reveal", "re-exports asSecret or reveal", "reveal used as a value"].sort());
});
