#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE = `usage: node scripts/linux/sign-update.mjs --dir DIR --version V (--key PEM | --unsigned) [--public-key PEM]

Writes Ardia-<V>-linux-update.txt, the Linux self-update manifest, for the
Ardia-<V>-linux-x64.deb, .tar.xz and .AppImage present in DIR (each line
carries the file's sha256 and size), and with --key its raw Ed25519 signature
Ardia-<V>-linux-update.txt.sig. --key is a PKCS#8 PEM (openssl genpkey
-algorithm ed25519); the script refuses a key whose public half isn't
--public-key (default scripts/linux/linux-update.pem, the key installs verify
with). --unsigned writes only the manifest, for a build without the key.`;

export const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-nightly\.[0-9]+)?$/;
const FORMATS = [
  ["deb", "deb"],
  ["tarball", "tar.xz"],
  ["appimage", "AppImage"],
];
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 4096;
export const DEFAULT_PUBLIC_KEY = fileURLToPath(new URL("./linux-update.pem", import.meta.url));

export const packageName = (version, extension) => `Ardia-${version}-linux-x64.${extension}`;
export const manifestName = (version) => `Ardia-${version}-linux-update.txt`;

function sha256File(path) {
  return new Promise((done, failed) => {
    const digest = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => digest.update(chunk))
      .on("error", failed)
      .on("end", () => done(digest.digest("hex")));
  });
}

async function regularFile(path) {
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return null;
  if (!info.isFile()) throw new Error(`${path} is not a regular file`);
  return info;
}

export async function buildManifest(dir, version) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) throw new Error(`bad version ${JSON.stringify(version)}: expected <major>.<minor>.<patch> or <major>.<minor>.<patch>-nightly.<n>`);
  const lines = ["ardia-linux-update 1", `version ${version}`];
  for (const [format, extension] of FORMATS) {
    const name = packageName(version, extension);
    const path = join(dir, name);
    const info = await regularFile(path);
    if (info === null) continue;
    if (info.size < 1) throw new Error(`${name} is empty`);
    if (info.size > MAX_PACKAGE_BYTES) throw new Error(`${name} is ${info.size} bytes, over the ${MAX_PACKAGE_BYTES}-byte limit installs accept`);
    const digest = await sha256File(path);
    const sidecar = await readFile(`${path}.sha256`, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (sidecar !== null && sidecar.trim().split(/\s+/)[0] !== digest) throw new Error(`${name} has sha256 ${digest}, but ${name}.sha256 says otherwise`);
    lines.push(`${format} ${name} ${digest} ${info.size}`);
  }
  if (lines.length === 2) throw new Error(`no Ardia-${version}-linux-x64.deb, .tar.xz or .AppImage in ${dir}`);
  const manifest = Buffer.from(lines.map((line) => `${line}\n`).join(""), "ascii");
  if (manifest.length > MAX_MANIFEST_BYTES) throw new Error(`the manifest is ${manifest.length} bytes, over ${MAX_MANIFEST_BYTES}`);
  return manifest;
}

export function rawPublicKey(key) {
  const der = createPublicKey(key).export({ type: "spki", format: "der" });
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  if (der.length !== 44 || !der.subarray(0, 12).equals(prefix)) throw new Error("the key is not an Ed25519 key");
  return der.subarray(12);
}

function signManifest(manifest, privatePem, publicPem) {
  const privateKey = createPrivateKey(privatePem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`the signing key is ${privateKey.asymmetricKeyType}, not ed25519`);
  if (!rawPublicKey(privateKey).equals(rawPublicKey(publicPem))) throw new Error("the signing key doesn't match the public key installs verify with");
  const signature = sign(null, manifest, privateKey);
  if (signature.length !== 64 || !verify(null, manifest, createPublicKey(publicPem), signature)) throw new Error("the signature doesn't verify");
  return signature;
}

export async function writeUpdate({ dir, version, keyPath, publicKeyPath = DEFAULT_PUBLIC_KEY, unsigned = false }) {
  const manifest = await buildManifest(dir, version);
  const manifestPath = join(dir, manifestName(version));
  const signaturePath = `${manifestPath}.sig`;
  await rm(signaturePath, { force: true });
  if (unsigned) {
    await writeFile(manifestPath, manifest, { mode: 0o644 });
    return { manifestPath, signaturePath: null };
  }
  const signature = signManifest(manifest, await readFile(keyPath), await readFile(publicKeyPath));
  await writeFile(manifestPath, manifest, { mode: 0o644 });
  await writeFile(signaturePath, signature, { mode: 0o644 });
  return { manifestPath, signaturePath };
}

export function parseArguments(argv) {
  const options = { unsigned: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === "--dir") options.dir = resolve(value());
    else if (flag === "--version") options.version = value();
    else if (flag === "--key") options.keyPath = resolve(value());
    else if (flag === "--public-key") options.publicKeyPath = resolve(value());
    else if (flag === "--unsigned") options.unsigned = true;
    else if (flag === "-h" || flag === "--help") options.help = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (options.help) return options;
  if (!options.dir || !options.version) throw new Error("--dir and --version are required");
  if (options.unsigned === Boolean(options.keyPath)) throw new Error("pass exactly one of --key and --unsigned");
  return options;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`sign-update.mjs: ${error.message}\n\n${USAGE}`);
    process.exit(64);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  try {
    const written = await writeUpdate(options);
    console.log(written.manifestPath);
    if (written.signaturePath) console.log(written.signaturePath);
  } catch (error) {
    console.error(`sign-update.mjs: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
