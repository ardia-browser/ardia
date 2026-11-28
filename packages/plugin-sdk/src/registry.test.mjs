import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import {
  REGISTRY_ENVELOPE_VERSION,
  REGISTRY_SIGNATURE_DOMAIN,
  canonicalJson,
  currentPlatform,
  diffSecuritySurface,
  envelopeMessage,
  fromBase64,
  fromBase64Url,
  matchRevocations,
  pickArtifact,
  resolvePluginGraph,
  sameRegistry,
  signEnvelope,
  signOfficialArtifact,
  toBase64,
  toBase64Url,
  validatePluginDetail,
  validateRegistryIndex,
  validateRevocationList,
  verifyEnvelope,
  verifyOfficialArtifact,
  verifySignedJson,
  isNativeTier,
} from "./registry.ts";
import { satisfies } from "./semver.ts";

const keys = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicPem: publicKey.export({ type: "spki", format: "pem" }), privatePem: privateKey.export({ type: "pkcs8", format: "pem" }), raw: publicKey.export({ format: "jwk" }).x };
};

const RFC8032_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const VECTOR_PRIVATE = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(`302e020100300506032b657004220420${RFC8032_SEED}`, "hex").toString("base64")}\n-----END PRIVATE KEY-----\n`;
const RFC8032_PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

describe("canonical JSON", () => {
  test("follows the registry's encoding rules exactly", () => {
    assert.equal(canonicalJson(null), "null");
    assert.equal(canonicalJson(true), "true");
    assert.equal(canonicalJson(-0), "0");
    assert.equal(canonicalJson(1e21), "1e+21");
    assert.equal(canonicalJson(0.1), "0.1");
    assert.equal(canonicalJson({ b: 1, a: [true, null, "é"], c: undefined, d: { z: 1, y: 2 } }), '{"a":[true,null,"é"],"b":1,"d":{"y":2,"z":1}}');
    assert.equal(canonicalJson([undefined, () => 1, Symbol("s"), 2]), "[null,null,null,2]");
    assert.equal(canonicalJson([1, , 3]), "[1,null,3]");
    assert.equal(canonicalJson(new Date(Date.UTC(2026, 10, 25))), '"2026-11-25T00:00:00.000Z"');
    assert.equal(canonicalJson(Object.assign(Object.create(null), { b: 2, a: 1 })), '{"a":1,"b":2}');
    assert.equal(canonicalJson({ "é": 1, z: 2, A: 3, "😀": 4, "￿": 5 }), '{"A":3,"z":2,"é":1,"😀":4,"￿":5}');
    assert.equal(canonicalJson("line\nbreak \"q\""), JSON.stringify("line\nbreak \"q\""));
  });

  test("refuses what has no single encoding", () => {
    for (const bad of [NaN, Infinity, -Infinity, 1n, () => 1, Symbol("x"), undefined, new Map(), new (class Thing {})(), new Uint8Array(2), new Date(NaN)]) assert.throws(() => canonicalJson(bad), /canonicalJson/, String(bad));
    assert.throws(() => canonicalJson({ a: 1n }), /bigint/);
    assert.throws(() => canonicalJson({ a: () => 1 }), /function/);
    assert.throws(() => canonicalJson({ a: Symbol("s") }), /symbol/);
    assert.throws(() => canonicalJson("\ud800"), /lone surrogate/);
    assert.throws(() => canonicalJson({ "\udc00": 1 }), /lone surrogate/);
    assert.throws(() => canonicalJson(["ok", "x\udbffy"]), /lone surrogate/);
    const cycle = {};
    cycle.self = cycle;
    assert.throws(() => canonicalJson(cycle), /cycle/);
    const shared = { x: 1 };
    assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
  });

  test("base64url is unpadded and strict", () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 251) & 255);
    const encoded = toBase64Url(bytes);
    assert.match(encoded, /^[A-Za-z0-9_-]{86}$/);
    assert.equal(encoded, Buffer.from(bytes).toString("base64url"));
    assert.deepEqual(fromBase64Url(encoded), bytes);
    assert.equal(fromBase64Url(`${encoded}==`), null);
    assert.equal(fromBase64Url(toBase64(bytes)), null);
    assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  });
});

const KNOWN_SIG = "8SdVfS8Y7A9YUMpytXg2aI0vhkrywsZs7onnISW4i1hQXijanDsh2yZxwcqTigR6OgkQTLDN3IUAaRYRDwFnDQ";

describe("signed envelopes", () => {
  test("the signed bytes are the domain plus canonical {v, kid, payload}, checked against node:crypto", async () => {
    const payload = { seq: 7, generatedAt: "2026-11-25T00:00:00Z", plugins: [], z: { b: [1, null], a: "ü" } };
    assert.equal(REGISTRY_ENVELOPE_VERSION, 1);
    assert.equal(REGISTRY_SIGNATURE_DOMAIN, "ardia-registry-v1\n");
    const expected = `ardia-registry-v1\n{"kid":"r2026","payload":{"generatedAt":"2026-11-25T00:00:00Z","plugins":[],"seq":7,"z":{"a":"ü","b":[1,null]}},"v":1}`;
    assert.equal(Buffer.from(envelopeMessage("r2026", payload)).toString("utf8"), expected);
    const envelope = await signEnvelope(payload, "r2026", VECTOR_PRIVATE);
    const nodeSig = nodeSign(null, Buffer.from(expected, "utf8"), createPrivateKey(VECTOR_PRIVATE)).toString("base64url");
    assert.equal(envelope.sig, nodeSig, "Ed25519 is deterministic, so both sides make the same signature");
    assert.match(envelope.sig, /^[A-Za-z0-9_-]{86}$/);
    const publicPem = createPublicKey(VECTOR_PRIVATE).export({ type: "spki", format: "pem" });
    assert.equal(Buffer.from(createPublicKey(VECTOR_PRIVATE).export({ format: "jwk" }).x, "base64url").toString("hex"), RFC8032_PUBLIC);
    assert.equal(envelope.sig, KNOWN_SIG, "the vector signature both repos check");
    assert.equal(nodeVerify(null, Buffer.from(expected, "utf8"), createPublicKey(VECTOR_PRIVATE), Buffer.from(envelope.sig, "base64url")), true);
    assert.deepEqual(await verifyEnvelope(envelope, { r2026: publicPem }), { ok: true, kid: "r2026", payload });
    const foreign = { v: 1, kid: "r2026", sig: nodeSig, payload: JSON.parse(JSON.stringify(payload)) };
    assert.equal((await verifyEnvelope(foreign, { r2026: publicPem })).ok, true, "an envelope node:crypto signed verifies here");
  });

  test("a signed envelope verifies with its key, by PEM or raw key, and nothing else", async () => {
    const k = keys();
    const other = keys();
    const payload = { plugins: [{ id: "@a/b", name: "B" }], note: "ünïcode" };
    const envelope = await signEnvelope(payload, "k1", k.privatePem);
    assert.equal(envelope.v, 1);
    assert.deepEqual(await verifyEnvelope(envelope, { k1: k.publicPem }), { ok: true, kid: "k1", payload });
    assert.equal((await verifyEnvelope(envelope, new Map([["k1", k.raw]]))).ok, true);
    assert.deepEqual(await verifyEnvelope(envelope, { k1: other.publicPem }), { ok: false, reason: "The signature doesn't match" });
    assert.deepEqual(await verifyEnvelope(envelope, { k2: k.publicPem }), { ok: false, reason: "No trusted key has the id k1" });
    assert.equal((await verifyEnvelope({ ...envelope, payload: { ...payload, note: "x" } }, { k1: k.publicPem })).ok, false);
    assert.equal((await verifyEnvelope({ ...envelope, kid: "k2" }, { k2: k.publicPem })).ok, false);
    assert.equal((await verifyEnvelope({ ...envelope, extra: 1 }, { k1: k.publicPem })).reason, "The envelope has unknown keys: extra");
    assert.equal((await verifyEnvelope({ ...envelope, v: 2 }, { k1: k.publicPem })).reason, "The envelope's v must be 1");
    const padded = Buffer.from(envelope.sig, "base64url").toString("base64");
    assert.equal((await verifyEnvelope({ ...envelope, sig: padded }, { k1: k.publicPem })).reason, "The signature isn't 64 bytes of unpadded base64url");
    assert.equal((await verifyEnvelope({ ...envelope, sig: `${envelope.sig} ` }, { k1: k.publicPem })).ok, false);
    assert.equal((await verifyEnvelope({ ...envelope, sig: "AAAA" }, { k1: k.publicPem })).ok, false);
    assert.equal((await verifyEnvelope({ ...envelope, payload: { bad: "\ud800" } }, { k1: k.publicPem })).ok, false);
    assert.equal((await verifyEnvelope(envelope, { k1: "not a key" })).ok, false);
    await assert.rejects(signEnvelope(payload, "bad kid!", k.privatePem));
    const colon = await signEnvelope(payload, "prod:2026", k.privatePem);
    assert.equal((await verifyEnvelope(colon, { "prod:2026": k.publicPem })).ok, true);
    await assert.rejects(signEnvelope(payload, "k".repeat(129), k.privatePem));
    assert.equal((await verifyEnvelope({ ...colon, kid: "prod 2026" }, { "prod 2026": k.publicPem })).ok, false);
    await assert.rejects(signEnvelope(payload, "k1", "nope"));
  });

  test("verifySignedJson checks the signature, then the body", async () => {
    const k = keys();
    const list = { seq: 4, issuedAt: "2026-11-25T00:00:00Z", entries: [revocation({ match: { id: "@a/b", versions: ["<1.2.0"] }, action: "block", seq: 4 })] };
    const envelope = await signEnvelope(list, "r1", k.privatePem);
    assert.equal((await verifySignedJson(envelope, { r1: k.publicPem }, (body) => validateRevocationList(body, { minSeq: 3 }))).ok, true);
    assert.deepEqual(await verifySignedJson(envelope, { r1: k.publicPem }, (body) => validateRevocationList(body, { minSeq: 5 })), { ok: false, problems: ["seq 4 is older than the list already seen (5)"] });
  });
});

const artifact = (n = 1) => ({ url: `https://github.com/a/b/releases/download/v1/p${n}.tar.gz`, sha256: String(n).repeat(64).slice(0, 64), sizeBytes: 1000 });
const version = (v, extra = {}) => ({
  version: v,
  repo: "a/b",
  channel: /-/.test(v) ? "beta" : "latest",
  publishedAt: "2026-11-01T00:00:00Z",
  engines: { ardia: ">=0.3.0" },
  dependencies: {},
  optionalDependencies: {},
  provides: [],
  consumes: [],
  permissions: {},
  artifacts: { universal: artifact() },
  yanked: false,
  ...extra,
});
const detail = (id, versions, extra = {}) => {
  const latest = versions.filter((v) => v.channel === "latest").at(-1)?.version;
  const beta = versions.filter((v) => v.channel === "beta").at(-1)?.version;
  return { id, name: id.split("/")[1], description: "A plugin", official: false, tier: "js_sandbox", repo: "a/b", tags: { ...(latest ? { latest } : {}), ...(beta ? { beta } : {}) }, versions, ...extra };
};
const indexEntry = (extra = {}) => ({
  id: "@a/b",
  name: "B",
  description: "d",
  icon: null,
  official: false,
  tier: "js_sandbox",
  repo: "a/b",
  scope: "profile",
  categories: [],
  keywords: [],
  license: null,
  homepage: null,
  tags: { beta: "1.1.0-beta.1" },
  installs: 3,
  updatedAt: "2026-11-25T10:00:00Z",
  ...extra,
});
let entrySerial = 0;
function revocation(extra) {
  return { entryId: `e${++entrySerial}`, seq: 1, reason: "Broken", issuedAt: "2026-11-25T00:00:00Z", action: "yank", ...extra };
}

