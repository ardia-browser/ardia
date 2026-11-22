import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildManifest, DEFAULT_PUBLIC_KEY, parseArguments, rawPublicKey, writeUpdate } from "./sign-update.mjs";

const SCRIPT = fileURLToPath(new URL("./sign-update.mjs", import.meta.url));
const PRODUCTION_KEY = "OkSSoXgBmSUf34t2Ow31NrpiQ/+wRVXIf5K7Fpoa/yw=";
const VERSION = "0.2.48-nightly.3";

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "sign-update-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function keyPair(dir, name = "key") {
  const privatePath = join(dir, `${name}.pem`);
  const publicPath = join(dir, `${name}.pub.pem`);
  execFileSync("openssl", ["genpkey", "-algorithm", "ed25519", "-out", privatePath]);
  execFileSync("openssl", ["pkey", "-in", privatePath, "-pubout", "-out", publicPath]);
  return { privatePath, publicPath };
}

function packages(dir, version = VERSION, formats = ["deb", "tar.xz", "AppImage"]) {
  const files = {};
  for (const extension of formats) {
    const name = `Ardia-${version}-linux-x64.${extension}`;
    const bytes = Buffer.from(`package ${extension} ${"x".repeat(extension.length * 100)}`);
    writeFileSync(join(dir, name), bytes);
    files[extension] = { name, bytes, digest: createHash("sha256").update(bytes).digest("hex") };
  }
  return files;
}

