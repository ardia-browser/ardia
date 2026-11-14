import AdmZip from "adm-zip";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { downloadStoreExtension, idFromKey, parseCrx, storeCrxUrl, unpackCrxFile } from "./crx.ts";

const scratch = await mkdtemp(join(tmpdir(), "ardia-crx-"));
after(() => rm(scratch, { recursive: true, force: true }));

const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const ecdsa = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
type Pair = { publicKey: KeyObject; privateKey: KeyObject };

const spki = (pair: Pair) => pair.publicKey.export({ type: "spki", format: "der" });

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}

const field = (number: number, bytes: Buffer) => Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
const le32 = (value: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
};

const signedPayload = (signedData: Buffer, archive: Buffer) => Buffer.concat([Buffer.from("CRX3 SignedData\x00", "latin1"), le32(signedData.length), signedData, archive]);

type Proof = { pair: Pair; kind: "rsa" | "ecdsa"; signature?: Buffer };
type Crx3 = { archive: Buffer; proofs: Proof[]; idKey?: Pair; idBytes?: Buffer; omitSignedData?: boolean };

function crx3({ archive, proofs, idKey, idBytes, omitSignedData }: Crx3): Buffer {
  const crxId = idBytes ?? createHash("sha256").update(spki(idKey ?? proofs[0]!.pair)).digest().subarray(0, 16);
  const signedData = field(1, crxId);
  const payload = signedPayload(signedData, archive);
  const header = Buffer.concat([
    ...proofs.map(({ pair, kind, signature }) =>
      field(kind === "rsa" ? 2 : 3, Buffer.concat([field(1, spki(pair)), field(2, signature ?? sign("sha256", payload, pair.privateKey))])),
    ),
    ...(omitSignedData ? [] : [field(10000, signedData)]),
  ]);
  return Buffer.concat([Buffer.from("Cr24"), le32(3), le32(header.length), header, archive]);
}

function crx2(pair: Pair, archive: Buffer): Buffer {
  const key = spki(pair);
  const signature = sign("sha1", archive, pair.privateKey);
  return Buffer.concat([Buffer.from("Cr24"), le32(2), le32(key.length), le32(signature.length), key, signature, archive]);
}

function archiveWith(manifest: Record<string, unknown>, extra: Record<string, string> = {}): Buffer {
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
  for (const [name, contents] of Object.entries(extra)) zip.addFile(name, Buffer.from(contents));
  return zip.toBuffer();
}

let fileCount = 0;
async function crxFile(bytes: Buffer): Promise<string> {
  const path = join(scratch, `package-${++fileCount}.crx`);
  await writeFile(path, bytes);
  return path;
}

async function freshFolders() {
  const root = await mkdtemp(join(scratch, "profile-"));
  const extensions = join(root, "Extensions");
  await mkdir(extensions, { recursive: true });
  return { root, extensions };
}

const MANIFEST = { manifest_version: 3, name: "Test", version: "1.2.3" };

test("a signed CRX3 installs under its id and version, RSA and ECDSA alike", async () => {
  for (const kind of ["rsa", "ecdsa"] as const) {
    const pair = kind === "rsa" ? rsa() : ecdsa();
    const { extensions } = await freshFolders();
    const installed = await unpackCrxFile(await crxFile(crx3({ archive: archiveWith(MANIFEST), proofs: [{ pair, kind }] })), extensions);
    assert.equal(installed.id, idFromKey(spki(pair)));
    assert.equal(installed.path, join(extensions, installed.id, "1.2.3_0"));
    const manifest = JSON.parse(await readFile(join(installed.path, "manifest.json"), "utf8"));
    assert.equal(manifest.key, spki(pair).toString("base64"));
  }
});

