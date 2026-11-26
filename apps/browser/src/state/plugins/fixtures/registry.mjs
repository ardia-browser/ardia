import { generateKeyPairSync } from "node:crypto";
import { signEnvelope, signOfficialArtifact } from "@ardia/plugin-sdk/registry";

export function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicPem: publicKey.export({ type: "spki", format: "pem" }), privatePem: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

export const sha = (n) => String(n).repeat(64).slice(0, 64);

export const STAMP = "2026-11-25T10:00:00Z";

export function artifact(n, extra = {}) {
  return { url: `https://github.com/acme/plugins/releases/download/v${n}/p-${n}.tar.gz`, sha256: sha(n), sizeBytes: 1000 + n, ...extra };
}

export function version(v, extra = {}) {
  return {
    version: v,
    repo: "acme/plugins",
    channel: v.includes("-") ? "beta" : "latest",
    publishedAt: STAMP,
    engines: { ardia: ">=0.0.0" },
    dependencies: {},
    optionalDependencies: {},
    provides: [],
    consumes: [],
    permissions: {},
    artifacts: { universal: artifact(Number(v.split(".")[0]) || 1) },
    yanked: false,
    ...extra,
  };
}

export function detail(id, versions, extra = {}) {
  const live = versions.filter((v) => !v.yanked);
  const latest = live.filter((v) => v.channel === "latest").map((v) => v.version).pop();
  const beta = live.filter((v) => v.channel === "beta").map((v) => v.version).pop();
  return { id, name: id.split("/")[1], description: `${id} for tests`, official: id.startsWith("@ardia/"), tier: "js_sandbox", repo: "acme/plugins", tags: { ...(latest ? { latest } : {}), ...(beta ? { beta } : {}) }, versions, ...extra };
}

export function indexEntry(d) {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    icon: null,
    official: d.official,
    tier: d.tier,
    repo: d.repo,
    scope: "profile",
    categories: ["developer"],
    keywords: [],
    license: null,
    homepage: null,
    tags: d.tags,
    installs: 1,
    updatedAt: STAMP,
  };
}

export function fakeRegistry(base, keys, kid = "test") {
  const files = new Map();
  const etags = new Map();
  const log = [];
  let offline = false;
  const put = async (path, payload, signer = keys) => {
    const envelope = await signEnvelope(payload, kid, signer.privatePem);
    files.set(`${base}/${path}`, JSON.stringify(envelope));
    etags.set(`${base}/${path}`, `"${files.size}-${Date.now()}-${Math.random()}"`);
  };
  const fetcher = async (url, headers) => {
    log.push(url);
    if (offline) throw new TypeError("Network request failed");
    const body = files.get(url);
    if (body === undefined) return { status: 404, header: () => null, text: async () => "" };
    const etag = etags.get(url);
    if (headers["If-None-Match"] && headers["If-None-Match"] === etag) return { status: 304, header: () => etag, text: async () => "" };
    return { status: 200, header: (name) => (name.toLowerCase() === "etag" ? etag : null), text: async () => body };
  };
  return {
    fetcher,
    log,
    put,
    setOffline: (on) => void (offline = on),
    async publish(details, revocations = { seq: 1, issuedAt: STAMP, entries: [] }) {
      for (const d of details) await put(`plugins/${d.id}.json`, d);
      await put("index.json", { seq: 1, generatedAt: STAMP, plugins: details.map(indexEntry) });
      await put("revocations.json", revocations);
    },
  };
}

export const officialSig = (claim, keys) => signOfficialArtifact(claim, keys.privatePem);
