import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MAGIC = "Cr24";
const ID_ALPHABET = "abcdefghijklmnop";
const EXTENSION_ID = /^[a-p]{32}$/;
const VERSION_PART = /^(?:0|[1-9]\d{0,4})$/;
const MAX_VERSION_PART = 65535;

type Field = { number: number; bytes: Buffer };

function varint(buffer: Buffer, at: number): [number, number] {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (at >= buffer.length || shift > 49) throw new Error("truncated CRX header");
    const byte = buffer[at++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [value, at];
    shift += 7;
  }
}

function fields(buffer: Buffer): Field[] {
  const out: Field[] = [];
  let at = 0;
  while (at < buffer.length) {
    const [key, next] = varint(buffer, at);
    at = next;
    const type = key & 7;
    const number = Math.floor(key / 8);
    if (type === 2) {
      const [length, start] = varint(buffer, at);
      if (start + length > buffer.length) throw new Error("truncated CRX header");
      out.push({ number, bytes: buffer.subarray(start, start + length) });
      at = start + length;
    } else if (type === 0) {
      at = varint(buffer, at)[1];
    } else if (type === 5) {
      at += 4;
    } else if (type === 1) {
      at += 8;
    } else {
      throw new Error("unsupported CRX header field");
    }
    if (at > buffer.length) throw new Error("truncated CRX header");
  }
  return out;
}

export const idFromKey = (publicKey: Buffer) =>
  [...createHash("sha256").update(publicKey).digest("hex").slice(0, 32)].map((digit) => ID_ALPHABET[parseInt(digit, 16)]).join("");

const idFromHex = (hex: string) => [...hex].map((digit) => ID_ALPHABET[parseInt(digit, 16)]).join("");

export function parseCrx(crx: Buffer): { id: string; publicKey: Buffer; zip: Buffer } {
  if (crx.subarray(0, 4).toString("latin1") !== MAGIC) throw new Error("not a CRX file");
  const version = crx.readUInt32LE(4);
  if (version === 2) {
    const keyLength = crx.readUInt32LE(8);
    const signatureLength = crx.readUInt32LE(12);
    const publicKey = crx.subarray(16, 16 + keyLength);
    return { id: idFromKey(publicKey), publicKey, zip: crx.subarray(16 + keyLength + signatureLength) };
  }
  if (version !== 3) throw new Error(`unsupported CRX version ${version}`);
  const headerLength = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerLength);
  const headerFields = fields(header);
  const signed = headerFields.find((field) => field.number === 10000);
  const crxId = signed ? fields(signed.bytes).find((field) => field.number === 1)?.bytes : undefined;
  if (!crxId) throw new Error("the CRX has no id");
  const id = idFromHex(crxId.toString("hex"));
  const keys = headerFields.filter((field) => field.number === 2).map((proof) => fields(proof.bytes).find((field) => field.number === 1)?.bytes);
  const publicKey = keys.find((key) => key && idFromKey(key) === id);
  if (!publicKey) throw new Error("the CRX's key doesn't match its id");
  return { id, publicKey, zip: crx.subarray(12 + headerLength) };
}

export function isExtensionVersion(version: unknown): version is string {
  if (typeof version !== "string") return false;
  const parts = version.split(".");
  return parts.length <= 4 && parts.every((part) => VERSION_PART.test(part) && Number(part) <= MAX_VERSION_PART);
}

function inside(folder: string, path: string): string {
  const resolved = resolve(path);
  const offset = relative(resolve(folder), resolved);
  if (!offset || offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error("the extension's folder would leave the extensions folder");
  return resolved;
}

export async function unpackCrxFile(path: string, extensionsFolder: string): Promise<{ id: string; path: string }> {
  const { id, publicKey, zip } = parseCrx(await readFile(path));
  if (!EXTENSION_ID.test(id)) throw new Error("the CRX's id isn't an extension id");
  const archive = new AdmZip(zip);
  const manifestEntry = archive.getEntry("manifest.json");
  if (!manifestEntry) throw new Error("the CRX has no manifest.json");
  const manifest = JSON.parse(manifestEntry.getData().toString("utf8")) as Record<string, unknown>;
  if (!isExtensionVersion(manifest.version)) throw new Error("the extension's manifest version isn't a valid version");
  const extensionFolder = inside(extensionsFolder, join(extensionsFolder, id));
  const target = inside(extensionFolder, join(extensionFolder, `${manifest.version}_0`));
  const staging = inside(extensionsFolder, join(extensionsFolder, `${id}.unpacking`));
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    archive.extractAllTo(staging, true);
    manifest.key = publicKey.toString("base64");
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
    await rm(target, { recursive: true, force: true });
    await mkdir(extensionFolder, { recursive: true });
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { id, path: target };
}