test("a manifest version that walks out of the extensions folder is refused before anything is removed", async () => {
  const pair = rsa();
  const { root, extensions } = await freshFolders();
  const victim = join(root, "victim_0");
  await mkdir(victim);
  await writeFile(join(victim, "keep.txt"), "precious");
  const escaping = archiveWith({ ...MANIFEST, version: "../../victim" });
  await assert.rejects(unpackCrxFile(await crxFile(crx3({ archive: escaping, proofs: [{ pair, kind: "rsa" }] })), extensions), /version/);
  assert.equal(await readFile(join(victim, "keep.txt"), "utf8"), "precious");
  assert.deepEqual(await readdir(extensions), []);
});

test("only Chrome's version format is accepted", async () => {
  const pair = rsa();
  for (const version of ["", "1.2.3.4.5", "65536", "01", "1..2", "1.a", "1.2.", " 1", 3, null]) {
    const { extensions } = await freshFolders();
    const bad = crx3({ archive: archiveWith({ ...MANIFEST, version }), proofs: [{ pair, kind: "rsa" }] });
    await assert.rejects(unpackCrxFile(await crxFile(bad), extensions), /version/, `version ${JSON.stringify(version)}`);
    assert.deepEqual(await readdir(extensions), [], `version ${JSON.stringify(version)} left files behind`);
  }
  for (const version of ["0", "1", "65535.0.0.65535", "2.10"]) {
    const { extensions } = await freshFolders();
    const good = crx3({ archive: archiveWith({ ...MANIFEST, version }), proofs: [{ pair, kind: "rsa" }] });
    assert.ok(existsSync((await unpackCrxFile(await crxFile(good), extensions)).path), version);
  }
});

test("an archive entry that walks out of the staging folder doesn't land outside it", async () => {
  const pair = rsa();
  const { root, extensions } = await freshFolders();
  const zip = new AdmZip(archiveWith(MANIFEST));
  zip.addFile("placeholder.txt", Buffer.from("out"));
  const entry = zip.getEntry("placeholder.txt")!;
  entry.entryName = "../../escaped.txt";
  const archive = zip.toBuffer();
  await unpackCrxFile(await crxFile(crx3({ archive, proofs: [{ pair, kind: "rsa" }] })), extensions).catch(() => null);
  assert.equal(existsSync(join(root, "escaped.txt")), false);
  assert.equal(existsSync(join(extensions, "escaped.txt")), false);
});

test("a CRX3 whose archive was changed after signing is refused", async () => {
  const pair = rsa();
  const archive = archiveWith(MANIFEST);
  const signed = crx3({ archive, proofs: [{ pair, kind: "rsa" }] });
  const tampered = Buffer.concat([signed.subarray(0, signed.length - archive.length), archiveWith({ ...MANIFEST, name: "Evil" })]);
  assert.throws(() => parseCrx(tampered), /signature/);
});

test("a CRX3 with a forged signature from the id's key is refused", async () => {
  const pair = rsa();
  const archive = archiveWith(MANIFEST);
  assert.throws(() => parseCrx(crx3({ archive, proofs: [{ pair, kind: "rsa", signature: Buffer.alloc(256, 7) }] })), /signature/);
  const curve = ecdsa();
  assert.throws(() => parseCrx(crx3({ archive, proofs: [{ pair: curve, kind: "ecdsa", signature: Buffer.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]) }] })), /signature/);
});

test("a CRX3 signed only by keys other than its id's is refused", () => {
  const owner = rsa();
  const stranger = rsa();
  assert.throws(() => parseCrx(crx3({ archive: archiveWith(MANIFEST), proofs: [{ pair: stranger, kind: "rsa" }], idKey: owner })), /id/);
});

test("every proof in a CRX3 has to verify, not just the id's", () => {
  const owner = rsa();
  const other = ecdsa();
  const archive = archiveWith(MANIFEST);
  const bad = crx3({ archive, proofs: [{ pair: owner, kind: "rsa" }, { pair: other, kind: "ecdsa", signature: Buffer.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]) }], idKey: owner });
  assert.throws(() => parseCrx(bad), /signature/);
  const good = crx3({ archive, proofs: [{ pair: owner, kind: "rsa" }, { pair: other, kind: "ecdsa" }], idKey: owner });
  assert.equal(parseCrx(good).id, idFromKey(spki(owner)));
});

