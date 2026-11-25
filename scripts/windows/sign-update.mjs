#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE = `usage: node scripts/windows/sign-update.mjs --manifest FILE (--key PEM | --ephemeral-key-out PUB_PEM) [--public-key PEM] [--verify-bin BIN] [--published-under PREFIX] [--package-dir DIR]

Signs windows-update.json into windows-update.json.sig (raw 64-byte Ed25519
signature over the exact manifest bytes). --key is a PKCS#8 Ed25519 private key
PEM whose public half must match --public-key (default
scripts/windows/windows-update.pem). --ephemeral-key-out generates a throwaway
Ed25519 keypair for dry-run self-checks and writes its public PEM to PUB_PEM.
When --verify-bin is given, self-verifies the manifest (and installers in
--package-dir, if passed) for x64 and arm64 with ardia-update-verify.`;

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const DEFAULT_PUBLIC_KEY = fileURLToPath(new URL("./windows-update.pem", import.meta.url));
export const DEFAULT_PUBLISHED_UNDER = "https://github.com/ardia-browser/ardia/releases/download/";
const CPUS = ["x64", "arm64"];

async function regularFile(path, what) {
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`${what} does not exist: ${path}`);
    throw error;
  });
  if (!info.isFile()) throw new Error(`${what} is not a regular file: ${path}`);
  return info;
}

export function rawPublicKey(key) {
  const der = createPublicKey(key).export({ type: "spki", format: "der" });
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  if (der.length !== 44 || !der.subarray(0, 12).equals(prefix)) throw new Error("the key is not an Ed25519 key");
  return der.subarray(12);
}

export function signWindowsManifest(manifest, privatePem, publicPem) {
  if (!Buffer.isBuffer(manifest)) throw new Error("manifest must be a Buffer");
  if (manifest.length === 0 || manifest.length > MAX_MANIFEST_BYTES) throw new Error(`manifest is ${manifest.length} bytes, expected 1..=${MAX_MANIFEST_BYTES}`);
  const privateKey = createPrivateKey(privatePem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`the signing key is ${privateKey.asymmetricKeyType}, not ed25519`);
  if (!rawPublicKey(privateKey).equals(rawPublicKey(publicPem))) throw new Error("the signing key doesn't match the public key installs verify with");
  const signature = sign(null, manifest, privateKey);
  if (signature.length !== 64 || !verify(null, manifest, createPublicKey(publicPem), signature)) throw new Error("the signature doesn't verify");
  return signature;
}

function selfVerify({ verifyBin, publicKeyPath, manifestPath, signaturePath, publishedUnder, packageDir }) {
  const parsed = JSON.parse(execFileSync("node", ["-e", "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))", manifestPath], { encoding: "utf8" }));
  const present = CPUS.filter((cpu) => parsed && typeof parsed === "object" && parsed[cpu] !== undefined);
  if (present.length === 0) throw new Error("manifest lists no x64 or arm64 installer");
  for (const cpu of present) {
    const args = [
      packageDir ? "windows-package" : "windows-manifest",
      "--key",
      resolve(publicKeyPath),
      "--manifest",
      resolve(manifestPath),
      "--signature",
      resolve(signaturePath),
      "--published-under",
      publishedUnder,
      "--cpu",
      cpu,
      "--current-build",
      "0",
    ];
    if (packageDir) args.push("--package", resolve(join(packageDir, `Ardia-Setup-${cpu}.exe`)));
    const output = execFileSync(verifyBin, args, { encoding: "utf8" });
    const last = output.trim().split(/\r?\n/).at(-1) ?? "";
    if (!last.startsWith("ok ")) throw new Error(`ardia-update-verify rejected ${cpu}: ${last}`);
  }
}

export async function writeWindowsSignature({
  manifestPath,
  keyPath,
  publicKeyPath = DEFAULT_PUBLIC_KEY,
  ephemeralKeyOut = null,
  verifyBin = null,
  publishedUnder = DEFAULT_PUBLISHED_UNDER,
  packageDir = null,
}) {
  const info = await regularFile(manifestPath, "manifest");
  if (info.size < 1 || info.size > MAX_MANIFEST_BYTES) throw new Error(`manifest is ${info.size} bytes, over ${MAX_MANIFEST_BYTES}`);
  const manifest = await readFile(manifestPath);
  const signaturePath = `${manifestPath}.sig`;
  await rm(signaturePath, { force: true });

  let verifyKeyPath = publicKeyPath;
  let signature;
  if (ephemeralKeyOut) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey.export({ type: "spki", format: "pem" });
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
    await writeFile(ephemeralKeyOut, publicPem, { mode: 0o644 });
    verifyKeyPath = ephemeralKeyOut;
    signature = signWindowsManifest(manifest, privatePem, publicPem);
  } else {
    await regularFile(keyPath, "signing key");
    await regularFile(publicKeyPath, "public key");
    signature = signWindowsManifest(manifest, await readFile(keyPath), await readFile(publicKeyPath));
  }

  await writeFile(signaturePath, signature, { mode: 0o644 });
  if (verifyBin) {
    try {
      selfVerify({ verifyBin, publicKeyPath: verifyKeyPath, manifestPath, signaturePath, publishedUnder, packageDir });
    } catch (error) {
      await rm(signaturePath, { force: true });
      throw error;
    }
  }
  return { manifestPath, signaturePath, publicKeyPath: verifyKeyPath };
}

export function parseArguments(argv) {
  const options = { publishedUnder: DEFAULT_PUBLISHED_UNDER };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === "--manifest") options.manifestPath = resolve(value());
    else if (flag === "--key") options.keyPath = resolve(value());
    else if (flag === "--public-key") options.publicKeyPath = resolve(value());
    else if (flag === "--ephemeral-key-out") options.ephemeralKeyOut = resolve(value());
    else if (flag === "--verify-bin") options.verifyBin = resolve(value());
    else if (flag === "--published-under") options.publishedUnder = value();
    else if (flag === "--package-dir") options.packageDir = resolve(value());
    else if (flag === "-h" || flag === "--help") options.help = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (options.help) return options;
  if (!options.manifestPath) throw new Error("--manifest is required");
  if (Boolean(options.keyPath) === Boolean(options.ephemeralKeyOut)) throw new Error("pass exactly one of --key and --ephemeral-key-out");
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
    const written = await writeWindowsSignature(options);
    console.log(written.signaturePath);
  } catch (error) {
    console.error(`sign-update.mjs: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
