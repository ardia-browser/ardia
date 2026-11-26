import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { Clock } from "../hlc.ts";
import { syncScope, visible } from "../scope.ts";
import { emptyScope, type Adapter, type Listing, type LogFile, type ScopeState } from "../scopeState.ts";
import { VAULT_ANSWER, VAULT_KEY, VAULT_REQUEST, vaultChallenge, vaultKeyOf, vaultRequestsAdapter, type VaultAnswerRecord, type VaultRequestRecord } from "../vaultApproval.ts";
import { companionAnswerVault, companionVaultChallenge, companionVaultKey, companionView, runCompanionCycle } from "./cycle.ts";
import { companionLoad, type CompanionState, type Host } from "./state.ts";

const START = Date.UTC(2026, 10, 22);
const PHONE = "phone0000000000000000000000";
const MAC = "mac00000000000000000000000";
const OTHER_MAC = "mac11111111111111111111111";
const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const NONCE = "n0nce-0123456789abcdef";

const fingerprintOf = (raw: Buffer) => createHash("sha256").update(raw).digest("hex").slice(0, 20).toUpperCase().match(/.{4}/g)!.join(" ");
const rawKey = (key: KeyObject) => Buffer.from(key.export({ format: "jwk" }).x!, "base64url").length === 32 ? Buffer.concat([Buffer.from([4]), Buffer.from(key.export({ format: "jwk" }).x!, "base64url"), Buffer.from(key.export({ format: "jwk" }).y!, "base64url")]) : Buffer.alloc(0);
const publicFromRaw = (raw: Buffer) => ({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33, 65).toString("base64url") }, format: "jwk" as const, dsaEncoding: "ieee-p1363" as const });

class Folder {
  files = new Map<string, Map<string, string>>();
  counter = 0;
  now = START;
  scope(name: string) {
    let s = this.files.get(name);
    if (!s) this.files.set(name, (s = new Map()));
    return s;
  }
  listing(scope: string, known: string[]): Listing {
    const listing: Listing = { files: [], pending: [], damaged: [], present: [] };
    for (const [id, payload] of this.scope(scope)) {
      listing.present.push(id);
      if (!known.includes(id)) listing.files.push({ id, payload });
    }
    return listing;
  }
  add(scope: string, payload: string) {
    const id = `f${String(++this.counter).padStart(4, "0")}`;
    this.scope(scope).set(id, payload);
    return id;
  }
}

class Mac {
  state: ScopeState = emptyScope();
  clock: Clock;
  store = new Map<string, unknown>();
  live: VaultRequestRecord[] = [];
  answers: { request: VaultRequestRecord; answer: VaultAnswerRecord }[] = [];
  rejected: VaultAnswerRecord[] = [];
  trusted = new Map<string, Buffer>();
  readonly folder: Folder;
  readonly id: string;
  constructor(folder: Folder, id = MAC) {
    this.folder = folder;
    this.id = id;
    this.clock = new Clock(id, null, () => folder.now);
    this.store.set(`dev:${id}`, { n: id === MAC ? "MacBook Pro" : "Mac mini" });
  }
  ask(overrides: Partial<VaultRequestRecord> = {}) {
    const request: VaultRequestRecord = { id: ID, n: NONCE, p: "profile-local-1", pn: "Personal", g: "node, unsigned", s: ["https://github.com", "https://accounts.example"], w: "deploy the docs", x: this.folder.now + 120_000, m: this.id, ao: true, at: this.folder.now, ...overrides };
    this.live.push(request);
    return request;
  }
  adapters(): Adapter[] {
    return [
      { prefix: "dev:", extract: () => ({ values: new Map([...this.store].filter(([k]) => k.startsWith("dev:"))), ignore: (k) => k !== `dev:${this.id}` }), apply: () => true },
      vaultRequestsAdapter({
        me: this.id,
        live: () => this.live,
        author: (key) => this.state.records[key]?.o?.[0],
        trusts: () => [...this.trusted].map(([phone, raw]) => ({ phone, f: fingerprintOf(raw) })),
        isPhone: (device) => (visible(this.state, "dev:").get(`dev:${device}`) as { k?: string } | undefined)?.k === "phone",
        answered: (request, answer) => {
          const raw = this.trusted.get(answer.by);
          const good = !answer.a || (!!raw && verify("sha256", Buffer.from(vaultChallenge(request, answer.by, answer.a, answer.al)), publicFromRaw(raw), Buffer.from(answer.sig, "base64")));
          if (!good) return void this.rejected.push(answer);
          this.live = this.live.filter((r) => r.id !== request.id);
          this.answers.push({ request, answer });
        },
      }),
    ];
  }
  async sync() {
    await syncScope({
      scope: "app",
      state: this.state,
      transport: {
        write: async (scope, payload) => this.folder.add(scope, payload),
        read: async (scope, known) => this.folder.listing(scope, known),
        remove: async () => {},
      },
      adapters: this.adapters(),
      clock: this.clock,
      device: this.id,
      now: () => this.folder.now,
    });
  }
  vaultKeys() {
    return [...visible(this.state, "vault:").keys()].filter((k) => k.startsWith(VAULT_REQUEST) || k.startsWith(VAULT_ANSWER));
  }
}

