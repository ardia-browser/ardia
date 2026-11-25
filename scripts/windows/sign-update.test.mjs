import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_PUBLIC_KEY, parseArguments, rawPublicKey, writeWindowsSignature } from "./sign-update.mjs";

const SCRIPT = fileURLToPath(new URL("./sign-update.mjs", import.meta.url));
const LINUX_KEY = fileURLToPath(new URL("../linux/linux-update.pem", import.meta.url));
const PUBLISHED = "https://github.com/ardia-browser/ardia/releases/download/";

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "win-sign-update-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function keyPair(dir, name = "key") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePath = join(dir, `${name}.pem`);
  const publicPath = join(dir, `${name}.pub.pem`);
  writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }));
  return { privatePath, publicPath };
}

function writeFeed(dir, build = 60) {
  const feed = { version: "0.2.48-nightly.1", build };
  for (const cpu of ["x64", "arm64"]) {
    const bytes = Buffer.from(`installer-${cpu}-${build}-${"a".repeat(64)}`);
    writeFileSync(join(dir, `Ardia-Setup-${cpu}.exe`), bytes);
    feed[cpu] = {
      url: `${PUBLISHED}windows-alpha/Ardia-Setup-${cpu}-${build}.exe`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  }
  const manifestPath = join(dir, "windows-update.json");
  writeFileSync(manifestPath, `${JSON.stringify(feed, null, 2)}\n`);
  return manifestPath;
}

function verifies(publicPath, manifestPath, signaturePath) {
  const key = createPublicKey(readFileSync(publicPath));
  return verify(null, readFileSync(manifestPath), key, readFileSync(signaturePath));
}

test("the shipped Windows public key is an Ed25519 SPKI PEM matching the release key", () => {
  const pem = readFileSync(DEFAULT_PUBLIC_KEY, "utf8");
  const linuxPem = readFileSync(LINUX_KEY, "utf8");
  assert.equal(pem, linuxPem);
  assert.equal(rawPublicKey(pem).length, 32);
});

test("signing writes a 64-byte raw Ed25519 signature verified by Ed25519", (t) => {
  const dir = scratch(t);
  const keys = keyPair(dir);
  const manifestPath = writeFeed(dir);
  const output = execFileSync("node", [SCRIPT, "--manifest", manifestPath, "--key", keys.privatePath, "--public-key", keys.publicPath], { encoding: "utf8" });
  const signaturePath = `${manifestPath}.sig`;
  assert.equal(output.trim(), signaturePath);
  assert.equal(readFileSync(signaturePath).length, 64);
  assert.equal(verifies(keys.publicPath, manifestPath, signaturePath), true);

  const other = keyPair(dir, "other");
  assert.equal(verifies(other.publicPath, manifestPath, signaturePath), false);
  const tampered = join(dir, "tampered.json");
  writeFileSync(tampered, readFileSync(manifestPath, "utf8").replace("60", "61"));
  assert.equal(verifies(keys.publicPath, tampered, signaturePath), false);
});

test("mismatched keys and symlinks are refused and leave no signature behind", async (t) => {
  const dir = scratch(t);
  const keys = keyPair(dir);
  const other = keyPair(dir, "other");
  const manifestPath = writeFeed(dir);
  writeFileSync(`${manifestPath}.sig`, "stale");
  await assert.rejects(writeWindowsSignature({ manifestPath, keyPath: keys.privatePath, publicKeyPath: other.publicPath }), /doesn't match/);
  assert.equal(existsSync(`${manifestPath}.sig`), false);

  const link = join(dir, "link.json");
  symlinkSync(manifestPath, link);
  await assert.rejects(writeWindowsSignature({ manifestPath: link, keyPath: keys.privatePath, publicKeyPath: keys.publicPath }), /not a regular file/);
});

test("--ephemeral-key-out signs cleanly for dry runs", async (t) => {
  const dir = scratch(t);
  const manifestPath = writeFeed(dir);
  const pubOut = join(dir, "dry-run.pem");
  const written = await writeWindowsSignature({ manifestPath, ephemeralKeyOut: pubOut });
  assert.equal(readFileSync(written.signaturePath).length, 64);
  assert.equal(verifies(pubOut, manifestPath, written.signaturePath), true);
});

test("argument parsing enforces --manifest and exactly one of --key or --ephemeral-key-out", () => {
  assert.throws(() => parseArguments([]), /--manifest is required/);
  assert.throws(() => parseArguments(["--manifest", "x"]), /exactly one/);
  assert.throws(() => parseArguments(["--manifest", "x", "--key", "k", "--ephemeral-key-out", "p"]), /exactly one/);
  assert.equal(parseArguments(["--manifest", "x", "--key", "k"]).publishedUnder, PUBLISHED);
});
