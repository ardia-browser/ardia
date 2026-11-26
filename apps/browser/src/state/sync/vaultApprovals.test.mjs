import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
const { Clock, emptyScope, syncScope, visible, vaultAnswerFor, vaultChallenge, vaultRequestOf, vaultTrustKey, VAULT_ANSWER, VAULT_KEY, VAULT_REQUEST, VAULT_TRUST } = await import("@ardia/sync");
const { askPhoneForVaultApproval, cancelPhoneVaultApproval, connectVaultApprovals, forgetPhoneKey, phoneKeys, phonesInReach, trustPhoneKey, vaultApprovalsAdapter, vaultApprovalsAsking } = await import("./vaultApprovals.ts");
const { takeVaultPhoneApprovalCounts } = await import("../telemetry/vaultPhoneApprovalCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "vault-approvals-test");

const MAC = "mac00000000000000000000000";
const PHONE = "phone0000000000000000000000";
const NONCE = "nonce-0123456789abcdef";
const rawOf = (publicKey) => {
  const jwk = publicKey.export({ format: "jwk" });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
};
const fingerprintOf = (raw) => createHash("sha256").update(raw).digest("hex").slice(0, 20).toUpperCase().match(/.{4}/g).join(" ");
const publicFromRaw = (raw) => ({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33, 65).toString("base64url") }, format: "jwk", dsaEncoding: "ieee-p1363" });
const signWith = (privateKey, message) => sign("sha256", Buffer.from(message), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");

function testChannel(mac, extra) {
  const trusted = new Map();
  return {
    deviceId: () => MAC,
    usable: () => true,
    app: () => mac.state,
    profileName: () => "Personal",
    verify: (phone, message, signature) => {
      const raw = trusted.get(phone);
      if (!raw) return "unenrolled";
      return verify("sha256", Buffer.from(message), publicFromRaw(raw), Buffer.from(signature, "base64")) ? "ok" : "bad_signature";
    },
    trusted: () => [...trusted].map(([phone, raw]) => ({ phone, fingerprint: fingerprintOf(raw) })),
    fingerprint: (key) => fingerprintOf(Buffer.from(key, "base64")),
    trust: (phone, key) => void trusted.set(phone, Buffer.from(key, "base64")) || true,
    forget: (phone) => trusted.delete(phone),
    ...extra,
  };
}

let ids = 0;
const nextId = () => `0f0e0d0c-0b0a-4908-8706-${String(++ids).padStart(12, "0")}`;

class Folder {
  files = new Map();
  counter = 0;
  transport() {
    return {
      write: async (scope, payload) => {
        const id = `f${String(++this.counter).padStart(4, "0")}`;
        this.files.set(id, { scope, payload });
        return id;
      },
      read: async (scope, known) => {
        const here = [...this.files].filter(([, f]) => f.scope === scope);
        return { files: here.filter(([id]) => !known.includes(id)).map(([id, f]) => ({ id, payload: f.payload })), pending: [], damaged: [], present: here.map(([id]) => id) };
      },
      remove: async () => {},
    };
  }
}

function device(folder, id, adapters) {
  const state = emptyScope();
  const clock = new Clock(id, null);
  return { state, sync: () => syncScope({ scope: "app", state, transport: folder.transport(), adapters: adapters(state), clock, device: id, now: Date.now }) };
}

async function setUp({ phoneSeenDaysAgo = 0, enrolled = true } = {}) {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const raw = rawOf(keys.publicKey);
  const folder = new Folder();
  const answers = new Map();
  let cycles = 0;
  const mac = device(folder, MAC, (state) => [
    { prefix: "dev:", extract: () => ({ values: new Map([[`dev:${MAC}`, { n: "MacBook Pro" }]]), ignore: (k) => k !== `dev:${MAC}` }), apply: () => true },
    vaultApprovalsAdapter(MAC, () => state),
  ]);
  const phone = device(folder, PHONE, () => [
    { prefix: "dev:", extract: () => ({ values: new Map([[`dev:${PHONE}`, { n: "iPhone", k: "phone", f: ["send"] }]]), ignore: (k) => k !== `dev:${PHONE}` }), apply: () => true },
    { prefix: "vault:", extract: () => ({ values: new Map([...answers, [`${VAULT_KEY}${PHONE}`, { k: raw.toString("base64"), f: fingerprintOf(raw), by: PHONE, at: 1 }]]), ignore: (k) => !answers.has(k) && k !== `${VAULT_KEY}${PHONE}` }), apply: () => true },
  ]);
  await phone.sync();
  await mac.sync();
  if (phoneSeenDaysAgo) mac.state.seen[PHONE] = Date.now() - phoneSeenDaysAgo * 86_400_000;
  connectVaultApprovals(testChannel(mac, { cycleSoon: () => void cycles++ }));
  if (enrolled) assert.equal(trustPhoneKey(PHONE, fingerprintOf(raw), "vault-approvals-test"), true);
  cycles = 0;
  const phoneAnswers = async (allow, always, change = {}, signer = keys.privateKey) => {
    await phone.sync();
    const [key, value] = [...visible(phone.state, VAULT_REQUEST)][0];
    const request = vaultRequestOf(key, value);
    const sig = allow ? signWith(signer, vaultChallenge(request, PHONE, allow, always)) : "";
    answers.set(`${VAULT_ANSWER}${request.id}`, { ...vaultAnswerFor(request, allow, always, PHONE, Date.now(), sig), ...change });
    await phone.sync();
  };
  return { mac, phone, phoneAnswers, raw, cycles: () => cycles };
}

const ask = (overrides = {}) => ({ id: nextId(), nonce: NONCE, profile: "profile-1", program: "node, unsigned", sites: ["https://github.com"], why: "deploy", alwaysOffered: true, expiresAt: Date.now() + 60_000, ...overrides });

test("with no phone in reach, or sync not running, the answer is null at once, and that's counted", async () => {
  takeVaultPhoneApprovalCounts();
  assert.equal(await askPhoneForVaultApproval(ask(), "vault-approvals-test"), null);
  connectVaultApprovals(null);
  assert.equal(await askPhoneForVaultApproval(ask(), "vault-approvals-test"), null);
  await setUp({ phoneSeenDaysAgo: 30 });
  assert.deepEqual(phonesInReach(undefined), []);
  assert.equal(await askPhoneForVaultApproval(ask(), "vault-approvals-test"), null);
  assert.equal(takeVaultPhoneApprovalCounts().vault_phone_unreachable, 3);
  connectVaultApprovals(null);
});

test("the phone's Allow resolves the ask with its nonce, and the Mac then removes the request and the answer", async () => {
  takeVaultPhoneApprovalCounts();
  const { mac, phoneAnswers, cycles } = await setUp();
  const answer = askPhoneForVaultApproval(ask(), "vault-approvals-test");
  assert.equal(vaultApprovalsAsking(), true);
  assert.equal(cycles(), 1);
  await mac.sync();
  await phoneAnswers(true, true);
  await mac.sync();
  assert.deepEqual(await answer, { allow: true, always: true, nonce: NONCE, phone: PHONE, signature: (await answer).signature });
  assert.equal(vaultApprovalsAsking(), false);
  await mac.sync();
  assert.deepEqual([...visible(mac.state, "vault:").keys()].filter((k) => k.startsWith(VAULT_REQUEST) || k.startsWith(VAULT_ANSWER)), []);
  const counts = takeVaultPhoneApprovalCounts();
  assert.deepEqual([counts.vault_phone_asks, counts.vault_phone_allowed, counts.vault_phone_denied], [1, 1, 0]);
  connectVaultApprovals(null);
});

test("an answer for other sites or another nonce is not taken, and Mac-side cancel resolves null", async () => {
  const { mac, phoneAnswers } = await setUp();
  const request = ask();
  const answer = askPhoneForVaultApproval(request, "vault-approvals-test");
  await mac.sync();
  await phoneAnswers(true, false, { s: ["https://evil.example"] });
  await mac.sync();
  await phoneAnswers(true, false, { n: "another-nonce-00000000" });
  await mac.sync();
  assert.equal(vaultApprovalsAsking(), true);
  cancelPhoneVaultApproval(request.id);
  assert.equal(await answer, null);
  await mac.sync();
  assert.deepEqual([...visible(mac.state, VAULT_REQUEST).keys()], []);
  connectVaultApprovals(null);
});

test("an ask resolves null at its expiry, and malformed asks are refused at once", async () => {
  takeVaultPhoneApprovalCounts();
  await setUp();
  assert.equal(await askPhoneForVaultApproval(ask({ expiresAt: Date.now() + 30 }), "vault-approvals-test"), null);
  assert.equal(await askPhoneForVaultApproval(ask({ sites: ["http://plain.example"] }), "vault-approvals-test"), null);
  assert.equal(await askPhoneForVaultApproval(ask({ sites: ["https://a.example/path"] }), "vault-approvals-test"), null);
  assert.equal(await askPhoneForVaultApproval(ask({ nonce: "short" }), "vault-approvals-test"), null);
  assert.equal(await askPhoneForVaultApproval(ask({ id: "NOT AN ID" }), "vault-approvals-test"), null);
  assert.equal(await askPhoneForVaultApproval(ask({ expiresAt: Date.now() - 1 }), "vault-approvals-test"), null);
  const counts = takeVaultPhoneApprovalCounts();
  assert.deepEqual([counts.vault_phone_expired, counts.vault_phone_refused], [1, 5]);
  connectVaultApprovals(null);
});

test("an ask that doesn't offer Always Allow says so to the phone, and an answer claiming Always is not taken", async () => {
  const { mac, phone, phoneAnswers } = await setUp();
  const request = ask({ alwaysOffered: false });
  const answer = askPhoneForVaultApproval(request, "vault-approvals-test");
  await mac.sync();
  await phone.sync();
  assert.equal(vaultRequestOf(`${VAULT_REQUEST}${request.id}`, visible(phone.state, VAULT_REQUEST).get(`${VAULT_REQUEST}${request.id}`)).ao, false);
  await phoneAnswers(true, true, { al: true, sig: signWith(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey, "x") });
  await mac.sync();
  assert.equal(vaultApprovalsAsking(), true);
  await phoneAnswers(true, true);
  await mac.sync();
  assert.deepEqual(await answer, { allow: true, always: false, nonce: NONCE, phone: PHONE, signature: (await answer).signature });
  connectVaultApprovals(null);
});

test("a device holding the sync key can't answer in the phone's name: an answer that isn't signed by the phone's trusted key is not taken", async () => {
  const { mac, phoneAnswers } = await setUp();
  const answer = askPhoneForVaultApproval(ask(), "vault-approvals-test");
  await mac.sync();
  takeVaultPhoneApprovalCounts();
  const impostor = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await phoneAnswers(true, true, {}, impostor.privateKey);
  await mac.sync();
  assert.equal(vaultApprovalsAsking(), true, "an answer signed by another key settled the ask");
  await phoneAnswers(true, true, { sig: "AAAA" });
  await mac.sync();
  assert.equal(vaultApprovalsAsking(), true, "an unsigned answer written as the phone settled the ask");
  assert.equal(takeVaultPhoneApprovalCounts().vault_phone_bad_signature, 2);
  connectVaultApprovals(null);
  assert.equal(await answer, null);
});

test("a phone's key is trusted only once the owner confirms its fingerprint on the Mac; until then its answers are ignored, and forgetting it revokes it", async () => {
  takeVaultPhoneApprovalCounts();
  const { mac, phoneAnswers, raw } = await setUp({ enrolled: false });
  assert.deepEqual(phoneKeys(), [{ phone: PHONE, name: "iPhone", fingerprint: fingerprintOf(raw), trusted: false }]);
  const answer = askPhoneForVaultApproval(ask(), "vault-approvals-test");
  await mac.sync();
  await phoneAnswers(true, false);
  await mac.sync();
  assert.equal(vaultApprovalsAsking(), true);
  assert.equal(takeVaultPhoneApprovalCounts().vault_phone_unenrolled, 1);
  assert.equal(trustPhoneKey(PHONE, "0000 0000 0000 0000 0000", "vault-approvals-test"), false);
  assert.equal(trustPhoneKey(PHONE, fingerprintOf(raw), "vault-approvals-test"), true);
  assert.equal(phoneKeys()[0].trusted, true);
  await mac.sync();
  assert.deepEqual(visible(mac.state, VAULT_TRUST).get(vaultTrustKey(PHONE, MAC)), { f: fingerprintOf(raw), at: 0 });
  await phoneAnswers(true, false);
  await mac.sync();
  const settled = await answer;
  assert.deepEqual({ ...settled, signature: typeof settled.signature }, { allow: true, always: false, nonce: NONCE, phone: PHONE, signature: "string" });
  assert.equal(forgetPhoneKey(PHONE), true);
  await mac.sync();
  assert.equal(visible(mac.state, VAULT_TRUST).has(vaultTrustKey(PHONE, MAC)), false);
  assert.equal(phoneKeys()[0].trusted, false);
  connectVaultApprovals(null);
});

test("the phone's Don't Allow needs no signature and can't allow anything: it only drops the phone's side of that one request", async () => {
  takeVaultPhoneApprovalCounts();
  const { mac, phoneAnswers } = await setUp({ enrolled: false });
  const first = askPhoneForVaultApproval(ask(), "vault-approvals-test");
  await mac.sync();
  await phoneAnswers(false, false);
  await mac.sync();
  assert.equal(await first, null);
  assert.equal(takeVaultPhoneApprovalCounts().vault_phone_denied, 1);
  await mac.sync();
  assert.deepEqual([...visible(mac.state, VAULT_REQUEST).keys()], []);
  const second = askPhoneForVaultApproval(ask(), "vault-approvals-test");
  await mac.sync();
  assert.equal(vaultApprovalsAsking(), true);
  connectVaultApprovals(null);
  assert.equal(await second, null);
});

test("a denial from the phone, forged or not, leaves the Mac's own sheet waiting for the owner", async () => {
  const { askApproval, dropApprovals, useVaultApproval } = await import("../vault/approval.ts");
  const { programOf } = await import("../vault/programs.ts");
  const { mac, phoneAnswers } = await setUp();
  const outcome = askApproval({ windowId: "w1", connection: 7, profileId: "profile-1", profileName: "Personal", program: programOf(null, null), sites: ["https://github.com"], why: "deploy" }, () => true, "vault-approvals-test");
  const shown = useVaultApproval.getState().request;
  assert.ok(shown, "the Mac sheet opened");
  await mac.sync();
  await phoneAnswers(false, false);
  await mac.sync();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(useVaultApproval.getState().request?.id, shown.id);
  dropApprovals(7);
  assert.equal((await outcome).allow, false);
  connectVaultApprovals(null);
});