function opensslVerifies(publicPath, manifestPath, signaturePath) {
  const result = spawnSync("openssl", ["pkeyutl", "-verify", "-pubin", "-inkey", publicPath, "-rawin", "-in", manifestPath, "-sigfile", signaturePath], { encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

test("the shipped public key is the contract's production key", () => {
  const pem = readFileSync(DEFAULT_PUBLIC_KEY, "utf8");
  assert.equal(rawPublicKey(pem).toString("base64"), PRODUCTION_KEY);
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(PRODUCTION_KEY, "base64")]);
  assert.equal(pem, `-----BEGIN PUBLIC KEY-----\n${der.toString("base64")}\n-----END PUBLIC KEY-----\n`);
});

test("the CLI writes the exact manifest and a signature openssl pkeyutl -rawin verifies", (t) => {
  const dir = scratch(t);
  const keys = keyPair(dir);
  const files = packages(dir);
  const output = execFileSync("node", [SCRIPT, "--key", keys.privatePath, "--public-key", keys.publicPath, "--dir", dir, "--version", VERSION], { encoding: "utf8" });
  const manifestPath = join(dir, `Ardia-${VERSION}-linux-update.txt`);
  const signaturePath = `${manifestPath}.sig`;
  assert.deepEqual(output.trim().split("\n"), [manifestPath, signaturePath]);
  assert.equal(
    readFileSync(manifestPath, "ascii"),
    [
      "ardia-linux-update 1",
      `version ${VERSION}`,
      `deb ${files.deb.name} ${files.deb.digest} ${files.deb.bytes.length}`,
      `tarball ${files["tar.xz"].name} ${files["tar.xz"].digest} ${files["tar.xz"].bytes.length}`,
      `appimage ${files.AppImage.name} ${files.AppImage.digest} ${files.AppImage.bytes.length}`,
      "",
    ].join("\n"),
  );
  assert.equal(readFileSync(signaturePath).length, 64);
  const verified = opensslVerifies(keys.publicPath, manifestPath, signaturePath);
  assert.ok(verified.ok, verified.output);
  assert.match(verified.output, /Signature Verified Successfully/);

  const other = keyPair(dir, "other");
  assert.equal(opensslVerifies(other.publicPath, manifestPath, signaturePath).ok, false);
  assert.equal(opensslVerifies(DEFAULT_PUBLIC_KEY, manifestPath, signaturePath).ok, false);
  const tampered = join(dir, "tampered.txt");
  writeFileSync(tampered, readFileSync(manifestPath, "ascii").replace(VERSION, "0.2.48-nightly.4"));
  assert.equal(opensslVerifies(keys.publicPath, tampered, signaturePath).ok, false);
});

test("a format missing from the folder has no line, and an empty folder is refused", async (t) => {
  const dir = scratch(t);
  const files = packages(dir, "1.2.3", ["tar.xz", "AppImage"]);
  const manifest = (await buildManifest(dir, "1.2.3")).toString("ascii");
  assert.equal(manifest.split("\n")[2], `tarball ${files["tar.xz"].name} ${files["tar.xz"].digest} ${files["tar.xz"].bytes.length}`);
  assert.doesNotMatch(manifest, /^deb /m);
  await assert.rejects(buildManifest(dir, "1.2.4"), /no Ardia-1\.2\.4-linux-x64/);
});

test("bad versions, symlinked packages and stale .sha256 files are refused", async (t) => {
  const dir = scratch(t);
  packages(dir);
  for (const bad of ["0.2.48-beta.1", "0.2", "../0.2.48", "0.2.48 ", "0.2.48\nversion 9.9.9"]) {
    await assert.rejects(buildManifest(dir, bad), /bad version/, bad);
  }
  writeFileSync(join(dir, `Ardia-${VERSION}-linux-x64.deb.sha256`), `${"0".repeat(64)}  Ardia-${VERSION}-linux-x64.deb\n`);
  await assert.rejects(buildManifest(dir, VERSION), /says otherwise/);
  rmSync(join(dir, `Ardia-${VERSION}-linux-x64.deb.sha256`));
  rmSync(join(dir, `Ardia-${VERSION}-linux-x64.deb`));
  symlinkSync(join(dir, `Ardia-${VERSION}-linux-x64.AppImage`), join(dir, `Ardia-${VERSION}-linux-x64.deb`));
  await assert.rejects(buildManifest(dir, VERSION), /not a regular file/);
});

test("a key that isn't the installs' key is refused and writes nothing", async (t) => {
  const dir = scratch(t);
  packages(dir);
  const keys = keyPair(dir);
  const other = keyPair(dir, "other");
  await assert.rejects(writeUpdate({ dir, version: VERSION, keyPath: keys.privatePath, publicKeyPath: other.publicPath }), /doesn't match/);
  await assert.rejects(writeUpdate({ dir, version: VERSION, keyPath: keys.privatePath }), /doesn't match/);
  assert.equal(existsSync(join(dir, `Ardia-${VERSION}-linux-update.txt`)), false);
  assert.equal(existsSync(join(dir, `Ardia-${VERSION}-linux-update.txt.sig`)), false);
});

test("--unsigned writes only the manifest and clears an old signature", async (t) => {
  const dir = scratch(t);
  packages(dir);
  writeFileSync(join(dir, `Ardia-${VERSION}-linux-update.txt.sig`), "stale");
  const written = await writeUpdate({ dir, version: VERSION, unsigned: true });
  assert.equal(written.signaturePath, null);
  assert.ok(existsSync(written.manifestPath));
  assert.equal(existsSync(join(dir, `Ardia-${VERSION}-linux-update.txt.sig`)), false);
});

test("arguments need a folder, a version and exactly one of --key and --unsigned", () => {
  assert.throws(() => parseArguments(["--dir", "x"]), /required/);
  assert.throws(() => parseArguments(["--dir", "x", "--version", "1.2.3"]), /exactly one/);
  assert.throws(() => parseArguments(["--dir", "x", "--version", "1.2.3", "--key", "k", "--unsigned"]), /exactly one/);
  assert.throws(() => parseArguments(["--dir", "--version", "1.2.3"]), /needs a value/);
  assert.equal(parseArguments(["--dir", "x", "--version", "1.2.3", "--unsigned"]).unsigned, true);
});
