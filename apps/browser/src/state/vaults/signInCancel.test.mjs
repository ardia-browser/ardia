import assert from "node:assert/strict";
import { test } from "node:test";
const native = await import("../../test-native/index.ts");
const store = await import("./store.ts");
const actions = await import("./actions.ts");

const caps = { totp: true, save: true, selfHosted: true, masterPassword: true, touchID: false };
const provider = (state) => ({ id: "bitwarden", name: "Bitwarden", state, capabilities: caps, install: { command: "", url: "" } });

async function slowly(start) {
  native.vaultFakes.providers = [provider("signedOut")];
  native.vaultFakes.cancelledSignIns.length = 0;
  store.clearVaultIndex();
  await store.loadVaultProviders();
  let release;
  native.vaultFakes.signInGate = new Promise((r) => (release = r));
  try {
    const running = start();
    await actions.cancelProviderSignIn("bitwarden");
    release();
    return await running;
  } finally {
    native.vaultFakes.signInGate = null;
  }
}

test("a sign-in cancelled while it runs leaves no signed-in state, even when its answer lands late", async () => {
  const result = await slowly(() => actions.signInProvider("bitwarden", { email: "a@b.c" }));
  assert.equal(result.ok, false);
  assert.equal(actions.wasCancelled(result), true);
  assert.equal(store.vaultProviderOf("bitwarden")?.state, "signedOut");
  assert.deepEqual(native.vaultFakes.cancelledSignIns, ["bitwarden"]);
});

test("an unlock cancelled while it runs leaves the manager as it was", async () => {
  const result = await slowly(() => actions.unlockProvider("bitwarden", "entry"));
  assert.equal(actions.wasCancelled(result), true);
  assert.notEqual(store.vaultProviderOf("bitwarden")?.state, "unlocked");
});

test("a sign-in that isn't cancelled still applies its answer", async () => {
  native.vaultFakes.providers = [provider("signedOut")];
  store.clearVaultIndex();
  await store.loadVaultProviders();
  const result = await actions.signInProvider("bitwarden", { email: "a@b.c" });
  assert.equal(result.ok, true);
  assert.equal(store.vaultProviderOf("bitwarden")?.state, "unlocked");
});

const { signInRequest } = await import("./signInRequest.ts");

async function signedOut() {
  native.vaultFakes.providers = [provider("signedOut")];
  native.vaultFakes.cancelledSignIns.length = 0;
  store.clearVaultIndex();
  await store.loadVaultProviders();
}

test("closing a sheet while its sign-in runs cancels it and drops the late answer", async () => {
  await signedOut();
  let release;
  native.vaultFakes.signInGate = new Promise((r) => (release = r));
  try {
    const sheet = signInRequest("bitwarden", "connected");
    const running = sheet.run(() => actions.signInProvider("bitwarden", { email: "a@b.c" }));
    sheet.close();
    release();
    assert.equal(await running, null);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.deepEqual(native.vaultFakes.cancelledSignIns, ["bitwarden"]);
    assert.equal(store.vaultProviderOf("bitwarden")?.state, "signedOut");
  } finally {
    native.vaultFakes.signInGate = null;
  }
});

test("closing an unlock sheet mid-unlock cancels it", async () => {
  native.vaultFakes.providers = [provider("locked")];
  native.vaultFakes.cancelledSignIns.length = 0;
  store.clearVaultIndex();
  await store.loadVaultProviders();
  let release;
  native.vaultFakes.signInGate = new Promise((r) => (release = r));
  try {
    const sheet = signInRequest("bitwarden", "unlocked");
    const running = sheet.run(() => actions.unlockProvider("bitwarden", "entry"));
    sheet.close();
    release();
    assert.equal(await running, null);
    assert.deepEqual(native.vaultFakes.cancelledSignIns, ["bitwarden"]);
    assert.notEqual(store.vaultProviderOf("bitwarden")?.state, "unlocked");
  } finally {
    native.vaultFakes.signInGate = null;
  }
});

test("a sheet waiting on the browser cancels on close, and one that's idle or done doesn't", async () => {
  await signedOut();
  const waiting = signInRequest("bitwarden", "connected");
  waiting.keepWaiting(true);
  waiting.close();
  const idle = signInRequest("bitwarden", "connected");
  idle.close();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(native.vaultFakes.cancelledSignIns, ["bitwarden"]);
  const done = signInRequest("bitwarden", "connected");
  assert.equal((await done.run(() => actions.signInProvider("bitwarden", { email: "a@b.c" })))?.ok, true);
  done.keepWaiting(true);
  done.close();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(native.vaultFakes.cancelledSignIns, ["bitwarden"]);
});