describe("registry documents", () => {
  test("the index matches the broker's wire shape, beta-only plugins included", () => {
    const index = { seq: 3, generatedAt: "2026-11-25T10:00:00Z", plugins: [indexEntry(), indexEntry({ id: "@a/c", icon: "star", license: "MIT", homepage: "https://a.dev", tags: { latest: "1.0.0" } })] };
    assert.deepEqual(validateRegistryIndex(index).problems, undefined);
    assert.deepEqual(validateRegistryIndex({ ...index, v: 1 }).problems, ["v isn't a key of the registry index"]);
    assert.deepEqual(validateRegistryIndex({ ...index, plugins: [indexEntry(), indexEntry()] }).problems, ["plugins[1].id: @a/b is listed twice"]);
    assert.equal(validateRegistryIndex({ ...index, plugins: [indexEntry({ tags: {} })] }).ok, true);
    assert.equal(validateRegistryIndex({ ...index, plugins: [indexEntry({ iconUrl: null })] }).ok, true);
    assert.equal(validateRegistryIndex({ ...index, plugins: [indexEntry({ iconUrl: "https://cdn.example.com/i.png" })] }).ok, true);
    assert.equal(validateRegistryIndex({ ...index, plugins: [indexEntry({ iconUrl: "http://cdn.example.com/i.png" })] }).ok, false);
    assert.equal(validateRegistryIndex({ ...index, plugins: [indexEntry({ description: "" })] }).ok, true);
    assert.equal(validateRegistryIndex({ ...index, plugins: [indexEntry({ description: "x".repeat(1000) })] }).ok, true);
    assert.equal(validateRegistryIndex({ ...index, plugins: [indexEntry({ description: "x".repeat(1001) })] }).ok, false);
    assert.equal(validateRegistryIndex({ ...index, plugins: [indexEntry({ description: "bad\u202e" })] }).ok, false);
    assert.equal(validateRegistryIndex({ ...index, plugins: [indexEntry({ icon: undefined })] }).ok, false);
    assert.equal(validateRegistryIndex({ ...index, plugins: [indexEntry({ tier: "wasm" })] }).ok, false);
  });

  test("a plugin file matches the wire shape, with artifacts keyed by platform", () => {
    const d = detail("@a/b", [version("1.0.0", { artifacts: { universal: artifact(), "macos-arm64": { ...artifact(2), officialSig: "A".repeat(86) } } }), version("1.1.0-beta.1")]);
    assert.equal(validatePluginDetail(d, "@a/b").ok, true);
    assert.deepEqual(validatePluginDetail(d, "@a/c").problems, ["id is @a/b, but this file is for @a/c"]);
    assert.deepEqual(validatePluginDetail({ ...d, tags: { latest: "1.1.0-beta.1" } }).problems, ["tags.latest: 1.1.0-beta.1 is a beta version"]);
    assert.deepEqual(validatePluginDetail({ ...d, tags: { latest: "9.9.9" } }).problems, ["tags.latest: 9.9.9 isn't one of the versions"]);
    assert.equal(validatePluginDetail({ ...d, v: 1 }).ok, false);
    assert.equal(validatePluginDetail({ ...d, tags: {}, versions: d.versions.map((v) => ({ ...v, yanked: true })) }).ok, true);
    assert.equal(validatePluginDetail({ ...d, tags: {}, versions: [] }).ok, true);
    assert.deepEqual(validatePluginDetail({ ...d, tags: {} }).problems, ["tags.latest is required while a latest release isn't yanked"]);
    const betaOnly = detail("@a/b", [version("1.0.0-beta.1")]);
    assert.deepEqual(validatePluginDetail({ ...betaOnly, tags: {} }).problems, ["tags.beta is required while a beta release isn't yanked"]);
    assert.equal(validatePluginDetail(betaOnly).ok, true);
    assert.equal(validatePluginDetail({ ...d, description: "y".repeat(1000) }).ok, true);
    assert.equal(validatePluginDetail({ ...d, versions: [version("1.0.0", { artifacts: { "beos-x86": artifact() } })] }).ok, false);
    assert.deepEqual(validatePluginDetail({ ...d, versions: [version("1.0.0", { artifacts: {} })], tags: { latest: "1.0.0" } }).problems, ["versions[0].artifacts must have at least one platform"]);
    assert.equal(validatePluginDetail({ ...d, versions: [version("1.0.0", { artifacts: { universal: { ...artifact(), url: "http://x.com/a" } } })] }).ok, false);
    assert.equal(validatePluginDetail({ ...d, versions: [version("1.0.0", { yanked: "no" })] }).ok, false);
    assert.equal(validatePluginDetail({ ...d, versions: [version("1.0.0+build.1")] }).ok, false);
  });

  test("revocation lists match the wire shape", () => {
    const list = { seq: 2, issuedAt: "2026-11-25T00:00:00Z", entries: [revocation({ match: { id: "@a/b", versions: ["1.2.0", ">=2.0.0 <2.1.0"] }, seq: 2, rollbackTo: "1.1.0" }), revocation({ match: { registry: "https://ardia.dev" }, action: "block" })] };
    assert.equal(validateRevocationList(list).ok, true);
    assert.deepEqual(validateRevocationList({ ...list, entries: [revocation({ match: {} })] }).problems, ["entries[0].match must name at least one of id, versions, scope, githubOwner, repo, sha256, registry"]);
    assert.deepEqual(validateRevocationList({ ...list, entries: [revocation({ match: { versions: ["1.0.0"] } })] }).problems, ["entries[0].match.versions needs entries[0].match.id"]);
    assert.deepEqual(validateRevocationList({ ...list, entries: [revocation({ match: { id: "@a/b" }, seq: 9 })] }).problems, ["entries[0].seq 9 is newer than the list's seq 2"]);
    const twin = revocation({ match: { id: "@a/b" } });
    assert.deepEqual(validateRevocationList({ ...list, entries: [twin, twin] }).problems, [`entries[1].entryId: ${twin.entryId} is listed twice`]);
    assert.equal(validateRevocationList({ ...list, entries: [revocation({ match: { id: "@a/b" }, action: "nuke" })] }).ok, false);
  });
});