class Phone {
  stateJSON: string | null = null;
  journal: Record<string, LogFile[]> = {};
  readonly folder: Folder;
  constructor(folder: Folder) {
    this.folder = folder;
  }
  host(): Host {
    return {
      chainStatus: () => "ok",
      read: (scope, known) => JSON.stringify(this.folder.listing(scope, JSON.parse(known) as string[])),
      write: (scope, payload) => this.folder.add(scope, payload),
      remove: () => "",
      persistJournal: (scope, batches) => {
        const list = (this.journal[scope] ??= []);
        for (const f of (JSON.parse(batches) as string[]).map((raw) => JSON.parse(raw) as LogFile)) if (!list.some((x) => x.seq === f.seq)) list.push(f);
        return "ok";
      },
      saveState: (json) => {
        this.stateJSON = json;
        return "ok";
      },
    };
  }
  launch() {
    (globalThis as { __host?: Host }).__host = this.host();
    companionLoad({ device: PHONE, state: this.stateJSON ? (JSON.parse(this.stateJSON) as CompanionState) : null, journal: this.journal, fresh: !this.stateJSON });
    return this;
  }
  async cycle() {
    (globalThis as { __host?: Host }).__host = this.host();
    return runCompanionCycle({ name: "iPhone", now: this.folder.now, tabs: [], visits: [] });
  }
  async requests() {
    const out = await this.cycle();
    return (out.view ?? companionView()).vaultRequests;
  }
  keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  raw = rawKey(this.keys.publicKey);
  enroll() {
    (globalThis as { __host?: Host }).__host = this.host();
    return companionVaultKey({ k: this.raw.toString("base64"), f: fingerprintOf(this.raw), at: this.folder.now });
  }
  answer(allow: boolean, always: boolean, id = ID) {
    (globalThis as { __host?: Host }).__host = this.host();
    const challenge = companionVaultChallenge({ id, allow, always, at: this.folder.now });
    if (!("message" in challenge)) return challenge;
    const sig = sign("sha256", Buffer.from(challenge.message), { key: this.keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
    return companionAnswerVault({ id, allow, always, at: this.folder.now, sig });
  }
}

async function paired() {
  const folder = new Folder();
  const mac = new Mac(folder);
  const phone = new Phone(folder).launch();
  phone.enroll();
  await mac.sync();
  await phone.cycle();
  await mac.sync();
  const published = vaultKeyOf(`${VAULT_KEY}${PHONE}`, visible(mac.state, VAULT_KEY).get(`${VAULT_KEY}${PHONE}`));
  mac.trusted.set(PHONE, Buffer.from(published!.k, "base64"));
  await mac.sync();
  await phone.cycle();
  return { folder, mac, phone };
}

test("a Mac's request reaches the phone, Allow comes back bound to its nonce, and both records are cleaned up", async () => {
  const { folder, mac, phone } = await paired();
  const request = mac.ask();
  await mac.sync();
  const shown = await phone.requests();
  assert.deepEqual(shown, [{ id: ID, program: "node, unsigned", sites: ["https://github.com", "https://accounts.example"], why: "deploy the docs", profileName: "Personal", alwaysOffered: true, trusted: true, askedAt: request.at, expiresAt: request.x, fromDeviceId: MAC, fromDevice: "MacBook Pro" }]);
  assert.ok(!JSON.stringify(shown).includes(NONCE));
  assert.deepEqual(phone.answer(true, true), { saved: true });
  assert.deepEqual(phone.answer(false, false), { saved: false, refused: true });
  folder.now += 1000;
  const after = await phone.cycle();
  assert.deepEqual(after.view?.vaultRequests, []);
  await mac.sync();
  assert.equal(mac.answers.length, 1);
  assert.deepEqual({ allow: mac.answers[0]!.answer.a, always: mac.answers[0]!.answer.al, nonce: mac.answers[0]!.answer.n, by: mac.answers[0]!.answer.by }, { allow: true, always: true, nonce: NONCE, by: PHONE });
  await mac.sync();
  assert.deepEqual(mac.vaultKeys(), []);
  await phone.cycle();
  assert.equal(JSON.parse(phone.stateJSON!).vaultAnswers.length, 0);
});

test("Deny never carries Always allow", async () => {
  const { mac, phone } = await paired();
  mac.ask();
  await mac.sync();
  await phone.requests();
  phone.answer(false, true);
  await phone.cycle();
  await mac.sync();
  assert.deepEqual({ allow: mac.answers[0]!.answer.a, always: mac.answers[0]!.answer.al }, { allow: false, always: false });
});

test("when the Mac answers first its request goes away, the phone's sheet closes and a late answer is refused", async () => {
  const { mac, phone } = await paired();
  mac.ask();
  await mac.sync();
  assert.equal((await phone.requests())?.length, 1);
  mac.live = [];
  await mac.sync();
  assert.deepEqual(await phone.requests(), []);
  assert.deepEqual(phone.answer(true, false), { saved: false, refused: true });
  assert.deepEqual(mac.vaultKeys(), []);
});

test("an expired request is never shown and can't be answered", async () => {
  const { folder, mac, phone } = await paired();
  mac.ask({ x: folder.now + 5_000 });
  await mac.sync();
  assert.equal((await phone.requests())?.length, 1);
  folder.now += 6_000;
  assert.deepEqual(phone.answer(true, false), { saved: false, refused: true });
  assert.deepEqual(await phone.requests(), []);
});

test("the Mac takes no answer that doesn't match its request exactly, nor one a Mac wrote in the phone's name", async () => {
  const { folder, mac, phone } = await paired();
  const request = mac.ask();
  await mac.sync();
  await phone.requests();
  const other = new Mac(folder, OTHER_MAC);
  await other.sync();
  const forged = (changes: Partial<VaultAnswerRecord>, by = PHONE): VaultAnswerRecord => ({ id: ID, n: request.n, p: request.p, s: [...request.s], x: request.x, m: MAC, a: true, al: true, by, sig: "AAAA", at: folder.now, ...changes });
  for (const answer of [forged({ s: ["https://evil.example"] }), forged({ n: "replayed-nonce-0000000000" }), forged({ p: "another-profile" }), forged({ x: request.x + 1 }), forged({}, OTHER_MAC)]) {
    other.store.set(`${VAULT_ANSWER}${ID}`, answer);
    other.adapters = () => [{ prefix: "", extract: () => ({ values: new Map(other.store), ignore: (k) => !other.store.has(k) && !k.startsWith(VAULT_ANSWER) }), apply: () => true }];
    folder.now += 10;
    await other.sync();
    await mac.sync();
    assert.equal(mac.answers.length, 0, JSON.stringify(answer));
  }
  assert.ok(mac.vaultKeys().includes(`${VAULT_REQUEST}${ID}`));
  other.store.set(`${VAULT_ANSWER}${ID}`, forged({ a: false, al: false }));
  folder.now += 10;
  await other.sync();
  await mac.sync();
  assert.equal((visible(mac.state, VAULT_ANSWER).get(`${VAULT_ANSWER}${ID}`) as VaultAnswerRecord).by, PHONE);
  assert.equal(mac.answers.length, 0);
  phone.answer(true, false);
  await phone.cycle();
  await mac.sync();
  assert.deepEqual(mac.answers.map((a) => [a.answer.a, a.answer.by]), [[true, PHONE]]);
});

test("a request whose sites aren't plain https origins is dropped on the phone", async () => {
  const { mac, phone } = await paired();
  mac.ask({ s: ["http://plain.example"] });
  await mac.sync();
  assert.deepEqual(await phone.requests(), []);
});

test("where the Mac doesn't offer Always Allow, the phone is told so, its Always never goes out, and the Mac refuses an answer that claims it", async () => {
  const { folder, mac, phone } = await paired();
  const request = mac.ask({ ao: false });
  await mac.sync();
  assert.equal((await phone.requests())[0]!.alwaysOffered, false);
  phone.answer(true, true);
  await phone.cycle();
  await mac.sync();
  assert.deepEqual(mac.answers.map((a) => [a.answer.a, a.answer.al]), [[true, false]]);
  const taken: boolean[] = [];
  const adapter = vaultRequestsAdapter({ me: MAC, live: () => [request], isPhone: (d) => d === PHONE, author: () => PHONE, trusts: () => [], answered: (_r, answer) => void taken.push(answer.al) });
  const key = `${VAULT_ANSWER}${request.id}`;
  const claim = (al: boolean) => adapter.apply(new Map([[key, { id: request.id, n: request.n, p: request.p, s: [...request.s], x: request.x, m: MAC, a: true, al, by: PHONE, sig: "AAAA", at: folder.now }]]), new Set([key]), () => undefined, {} as never);
  claim(true);
  assert.deepEqual(taken, []);
  claim(false);
  assert.deepEqual(taken, [false]);
  assert.equal(request.ao, false);
});

test("the phone's key reaches the Mac, the view says whether this Mac trusts it, and an answer signed by an untrusted key or over another challenge is not taken", async () => {
  const folder = new Folder();
  const mac = new Mac(folder);
  const phone = new Phone(folder).launch();
  assert.equal(companionView().vaultKey, null);
  phone.enroll();
  await phone.cycle();
  await mac.sync();
  assert.equal(vaultKeyOf(`${VAULT_KEY}${PHONE}`, visible(mac.state, VAULT_KEY).get(`${VAULT_KEY}${PHONE}`))?.f, fingerprintOf(phone.raw));
  mac.ask();
  await mac.sync();
  const [shown] = await phone.requests();
  assert.equal(shown!.trusted, false);
  assert.equal(companionView().vaultKey, fingerprintOf(phone.raw));
  phone.answer(true, false);
  await phone.cycle();
  await mac.sync();
  assert.deepEqual([mac.answers.length, mac.rejected.length], [0, 1]);
  mac.trusted.set(PHONE, phone.raw);
  await mac.sync();
  assert.equal((await phone.requests()).length, 0);
  const impostor = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const request = mac.live[0]!;
  const forged = (message: string, key: KeyObject) => sign("sha256", Buffer.from(message), { key, dsaEncoding: "ieee-p1363" }).toString("base64");
  const key = `${VAULT_ANSWER}${request.id}`;
  const adapter = mac.adapters()[1]!;
  const apply = (answer: VaultAnswerRecord) => adapter.apply(new Map([[key, answer]]), new Set([key]), () => undefined, {} as never);
  mac.state.records[key] = { h: "0", v: null, o: [PHONE, 1] } as never;
  const base = { id: request.id, n: request.n, p: request.p, s: [...request.s], x: request.x, m: MAC, a: true, al: false, by: PHONE, at: folder.now };
  apply({ ...base, sig: forged(vaultChallenge(request, PHONE, true, false), impostor.privateKey) });
  apply({ ...base, sig: forged(vaultChallenge({ ...request, s: ["https://evil.example"] }, PHONE, true, false), phone.keys.privateKey) });
  apply({ ...base, sig: "" });
  apply({ ...base, a: false, sig: forged(vaultChallenge(request, PHONE, true, false), phone.keys.privateKey) });
  assert.deepEqual([mac.answers.length, mac.rejected.length], [0, 3]);
  apply({ ...base, sig: forged(vaultChallenge(request, PHONE, true, false), phone.keys.privateKey) });
  assert.deepEqual([mac.answers.length, mac.rejected.length], [1, 3]);
});

test("the challenge is length-prefixed, so no field can bleed into the next", () => {
  const request = { id: "0f0e0d0c-0b0a-4908-8706-050403020100", n: NONCE, p: "p:1", pn: "", g: "", s: ["https://a.example", "https://b.example"], w: "", x: 1_800_000_000_000, m: MAC, ao: true, at: 0 } satisfies VaultRequestRecord;
  assert.equal(vaultChallenge(request, PHONE, true, true), `20:ardia-vault-answer-136:${request.id}22:${NONCE}3:p:11:217:https://a.example17:https://b.example13:18000000000001:126:${MAC}27:${PHONE}1:11:1`);
  assert.notEqual(vaultChallenge({ ...request, s: ["https://a.example17:https://b.example"] }, PHONE, true, true), vaultChallenge(request, PHONE, true, true));
  assert.equal(vaultChallenge({ ...request, ao: false }, PHONE, true, true).endsWith("1:11:0"), true);
});

test("Don't Allow goes out unsigned and needs no trust, while an Allow without a signature is refused before it leaves the phone", async () => {
  const folder = new Folder();
  const mac = new Mac(folder);
  const phone = new Phone(folder).launch();
  await phone.cycle();
  await mac.sync();
  mac.ask();
  await mac.sync();
  assert.equal((await phone.requests())[0]!.trusted, false);
  (globalThis as { __host?: Host }).__host = phone.host();
  assert.deepEqual(companionAnswerVault({ id: ID, allow: true, always: false, at: folder.now }), { saved: false, refused: true });
  assert.deepEqual(companionAnswerVault({ id: ID, allow: false, always: true, at: folder.now }), { saved: true });
  await phone.cycle();
  await mac.sync();
  assert.deepEqual(mac.answers.map(({ answer }) => [answer.a, answer.al, answer.sig]), [[false, false, ""]]);
});
