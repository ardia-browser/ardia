import AdmZip from "adm-zip";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { idFromKey, parseCrx, unpackCrxFile } from "./crx.ts";

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

test("a signed CRX3 installs under its id and version", async () => {
  for (const kind of ["rsa"] as const) {
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

test("a header that claims more bytes than the file has is refused", () => {
  const pair = rsa();
  const good = crx3({ archive: archiveWith(MANIFEST), proofs: [{ pair, kind: "rsa" }] });
  const lying = Buffer.from(good);
  lying.writeUInt32LE(good.length, 8);
  assert.throws(() => parseCrx(lying));
  assert.throws(() => parseCrx(good.subarray(0, 10)));
});