describe("revocations", () => {
  const list = {
    seq: 9,
    issuedAt: "2026-11-25T00:00:00Z",
    entries: [
      revocation({ match: { id: "@a/b", versions: ["1.2.0"] }, rollbackTo: "1.1.0" }),
      revocation({ match: { id: "@a/b", versions: [">=2.0.0 <2.1.0"] }, action: "disable" }),
      revocation({ match: { scope: "@evil" }, action: "block" }),
      revocation({ match: { githubOwner: "Mallory" }, action: "disable" }),
      revocation({ match: { sha256: "f".repeat(64) }, action: "block" }),
      revocation({ match: { registry: "https://evil.example.com" }, action: "block" }),
    ],
  };

  test("exact bare versions don't stretch a long selector past the length limit", () => {
    const selector = Array.from({ length: 27 }, (_, i) => `1.0.${i}`).join(" || ");
    assert.equal(selector.length, 256);
    assert.ok(selector.length + 27 > 256, "spelling each version as =x.y.z would pass the limit");
    const entries = [revocation({ match: { id: "@a/b", versions: [selector] } })];
    assert.equal(validateRevocationList({ seq: 1, issuedAt: "2026-11-25T00:00:00Z", entries }).ok, true);
    assert.equal(matchRevocations({ id: "@a/b", version: "1.0.26" }, entries).length, 1);
    assert.equal(matchRevocations({ id: "@a/b", version: "1.0.27" }, entries).length, 0);
    assert.equal(satisfies("1.5.0", "1.0.0", { bareExact: true }), false);
    assert.equal(satisfies("1.5.0", "1.0.0"), true);
    assert.equal(satisfies("1.0.0", "1.0.0", { bareExact: true }), true);
  });

  test("a bare version inside || or a space-joined set still matches exactly", () => {
    const or = [revocation({ match: { id: "@a/b", versions: ["1.0.0 || 2.0.0"] } })];
    assert.equal(matchRevocations({ id: "@a/b", version: "1.0.0" }, or).length, 1);
    assert.equal(matchRevocations({ id: "@a/b", version: "2.0.0" }, or).length, 1);
    assert.equal(matchRevocations({ id: "@a/b", version: "1.5.0" }, or).length, 0);
    assert.equal(matchRevocations({ id: "@a/b", version: "3.0.0" }, or).length, 0);
    const mixed = [revocation({ match: { id: "@a/b", versions: ["1.0.0 || >= 3.0.0 <3.2.0", "1.2.3 - 1.2.5"] } })];
    assert.deepEqual(["1.0.0", "1.0.1", "3.1.0", "3.2.0", "1.2.4", "1.2.6"].map((v) => matchRevocations({ id: "@a/b", version: v }, mixed).length), [1, 0, 1, 0, 1, 0]);
    const list = { seq: 1, issuedAt: "2026-11-25T00:00:00Z", entries: [revocation({ match: { id: "@a/b", versions: Array.from({ length: 256 }, (_, i) => `1.0.${i}`) }, reason: "r".repeat(1000) })] };
    assert.equal(validateRevocationList(list).ok, true);
    assert.equal(validateRevocationList({ ...list, entries: [{ ...list.entries[0], match: { id: "@a/b", versions: Array.from({ length: 257 }, (_, i) => `1.0.${i}`) } }] }).ok, false);
    assert.equal(validateRevocationList({ ...list, entries: [{ ...list.entries[0], reason: "r".repeat(1001) }] }).ok, false);
  });

  test("a bare version matches exactly; a range matches as a range", () => {
    assert.deepEqual(matchRevocations({ id: "@a/b", version: "1.2.0" }, list).map((m) => [m.action, m.rollbackTo]), [["yank", "1.1.0"]]);
    assert.deepEqual(matchRevocations({ id: "@a/b", version: "1.2.1" }, list), []);
    assert.deepEqual(matchRevocations({ id: "@a/b", version: "1.3.0" }, list), []);
    assert.deepEqual(matchRevocations({ id: "@a/b", version: "2.0.5" }, list).map((m) => m.action), ["disable"]);
  });

  test("scope, owner, hash and registry origin, strongest first", () => {
    assert.deepEqual(matchRevocations({ id: "@evil/thing", version: "0.0.1" }, list).map((m) => m.action), ["block"]);
    assert.deepEqual(matchRevocations({ id: "@x/y", version: "1.0.0", repo: "mallory/y" }, list).map((m) => m.action), ["disable"]);
    assert.deepEqual(matchRevocations({ id: "@a/b", version: "1.2.0", sha256: "F".repeat(64) }, list).map((m) => m.action), ["block", "yank"]);
    assert.deepEqual(matchRevocations({ id: "@x/y", version: "1.0.0", registry: "evil.example.com" }, list).map((m) => m.action), ["block"]);
    assert.deepEqual(matchRevocations({ id: "@x/y", version: "1.0.0", registry: "https://evil.example.com/" }, list).map((m) => m.action), ["block"]);
    assert.deepEqual(matchRevocations({ id: "@x/y", version: "1.0.0", registry: "http://evil.example.com" }, list), []);
    assert.equal(sameRegistry("https://ardia.dev", "ardia.dev"), true);
    assert.deepEqual(matchRevocations({ id: "@a/b", version: "1.1.0" }, null), []);
  });

  test("a version the registry marks yanked counts as a yank", () => {
    assert.deepEqual(matchRevocations({ id: "@a/b", version: "1.1.0", yanked: true }, list).map((m) => [m.action, m.source]), [["yank", "registry"]]);
  });
});