test("a CRX3 with no proofs or no signed header data is refused", () => {
  const pair = rsa();
  const archive = archiveWith(MANIFEST);
  assert.throws(() => parseCrx(crx3({ archive, proofs: [], idKey: pair })));
  assert.throws(() => parseCrx(crx3({ archive, proofs: [{ pair, kind: "rsa" }], omitSignedData: true })));
});

test("a CRX2 package is refused, as Chrome has since 2019", () => {
  assert.throws(() => parseCrx(crx2(rsa(), archiveWith(MANIFEST))), /CRX2|version 2/);
});

test("a header that claims more bytes than the file has is refused", () => {
  const pair = rsa();
  const good = crx3({ archive: archiveWith(MANIFEST), proofs: [{ pair, kind: "rsa" }] });
  const lying = Buffer.from(good);
  lying.writeUInt32LE(good.length, 8);
  assert.throws(() => parseCrx(lying));
  assert.throws(() => parseCrx(good.subarray(0, 10)));
});

async function withStore<T>(serve: (url: string) => Response, run: (asked: string[]) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    return serve(url);
  }) as typeof fetch;
  try {
    return await run(asked);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a store install downloads the id's CRX and unpacks it only when its signature verifies", async () => {
  const pair = rsa();
  const id = idFromKey(spki(pair));
  const genuine = crx3({ archive: archiveWith(MANIFEST), proofs: [{ pair, kind: "rsa" }] });
  const { extensions } = await freshFolders();
  const path = await withStore(
    () => new Response(genuine),
    async (asked) => {
      const installed = await downloadStoreExtension(id, extensions);
      assert.deepEqual(asked, [storeCrxUrl(id)]);
      return installed;
    },
  );
  assert.equal(path, join(extensions, id, "1.2.3_0"));
  assert.equal(JSON.parse(await readFile(join(path, "manifest.json"), "utf8")).key, spki(pair).toString("base64"));
});

test("a tampered store CRX, or one for another id, is refused and leaves nothing behind", async () => {
  const pair = rsa();
  const id = idFromKey(spki(pair));
  const archive = archiveWith(MANIFEST);
  const genuine = crx3({ archive, proofs: [{ pair, kind: "rsa" }] });
  const tampered = Buffer.concat([genuine.subarray(0, genuine.length - archive.length), archiveWith({ ...MANIFEST, name: "Evil" })]);
  const { extensions } = await freshFolders();
  await withStore(() => new Response(tampered), () => assert.rejects(downloadStoreExtension(id, extensions), /signature/));
  const other = rsa();
  const foreign = crx3({ archive, proofs: [{ pair: other, kind: "rsa" }] });
  await withStore(() => new Response(foreign), () => assert.rejects(downloadStoreExtension(id, extensions), /not/));
  const escaping = crx3({ archive: archiveWith({ ...MANIFEST, version: "../../x" }), proofs: [{ pair, kind: "rsa" }] });
  await withStore(() => new Response(escaping), () => assert.rejects(downloadStoreExtension(id, extensions), /version/));
  await withStore(() => new Response("nope", { status: 404 }), () => assert.rejects(downloadStoreExtension(id, extensions), /404/));
  assert.deepEqual(await readdir(extensions), []);
});

test("the store URL asks for a CRX3 of exactly that id", async () => {
  const url = new URL(storeCrxUrl("ddkjiahejlhfcafbddmgiahcphecmpfh"));
  assert.equal(url.origin + url.pathname, "https://clients2.google.com/service/update2/crx");
  assert.equal(new URLSearchParams(url.searchParams.get("x") ?? "").get("id"), "ddkjiahejlhfcafbddmgiahcphecmpfh");
  assert.equal(url.searchParams.get("acceptformat"), "crx3");
  await assert.rejects(downloadStoreExtension("../../etc", "/tmp/nowhere"), /not an extension id/);
});