describe("resolvePluginGraph", () => {
  const catalog = new Map([
    ["@a/app", detail("@a/app", [version("1.0.0", { dependencies: { "@a/ai": "^1.0.0" }, optionalDependencies: { "@a/extra": "^2.0.0" } }), version("1.1.0", { dependencies: { "@a/ai": "^1.2.0" }, engines: { ardia: ">=0.5.0" } })])],
    ["@a/ai", detail("@a/ai", [version("1.0.0"), version("1.2.0"), version("1.3.0-beta.1"), version("1.4.0", { yanked: true }), version("2.0.0")])],
    ["@a/extra", detail("@a/extra", [version("1.0.0")])],
    ["@a/mac", detail("@a/mac", [version("1.0.0", { artifacts: { "macos-arm64": artifact(2), "linux-x64": artifact(3) } })])],
    ["@a/loop1", detail("@a/loop1", [version("1.0.0", { dependencies: { "@a/loop2": "*" } })])],
    ["@a/loop2", detail("@a/loop2", [version("1.0.0", { dependencies: { "@a/loop1": "*" } })])],
    ["@a/wants-old", detail("@a/wants-old", [version("1.0.0", { dependencies: { "@a/ai": "~1.0.0" } })])],
  ]);
  const base = { catalog, ardiaVersion: "0.4.0", platform: "macos-arm64" };

  test("picks the newest compatible versions, never a yanked one, and orders dependencies first", () => {
    const result = resolvePluginGraph({ ...base, roots: [{ id: "@a/app" }] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.plan.map((p) => [p.id, p.version, p.root]), [["@a/ai", "1.2.0", false], ["@a/app", "1.0.0", true]]);
    assert.deepEqual(result.skipped.map((s) => [s.id, s.from, s.code]), [["@a/extra", "@a/app@1.0.0", "no-version"]]);
    assert.equal(resolvePluginGraph({ ...base, ardiaVersion: "0.5.0", roots: [{ id: "@a/app" }] }).plan.find((p) => p.id === "@a/app").version, "1.1.0");
    assert.equal(resolvePluginGraph({ ...base, roots: [{ id: "@a/ai", range: ">=1.3.0 <2.0.0" }] }).ok, false);
    assert.equal(resolvePluginGraph({ ...base, installed: { "@a/ai": "1.4.0" }, keepInstalled: true, roots: [{ id: "@a/ai", range: "^1.0.0" }] }).plan[0].version, "1.2.0");
  });

  test("backtracks to solve a diamond the greedy choice would fail", () => {
    const diamond = new Map([
      ["@d/top", detail("@d/top", [version("1.0.0", { dependencies: { "@d/left": "^1.0.0", "@d/right": "^1.0.0" } })])],
      ["@d/left", detail("@d/left", [version("1.0.0", { dependencies: { "@d/base": "^1.0.0" } }), version("1.1.0", { dependencies: { "@d/base": "^2.0.0" } })])],
      ["@d/right", detail("@d/right", [version("1.0.0", { dependencies: { "@d/base": "^1.0.0" } })])],
      ["@d/base", detail("@d/base", [version("1.0.0"), version("1.5.0"), version("2.0.0")])],
    ]);
    const result = resolvePluginGraph({ catalog: diamond, ardiaVersion: "1.0.0", platform: null, roots: [{ id: "@d/top" }] });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.deepEqual(Object.fromEntries(result.plan.map((p) => [p.id, p.version])), { "@d/base": "1.5.0", "@d/left": "1.0.0", "@d/right": "1.0.0", "@d/top": "1.0.0" });
    assert.equal(result.plan.at(-1).id, "@d/top");
  });

  test("optional dependencies never fail an install: missing, conflicting, revoked and cyclic edges are skipped", () => {
    const opt = new Map([
      ["@o/app", detail("@o/app", [version("1.0.0", { dependencies: { "@o/core": "^1.0.0" }, optionalDependencies: { "@o/gone": "*", "@o/core": "^2.0.0", "@o/bad": "*", "@o/back": "*", "@o/fine": "^1.0.0" } })])],
      ["@o/core", detail("@o/core", [version("1.0.0")])],
      ["@o/bad", detail("@o/bad", [version("1.0.0")])],
      ["@o/back", detail("@o/back", [version("1.0.0", { dependencies: { "@o/app": "*" } })])],
      ["@o/fine", detail("@o/fine", [version("1.1.0", { dependencies: { "@o/core": "^1.0.0" } })])],
    ]);
    const revocations = { seq: 1, issuedAt: "2026-11-25T00:00:00Z", entries: [revocation({ match: { id: "@o/bad" }, action: "block" })] };
    const result = resolvePluginGraph({ catalog: opt, ardiaVersion: "1.0.0", platform: null, revocations, roots: [{ id: "@o/app" }] });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.deepEqual(result.plan.map((p) => p.id), ["@o/core", "@o/fine", "@o/app"]);
    assert.deepEqual(result.plan.find((p) => p.id === "@o/app").optionalDependencies, ["@o/fine"]);
    assert.equal(result.plan.find((p) => p.id === "@o/fine").optional, true);
    assert.deepEqual(Object.fromEntries(result.skipped.map((s) => [s.id, s.code])), { "@o/back": "cycle", "@o/bad": "no-version", "@o/core": "conflict", "@o/gone": "not-found" });
    assert.match(result.skipped.find((s) => s.id === "@o/bad").reason, /revoked/);
    assert.deepEqual(resolvePluginGraph({ catalog: opt, ardiaVersion: "1.0.0", platform: null, includeOptional: false, roots: [{ id: "@o/app" }] }).plan.map((p) => p.id), ["@o/core", "@o/app"]);
  });

  test("takes beta versions only on the beta channel", () => {
    assert.equal(resolvePluginGraph({ ...base, roots: [{ id: "@a/ai", range: "^1.0.0" }] }).plan[0].version, "1.2.0");
    const beta = resolvePluginGraph({ ...base, roots: [{ id: "@a/ai", range: "^1.0.0", channel: "beta" }] });
    assert.equal(beta.plan[0].version, "1.3.0-beta.1");
    assert.equal(beta.plan[0].channel, "beta");
  });

  test("prefers the platform's own artifact and falls back to universal", () => {
    const mac = resolvePluginGraph({ ...base, roots: [{ id: "@a/mac" }] });
    assert.equal(mac.plan[0].artifact.platform, "macos-arm64");
    assert.equal(mac.plan[0].artifact.sha256, artifact(2).sha256);
    const windows = resolvePluginGraph({ ...base, platform: "windows-x64", roots: [{ id: "@a/mac" }] });
    assert.match(windows.problems[0].message, /no matching version has a build for this platform/);
    assert.equal(pickArtifact({ artifacts: { universal: artifact() } }, "linux-x64").platform, "universal");
    assert.equal(currentPlatform("darwin", "arm64"), "macos-arm64");
    assert.equal(currentPlatform("win32", "x64"), "windows-x64");
    assert.equal(currentPlatform("sunos", "x64"), null);
  });

  test("finds conflicts, cycles and missing plugins", () => {
    const conflict = resolvePluginGraph({ ...base, ardiaVersion: "0.5.0", roots: [{ id: "@a/app", range: "1.1.0" }, { id: "@a/wants-old" }] });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.problems[0].code, "conflict");
    assert.equal(conflict.problems[0].id, "@a/ai");
    const cycle = resolvePluginGraph({ ...base, roots: [{ id: "@a/loop1" }] });
    assert.equal(cycle.problems[0].code, "cycle");
    assert.match(cycle.problems[0].message, /@a\/loop(1|2) → @a\/loop(1|2) → @a\/loop(1|2)/);
    assert.deepEqual(resolvePluginGraph({ ...base, roots: [{ id: "@a/nope" }] }).problems.map((p) => p.code), ["not-found"]);
    assert.match(resolvePluginGraph({ ...base, ardiaVersion: "0.2.0", roots: [{ id: "@a/ai" }] }).problems[0].message, /no version works with this Ardia/);
    const wide = new Map(Array.from({ length: 12 }, (_, i) => [`@w/p${i}`, detail(`@w/p${i}`, Array.from({ length: 6 }, (_, v) => version(`1.${v}.0`, { dependencies: i < 11 ? { [`@w/p${i + 1}`]: "^1.0.0" } : { "@w/none": "*" } })))]));
    assert.equal(resolvePluginGraph({ catalog: wide, ardiaVersion: "1.0.0", platform: null, maxSteps: 200, roots: [{ id: "@w/p0" }] }).problems[0].code, "unsettled");
  });

  test("an optional dependency whose newest version closes a cycle falls back to an older one", () => {
    const graph = new Map([
      ["@q/app", detail("@q/app", [version("1.0.0", { optionalDependencies: { "@q/helper": "^1.0.0" } })])],
      ["@q/helper", detail("@q/helper", [version("1.0.0"), version("1.1.0", { dependencies: { "@q/app": "*" } })])],
    ]);
    const result = resolvePluginGraph({ catalog: graph, ardiaVersion: "1.0.0", platform: null, roots: [{ id: "@q/app" }] });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.deepEqual(result.plan.map((p) => [p.id, p.version]), [["@q/helper", "1.0.0"], ["@q/app", "1.0.0"]]);
    assert.deepEqual(result.skipped, []);
  });

  test("a candidate that closes a cycle is passed over for an older one that doesn't", () => {
    const graph = new Map([
      ["@c/a", detail("@c/a", [version("1.0.0", { dependencies: { "@c/b": "^1.0.0" } })])],
      ["@c/b", detail("@c/b", [version("1.0.0"), version("1.1.0", { dependencies: { "@c/a": "*" } })])],
    ]);
    const result = resolvePluginGraph({ catalog: graph, ardiaVersion: "1.0.0", platform: null, roots: [{ id: "@c/a" }] });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.deepEqual(result.plan.map((p) => [p.id, p.version]), [["@c/b", "1.0.0"], ["@c/a", "1.0.0"]]);
  });

  test("an optional branch that runs out of steps is skipped and the required plan stands", () => {
    const graph = new Map(Array.from({ length: 12 }, (_, i) => [`@w/p${i}`, detail(`@w/p${i}`, Array.from({ length: 6 }, (_, v) => version(`1.${v}.0`, { dependencies: i < 11 ? { [`@w/p${i + 1}`]: "^1.0.0" } : { "@w/none": "*" } })))]));
    graph.set("@w/app", detail("@w/app", [version("1.0.0", { dependencies: { "@w/core": "*" }, optionalDependencies: { "@w/p0": "*" } })]));
    graph.set("@w/core", detail("@w/core", [version("1.0.0")]));
    const result = resolvePluginGraph({ catalog: graph, ardiaVersion: "1.0.0", platform: null, maxSteps: 300, roots: [{ id: "@w/app" }] });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.deepEqual(result.plan.map((p) => p.id), ["@w/core", "@w/app"]);
    assert.deepEqual(result.skipped.map((s) => [s.id, s.code]), [["@w/p0", "unsettled"]]);
    const cyclic = new Map([
      ["@x/app", detail("@x/app", [version("1.0.0", { dependencies: { "@x/core": "*" }, optionalDependencies: { "@x/ring1": "*" } })])],
      ["@x/core", detail("@x/core", [version("1.0.0")])],
      ["@x/ring1", detail("@x/ring1", [version("1.0.0", { dependencies: { "@x/ring2": "*" } })])],
      ["@x/ring2", detail("@x/ring2", [version("1.0.0", { dependencies: { "@x/ring1": "*" } })])],
    ]);
    const ringed = resolvePluginGraph({ catalog: cyclic, ardiaVersion: "1.0.0", platform: null, roots: [{ id: "@x/app" }] });
    assert.equal(ringed.ok, true, JSON.stringify(ringed.problems));
    assert.deepEqual(ringed.plan.map((p) => p.id), ["@x/core", "@x/app"]);
    assert.deepEqual(ringed.skipped.map((s) => [s.id, s.code]), [["@x/ring1", "cycle"]]);
  });

  test("revocations use each version's own repo, and keep a yanked install only on request", () => {
    const moved = new Map([["@m/p", detail("@m/p", [version("1.0.0", { repo: "old/p" }), version("1.1.0", { repo: "mallory/p" })])]]);
    const revocations = { seq: 1, issuedAt: "2026-11-25T00:00:00Z", entries: [revocation({ match: { githubOwner: "mallory" }, action: "block" })] };
    assert.equal(resolvePluginGraph({ catalog: moved, ardiaVersion: "1.0.0", platform: null, revocations, roots: [{ id: "@m/p" }] }).plan[0].version, "1.0.0");
    const yank = { seq: 1, issuedAt: "2026-11-25T00:00:00Z", entries: [revocation({ match: { id: "@a/ai", versions: ["1.2.0"] } })] };
    assert.equal(resolvePluginGraph({ ...base, revocations: yank, roots: [{ id: "@a/ai", range: "^1.0.0" }] }).plan[0].version, "1.0.0");
    assert.equal(resolvePluginGraph({ ...base, revocations: yank, installed: { "@a/ai": "1.2.0" }, keepInstalled: true, roots: [{ id: "@a/ai", range: "^1.0.0" }] }).plan[0].version, "1.2.0");
    const blocked = { ...yank, entries: [revocation({ match: { id: "@a/ai" }, action: "block" })] };
    assert.match(resolvePluginGraph({ ...base, revocations: blocked, installed: { "@a/ai": "1.2.0" }, keepInstalled: true, roots: [{ id: "@a/ai" }] }).problems[0].message, /revoked/);
  });
});

describe("diffSecuritySurface", () => {
  const before = {
    scope: "profile",
    permissions: { tabs: "read", network: ["*.example.com", "localhost:8080"], pages: ["https://*.github.com/*"], activePage: { read: true }, state: { events: ["tabs"] } },
    sidecar: { run: ["bin/s"], memoryMB: 512 },
    dependencies: { "@a/ai": "^1.0.0" },
    optionalDependencies: { "@a/x": "^1.0.0" },
    consumes: ["ai.provider"],
    contributes: {
      programs: [{ name: "tool", path: "bin/tool" }],
      contentScripts: [{ id: "c", matches: ["https://*.github.com/*"], js: ["dist/c.js"], runAt: "document_idle" }],
      pageStyles: [{ id: "s", matches: ["https://*.github.com/*"], css: "s.css" }],
      netRules: "rules.json",
      menus: { page: [{ command: "go", when: "isPinned" }], tab: [{ command: "go" }] },
      commands: [{ name: "go", title: "Go", shortcut: "cmd+shift+g" }],
    },
  };
  const clone = () => JSON.parse(JSON.stringify(before));
  const expands = (change) => {
    const next = clone();
    change(next);
    return diffSecuritySurface(before, next);
  };

  test("the same surface, or a narrower one, updates silently", () => {
    assert.deepEqual(diffSecuritySurface(before, clone()), { expanded: false, added: [], removed: [] });
    const narrower = expands((n) => {
      n.permissions.network = ["api.example.com"];
      n.permissions.pages = ["https://gist.github.com/*"];
      n.contributes.contentScripts[0].matches = ["https://gist.github.com/*"];
      n.contributes.pageStyles[0].matches = ["https://gist.github.com/*"];
      n.contributes.menus.tab = [{ command: "go", when: "isPinned" }];
      n.sidecar.memoryMB = 256;
    });
    assert.equal(narrower.expanded, false, narrower.added.join(", "));
    assert.ok(narrower.removed.length > 0);
    assert.equal(diffSecuritySurface({ permissions: { network: "*" } }, { permissions: { network: ["a.com"] } }).expanded, false);
    assert.equal(expands((n) => (n.contributes.contentScripts[0].runAt = "document_start")).expanded, true);
    assert.equal(diffSecuritySurface({ contributes: { contentScripts: [{ matches: ["https://a.com/*"], js: ["a.js"], runAt: "document_start" }] } }, { contributes: { contentScripts: [{ matches: ["https://a.com/*"], js: ["a.js"], runAt: "document_idle" }] } }).expanded, false);
  });

  const widenings = {
    "a new content script": (n) => n.contributes.contentScripts.push({ id: "d", matches: ["https://gitlab.com/*"], js: ["dist/d.js"] }),
    "broader script matches": (n) => (n.contributes.contentScripts[0].matches = ["https://*/*"]),
    "an earlier runAt": (n) => (n.contributes.contentScripts[0].runAt = "document_start"),
    "allFrames": (n) => (n.contributes.contentScripts[0].allFrames = true),
    "another script file": (n) => n.contributes.contentScripts[0].js.push("dist/more.js"),
    "script css": (n) => (n.contributes.contentScripts[0].css = ["c.css"]),
    "a new page style": (n) => n.contributes.pageStyles.push({ id: "t", matches: ["https://gitlab.com/*"], css: "t.css" }),
    "broader style matches": (n) => (n.contributes.pageStyles[0].matches = ["https://*/*"]),
    "changed net rules": (n) => (n.contributes.netRules = "rules2.json"),
    "added net rules": (n) => (n.contributes.netRules = undefined),
    "a new menu entry": (n) => n.contributes.menus.link = [{ command: "go" }],
    "a menu losing its when": (n) => (n.contributes.menus.page = [{ command: "go" }]),
    "a menu with another when": (n) => (n.contributes.menus.page = [{ command: "go", when: "true" }]),
    "a changed shortcut": (n) => (n.contributes.commands[0].shortcut = "cmd+k"),
    "a command that opens a tab": (n) => n.contributes.commands.push({ name: "o", title: "O", open: "tab" }),
    "a tool command": (n) => n.contributes.commands.push({ name: "t", title: "T", tool: "x" }),
    "a handler command": (n) => n.contributes.commands.push({ name: "h", title: "H", handler: true }),
    "a new dependency": (n) => (n.dependencies["@a/new"] = "*"),
    "a changed dependency range": (n) => (n.dependencies["@a/ai"] = "^2.0.0"),
    "a new optional dependency": (n) => (n.optionalDependencies["@a/y"] = "*"),
    "a new consumed interface": (n) => n.consumes.push("credentials.provider"),
    "a changed sidecar argv": (n) => n.sidecar.run.push("--unsafe"),
    "more sidecar memory": (n) => (n.sidecar.memoryMB = 1024),
    "a new program": (n) => n.contributes.programs.push({ name: "other", path: "bin/other" }),
    "a moved program": (n) => (n.contributes.programs[0].path = "bin/evil"),
    "program afterUpdate": (n) => (n.contributes.programs[0].afterUpdate = [["--install"]]),
    "global scope": (n) => (n.scope = "global"),
    "tabs: write": (n) => (n.permissions.tabs = "write"),
    "fullUrls": (n) => (n.permissions.fullUrls = true),
    "a screenshot": (n) => (n.permissions.activePage.screenshot = true),
    "multiTab": (n) => (n.permissions.activePage.multiTab = true),
    "broader pages": (n) => n.permissions.pages.push("https://gitlab.com/*"),
    "workspace": (n) => (n.permissions.workspace = true),
    "bookmarks": (n) => (n.permissions.bookmarks = "read"),
    "history": (n) => (n.permissions.history = "read"),
    "downloads": (n) => (n.permissions.downloads = "read"),
    "media": (n) => (n.permissions.media = "control"),
    "profiles": (n) => (n.permissions.profiles = "write"),
    "clipboard read": (n) => (n.permissions.clipboard = "read"),
    "notifications": (n) => (n.permissions.notifications = true),
    "files": (n) => (n.permissions.files = "picker"),
    "commands": (n) => (n.permissions.commands = true),
    "storage": (n) => (n.permissions.storage = true),
    "secrets": (n) => (n.permissions.secrets = true),
    "a new network host": (n) => n.permissions.network.push("evil.com"),
    "a new loopback port": (n) => n.permissions.network.push("localhost:9090"),
    "all hosts": (n) => (n.permissions.network = "*"),
    "state events": (n) => n.permissions.state.events.push("navigation"),
    "state intents": (n) => (n.permissions.state.intents = ["tabs.pin"]),
    "control": (n) => (n.permissions.control = true),
    "an unknown permission": (n) => (n.permissions.everything = true),
    "an unknown permission level": (n) => (n.permissions.tabs = "admin"),
  };
  for (const [name, change] of Object.entries(widenings)) {
    test(`${name} needs a prompt`, () => {
      const base = name === "added net rules" ? { ...clone(), contributes: { ...clone().contributes, netRules: undefined } } : before;
      const next = clone();
      if (name === "added net rules") next.contributes.netRules = "rules.json";
      else change(next);
      const diff = diffSecuritySurface(base, next);
      assert.equal(diff.expanded, true, `${name}: ${JSON.stringify(diff)}`);
    });
  }

  test("scripts and styles compare as whole units, so swapping their origins needs a prompt", () => {
    const two = (aMatch, bMatch) => ({
      permissions: { pages: ["https://*/*"] },
      contributes: {
        contentScripts: [
          { id: "a", matches: [aMatch], js: ["a.js"] },
          { id: "b", matches: [bMatch], js: ["b.js"] },
        ],
      },
    });
    assert.equal(diffSecuritySurface(two("https://a.com/*", "https://bank.com/*"), two("https://bank.com/*", "https://a.com/*")).expanded, true);
    assert.equal(diffSecuritySurface(two("https://a.com/*", "https://bank.com/*"), two("https://a.com/x*", "https://bank.com/*")).expanded, false);
    const styles = (a, b) => ({ contributes: { pageStyles: [{ id: "a", matches: [a], css: "a.css" }, { id: "b", matches: [b], css: "b.css" }] } });
    assert.equal(diffSecuritySurface(styles("https://a.com/*", "https://b.com/*"), styles("https://b.com/*", "https://a.com/*")).expanded, true);
    const when = (w) => ({ contributes: { pageStyles: [{ id: "a", matches: ["https://a.com/*"], css: "a.css", ...(w ? { when: w } : {}) }] } });
    assert.equal(diffSecuritySurface(when("isPinned"), when(undefined)).expanded, true);
    assert.equal(diffSecuritySurface(when(undefined), when("isPinned")).expanded, false);
    assert.equal(diffSecuritySurface(when("isPinned"), when("true")).expanded, true);
  });

  test("a command that gains or changes its target needs a prompt", () => {
    const command = (extra) => ({ contributes: { commands: [{ name: "go", title: "Go", ...extra }] } });
    assert.equal(diffSecuritySurface(command({}), command({ panel: "side" })).expanded, true);
    assert.equal(diffSecuritySurface(command({ view: "a" }), command({ view: "b" })).expanded, true);
    assert.equal(diffSecuritySurface(command({ open: "tab", path: "/a" }), command({ open: "tab", path: "/b" })).expanded, true);
    assert.equal(diffSecuritySurface(command({ panel: "side" }), command({ panel: "side" })).expanded, false);
  });

  test("a new or retargeted panel needs a prompt", () => {
    const panels = (list) => ({ contributes: { panels: list } });
    const side = { id: "side", title: "Side", mode: "sidecar", view: "main" };
    assert.equal(diffSecuritySurface(panels([]), panels([side])).expanded, true);
    assert.equal(diffSecuritySurface(panels([side]), panels([{ ...side, view: "other" }])).expanded, true);
    assert.equal(diffSecuritySurface(panels([side]), panels([{ ...side, mode: "split", view: undefined, file: "ui.html" }])).expanded, true);
    assert.equal(diffSecuritySurface(panels([side]), panels([{ ...side, title: "Renamed" }])).expanded, false);
  });

  test("an unknown permission moving from false to anything needs a prompt", () => {
    assert.equal(diffSecuritySurface({ permissions: { camera: false } }, { permissions: { camera: true } }).expanded, true);
    assert.equal(diffSecuritySurface({ permissions: { camera: "front" } }, { permissions: { camera: "both" } }).expanded, true);
    assert.equal(diffSecuritySurface({ permissions: { camera: { a: 1, b: 2 } } }, { permissions: { camera: { b: 2, a: 1 } } }).expanded, false);
    assert.equal(diffSecuritySurface({ permissions: { camera: true } }, { permissions: { camera: false } }).expanded, false);
  });

  test("a live channel tag cannot point at a yanked release", () => {
    const detail = {
      id: "@acme/app",
      name: "App",
      description: "",
      official: false,
      tier: "js_sandbox",
      repo: "acme/app",
      tags: { latest: "1.0.0" },
      versions: [
        { version: "1.0.0", repo: "acme/app", channel: "latest", publishedAt: "2026-11-25T00:00:00Z", engines: { ardia: ">=0.3.0" }, dependencies: {}, optionalDependencies: {}, provides: [], consumes: [], permissions: {}, artifacts: { universal: { url: "https://github.com/acme/app/releases/download/v1.0.0/app.tar.gz", sha256: "a".repeat(64), sizeBytes: 10 } }, yanked: true },
        { version: "1.1.0", repo: "acme/app", channel: "latest", publishedAt: "2026-11-25T00:00:00Z", engines: { ardia: ">=0.3.0" }, dependencies: {}, optionalDependencies: {}, provides: [], consumes: [], permissions: {}, artifacts: { universal: { url: "https://github.com/acme/app/releases/download/v1.1.0/app.tar.gz", sha256: "b".repeat(64), sizeBytes: 10 } }, yanked: false },
      ],
    };
    const res = validatePluginDetail(detail);
    assert.equal(res.ok, false);
    assert.match(res.problems.join("\n"), /tags\.latest: 1\.0\.0 is yanked/);
  });

  test("adding a sidecar or a first program from nothing expands", () => {
    assert.deepEqual(diffSecuritySurface({}, { scope: "global", sidecar: { run: ["x"] }, contributes: { programs: [{ name: "tool", path: "bin/tool" }] } }).expanded, true);
    assert.equal(diffSecuritySurface(null, { permissions: { activePage: { screenshot: true } } }).expanded, true);
  });

  test("official native artifact signatures bind id, version, platform and sha256", async () => {
    const k1 = keys();
    const k2 = keys();
    const claim = { id: "@ardia/cli", version: "0.8.0", platform: "macos-arm64", sha256: "a".repeat(64) };
    const sig = await signOfficialArtifact(claim, k2.privatePem);
    assert.match(sig, /^[A-Za-z0-9_-]{86}$/);
    assert.deepEqual(await verifyOfficialArtifact(claim, sig, { k1: k1.publicPem, k2: k2.publicPem }), { ok: true, kid: "k2" });
    assert.equal((await verifyOfficialArtifact({ ...claim, sha256: "b".repeat(64) }, sig, { k2: k2.publicPem })).ok, false);
    assert.equal((await verifyOfficialArtifact({ ...claim, id: "@acme/cli" }, sig, { k2: k2.publicPem })).ok, false);
    assert.equal(isNativeTier({ contributes: { programs: [{ name: "ardia", path: "bin/ardia" }] } }), true);
    assert.equal(isNativeTier({ sidecar: { run: ["sidecar/server.mjs"] } }), true);
    assert.equal(isNativeTier({}), false);
  });
});
