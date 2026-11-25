import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const publishScript = join(root, "scripts/windows/publish-alpha.sh");
const verifierPath = process.env.ARDIA_UPDATE_VERIFY_BIN || join(root, "packages/core-rs/target/release/ardia-update-verify");
const publishedBase = "https://github.com/ardia-browser/ardia/releases/download/windows-alpha";
const publishedUnder = "https://github.com/ardia-browser/ardia/releases/download/";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeKeypair(dir) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privPem = join(dir, "priv.pem");
  const pubPem = join(dir, "pub.pem");
  writeFileSync(privPem, privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(pubPem, publicKey.export({ type: "spki", format: "pem" }));
  return { privPem, pubPem, privateKey };
}

function makeFixture(dir, version, build, { x64Body, arm64Body, keypair } = {}) {
  const installers = join(dir, `installers-${build}`);
  mkdirSync(installers, { recursive: true });
  writeFileSync(join(installers, "Ardia.build.json"), JSON.stringify({ version, build }) + "\n");
  const files = [
    [`Ardia-${version}-windows-x64-setup.exe`, x64Body ?? Buffer.from(`x64-payload-${build}`)],
    [`Ardia-${version}-windows-arm64-setup.exe`, arm64Body ?? Buffer.from(`arm64-payload-${build}`)],
    [`Ardia-${version}-windows-source.tar.xz`, Buffer.from(`source-payload-${build}`)],
  ];
  for (const [name, data] of files) {
    writeFileSync(join(installers, name), data);
    writeFileSync(join(installers, `${name}.sha256`), `${sha256(data)}  ${name}\n`);
  }
  const keys = keypair ?? makeKeypair(dir);
  return { installers, ...keys };
}

function makeFakeBin(
  dir,
  {
    liveJson = null,
    liveSig = null,
    sigCurlExit = 0,
    sigHttpCode = null,
    jsonHttpCode = null,
    driftAfterFirstJsonFetch = null,
    pauseOnUploadSig = null,
    failJsonUploadExit = 0,
    failJsonUploadMode = "clobber-delete",
  } = {},
) {
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  const ghLog = join(state, "gh.log");
  const lockFile = join(state, "publish.lock");
  const jsonFetchesFile = join(state, "json-fetches");
  writeFileSync(ghLog, "");
  writeFileSync(jsonFetchesFile, "0\n");
  if (liveJson !== null) writeFileSync(join(state, "live.json"), liveJson);
  if (liveSig !== null) writeFileSync(join(state, "live.sig"), liveSig);
  if (driftAfterFirstJsonFetch !== null) {
    writeFileSync(join(state, "drift.json"), driftAfterFirstJsonFetch.json);
    writeFileSync(join(state, "drift.sig"), driftAfterFirstJsonFetch.sig);
  }

  const curlBin = join(bin, "curl");
  writeFileSync(
    curlBin,
    `#!/usr/bin/env bash
set -euo pipefail
out=""
write_out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -w) write_out="$2"; shift ;;
    -H|--retry|--max-time) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
emit_code() {
  if [ -n "$write_out" ]; then
    printf '%s' "$1"
  fi
}
case "$url" in
  */windows-update.json)
    count="$(cat "${jsonFetchesFile}")"
    count=$((count + 1))
    printf '%s\\n' "$count" > "${jsonFetchesFile}"
    if [ "$count" -ge 2 ] && [ -f "${join(state, "drift.json")}" ]; then
      cp "${join(state, "drift.json")}" "${join(state, "live.json")}"
      cp "${join(state, "drift.sig")}" "${join(state, "live.sig")}"
    fi
    if [ -n "${jsonHttpCode ?? ""}" ]; then
      emit_code "${jsonHttpCode ?? ""}"
      exit 0
    fi
    if [ -f "${join(state, "live.json")}" ]; then
      if [ -n "$out" ]; then cp "${join(state, "live.json")}" "$out"; else cat "${join(state, "live.json")}"; fi
      emit_code "200"
      exit 0
    fi
    emit_code "404"
    exit 0
    ;;
  */windows-update.json.sig)
    if [ "${sigCurlExit}" -ne 0 ]; then
      exit "${sigCurlExit}"
    fi
    if [ -n "${sigHttpCode ?? ""}" ]; then
      emit_code "${sigHttpCode ?? ""}"
      exit 0
    fi
    if [ -f "${join(state, "live.sig")}" ]; then
      if [ -n "$out" ]; then cp "${join(state, "live.sig")}" "$out"; else cat "${join(state, "live.sig")}"; fi
      emit_code "200"
      exit 0
    fi
    emit_code "404"
    exit 0
    ;;
esac
emit_code "404"
exit 0
`,
  );
  chmodSync(curlBin, 0o755);

  const pauseSnippet = pauseOnUploadSig
    ? `if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "upload" ]; then
  for arg in "$@"; do
    if [ "\${arg##*/}" = "windows-update.json.sig" ] && [ ! -f "${pauseOnUploadSig.onceFile}" ]; then
      : > "${pauseOnUploadSig.onceFile}"
      : > "${pauseOnUploadSig.pausedFile}"
      python3 -I -c '
import os, sys, time
resume = sys.argv[1]
deadline = time.monotonic() + 10.0
while not os.path.exists(resume) and time.monotonic() < deadline:
    time.sleep(0.02)
' "${pauseOnUploadSig.resumeFile}"
    fi
  done
fi`
    : "";

  const failJsonSnippet =
    failJsonUploadExit !== 0
      ? `  for arg in "$@"; do
    case "$arg" in
      */rollback/windows-update.json) ;;
      */windows-update.json)
        if [ "${failJsonUploadMode}" = "clobber-delete" ]; then
          rm -f "${join(state, "live.json")}"
        elif [ "${failJsonUploadMode}" = "landed-then-fail" ]; then
          cp "$arg" "${join(state, "live.json")}"
        fi
        exit "${failJsonUploadExit}"
        ;;
    esac
  done`
      : "";

  const ghBin = join(bin, "gh");
  writeFileSync(
    ghBin,
    `#!/usr/bin/env bash
set -euo pipefail
${pauseSnippet}
printf '%s\\n' "$*" >> "${ghLog}"
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "upload" ]; then
${failJsonSnippet}
  for arg in "$@"; do
    case "$arg" in
      */windows-update.json) cp "$arg" "${join(state, "live.json")}" ;;
      */windows-update.json.sig) cp "$arg" "${join(state, "live.sig")}" ;;
    esac
  done
  exit 0
fi
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "delete-asset" ]; then
  if [ "\${4:-}" = "windows-update.json.sig" ]; then
    rm -f "${join(state, "live.sig")}"
  fi
  exit 0
fi
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "view" ]; then
  for arg in "$@"; do
    if [ "$arg" = ".isPrerelease" ]; then
      echo "true"
      exit 0
    fi
    if [ "$arg" = ".assets[].name" ]; then
      exit 0
    fi
  done
  exit 0
fi
exit 0
`,
  );
  chmodSync(ghBin, 0o755);

  return { bin, state, ghLog, lockFile };
}

function runPublish(args, { binDir, lockFile, env = {}, githubActions = true }) {
  const baseEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    ARDIA_WINDOWS_PUBLISH_LOCK: lockFile,
    WINDOWS_UPDATE_ED_PRIVATE_KEY: "",
    WINDOWS_UPDATE_KEY_FILE: "",
    ...env,
  };
  if (githubActions) baseEnv.GITHUB_ACTIONS = "true";
  else delete baseEnv.GITHUB_ACTIONS;
  return spawnSync("bash", [publishScript, ...args], {
    cwd: root,
    encoding: "utf8",
    env: baseEnv,
  });
}

function spawnPublish(args, { binDir, lockFile, env = {}, githubActions = true }) {
  const baseEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    ARDIA_WINDOWS_PUBLISH_LOCK: lockFile,
    WINDOWS_UPDATE_ED_PRIVATE_KEY: "",
    WINDOWS_UPDATE_KEY_FILE: "",
    ...env,
  };
  if (githubActions) baseEnv.GITHUB_ACTIONS = "true";
  else delete baseEnv.GITHUB_ACTIONS;
  const child = spawn("bash", [publishScript, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: baseEnv,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const done = new Promise((resolveDone) => {
    child.on("close", (status) => resolveDone({ status, stdout, stderr }));
  });
  return { child, done, getStdout: () => stdout };
}

function signedManifest(version, build, privateKey) {
  const x64 = Buffer.from(`x64-payload-${build}`);
  const arm64 = Buffer.from(`arm64-payload-${build}`);
  const json =
    JSON.stringify(
      {
        version,
        build,
        x64: { url: `${publishedBase}/Ardia-Setup-x64-${build}.exe`, sha256: sha256(x64), bytes: x64.length },
        arm64: { url: `${publishedBase}/Ardia-Setup-arm64-${build}.exe`, sha256: sha256(arm64), bytes: arm64.length },
      },
      null,
      2,
    ) + "\n";
  const sig = sign(null, Buffer.from(json, "utf8"), privateKey);
  return { json, sig };
}

function ensureVerifier() {
  assert.ok(existsSync(verifierPath), `missing ${verifierPath}; build ardia-update-verify first`);
}

function loggedUploads(ghLog) {
  return readFileSync(ghLog, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("release upload "));
}

function verifyLiveFeed(stateDir, pubPem, expectedBuild) {
  const liveJson = join(stateDir, "live.json");
  const liveSig = join(stateDir, "live.sig");
  assert.equal(JSON.parse(readFileSync(liveJson, "utf8")).build, expectedBuild);
  for (const cpu of ["x64", "arm64"]) {
    const res = spawnSync(
      verifierPath,
      [
        "windows-manifest",
        "--key",
        pubPem,
        "--manifest",
        liveJson,
        "--signature",
        liveSig,
        "--published-under",
        publishedUnder,
        "--cpu",
        cpu,
        "--current-build",
        "0",
      ],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 0, `${cpu}: ${res.stdout}${res.stderr}`);
  }
}

async function waitForFile(path, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
  assert.ok(existsSync(path), `timed out waiting for ${path}`);
}

test("live publish uploads installers, then windows-update.json.sig alone, then windows-update.json alone", () => {
  ensureVerifier();
  const dir = mkdtempSync(join(tmpdir(), "ardia-win-pub-order-"));
  try {
    const { installers, privPem, pubPem } = makeFixture(dir, "0.2.99", 500);
    const { bin, state, ghLog, lockFile } = makeFakeBin(dir);
    const out = join(dir, "out");
    const result = runPublish(["--installers", installers, "--out", out, "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath], {
      binDir: bin,
      lockFile,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);

    const uploads = loggedUploads(ghLog);
    assert.equal(uploads.length, 4, uploads.join("\n"));
    assert.match(uploads[0], /Ardia-Setup-x64-500\.exe.*Ardia-Setup-arm64-500\.exe.*ardia-windows-source-500\.tar\.xz/);
    assert.match(uploads[1], /windows-update\.json\.sig$/);
    assert.doesNotMatch(uploads[1], /windows-update\.json(?:\s|$)/);
    assert.match(uploads[2], /windows-update\.json$/);
    assert.doesNotMatch(uploads[2], /windows-update\.json\.sig/);
    assert.match(uploads[3], /Ardia-Setup-x64\.exe.*Ardia-Setup-arm64\.exe/);
    verifyLiveFeed(state, pubPem, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live publish outside GitHub Actions fails closed without --allow-local-publish and succeeds with it", () => {
  ensureVerifier();
  const dir = mkdtempSync(join(tmpdir(), "ardia-win-pub-local-gate-"));
  try {
    const { installers, privPem, pubPem } = makeFixture(dir, "0.2.99", 500);
    const { bin, state, ghLog, lockFile } = makeFakeBin(dir);
    const blocked = runPublish(
      ["--installers", installers, "--out", join(dir, "out-blocked"), "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath],
      { binDir: bin, lockFile, githubActions: false },
    );
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /--allow-local-publish/);
    assert.deepEqual(loggedUploads(ghLog), []);

    const allowed = runPublish(
      ["--allow-local-publish", "--installers", installers, "--out", join(dir, "out-allowed"), "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath],
      { binDir: bin, lockFile, githubActions: false },
    );
    assert.equal(allowed.status, 0, allowed.stderr + allowed.stdout);
    verifyLiveFeed(state, pubPem, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed windows-update.json upload after --clobber deletion restores both windows-update.json and windows-update.json.sig", () => {
  ensureVerifier();
  const dir = mkdtempSync(join(tmpdir(), "ardia-win-pub-rollback-"));
  try {
    const keypair = makeKeypair(dir);
    const f501 = makeFixture(dir, "0.2.99", 501, { keypair });
    const m500 = signedManifest("0.2.99", 500, keypair.privateKey);
    const { bin, state, ghLog, lockFile } = makeFakeBin(dir, {
      liveJson: m500.json,
      liveSig: m500.sig,
      failJsonUploadExit: 42,
      failJsonUploadMode: "clobber-delete",
    });
    const result = runPublish(
      ["--installers", f501.installers, "--out", join(dir, "out-501"), "--key", keypair.privPem, "--public-key", keypair.pubPem, "--verify-bin", verifierPath],
      { binDir: bin, lockFile },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restored previous valid windows-update\.json and windows-update\.json\.sig/);
    const uploads = loggedUploads(ghLog);
    assert.ok(uploads.some((line) => /rollback\/windows-update\.json\.sig$/.test(line)), uploads.join("\n"));
    assert.ok(uploads.some((line) => /rollback\/windows-update\.json$/.test(line)), uploads.join("\n"));
    verifyLiveFeed(state, keypair.pubPem, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ambiguous windows-update.json upload error succeeds without rollback when the new signed pair landed intact", () => {
  ensureVerifier();
  const dir = mkdtempSync(join(tmpdir(), "ardia-win-pub-ambig-"));
  try {
    const keypair = makeKeypair(dir);
    const f501 = makeFixture(dir, "0.2.99", 501, { keypair });
    const m500 = signedManifest("0.2.99", 500, keypair.privateKey);
    const { bin, state, ghLog, lockFile } = makeFakeBin(dir, {
      liveJson: m500.json,
      liveSig: m500.sig,
      failJsonUploadExit: 42,
      failJsonUploadMode: "landed-then-fail",
    });
    const result = runPublish(
      ["--installers", f501.installers, "--out", join(dir, "out-501"), "--key", keypair.privPem, "--public-key", keypair.pubPem, "--verify-bin", verifierPath],
      { binDir: bin, lockFile },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr, /new signed pair landed intact; continuing/);
    const uploads = loggedUploads(ghLog);
    assert.ok(!uploads.some((line) => /rollback\//.test(line)), uploads.join("\n"));
    verifyLiveFeed(state, keypair.pubPem, 501);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-ever publish deletes orphaned windows-update.json.sig when windows-update.json upload fails", () => {
  ensureVerifier();
  const dir = mkdtempSync(join(tmpdir(), "ardia-win-pub-orphan-"));
  try {
    const { installers, privPem, pubPem } = makeFixture(dir, "0.2.99", 500);
    const { bin, state, ghLog, lockFile } = makeFakeBin(dir, { failJsonUploadExit: 42 });
    const result = runPublish(
      ["--installers", installers, "--out", join(dir, "out-500"), "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath],
      { binDir: bin, lockFile },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /removed orphaned windows-update\.json\.sig/);
    const log = readFileSync(ghLog, "utf8");
    assert.match(log, /release delete-asset windows-alpha windows-update\.json\.sig/);
    assert.equal(existsSync(join(state, "live.sig")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("matching same-build repair uploads only windows-update.json.sig for missing, corrupt, and empty 200 signatures", () => {
  ensureVerifier();
  for (const mode of ["missing-sig", "corrupt-sig", "empty-sig"]) {
    const dir = mkdtempSync(join(tmpdir(), `ardia-win-pub-repair-${mode}-`));
    try {
      const { installers, privPem, pubPem, privateKey } = makeFixture(dir, "0.2.99", 500);
      const { json } = signedManifest("0.2.99", 500, privateKey);
      const liveSig = mode === "corrupt-sig" ? Buffer.alloc(64, 0x42) : mode === "empty-sig" ? Buffer.alloc(0) : null;
      const { bin, state, ghLog, lockFile } = makeFakeBin(dir, { liveJson: json, liveSig });
      const out = join(dir, "out");
      const result = runPublish(["--installers", installers, "--out", out, "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath], {
        binDir: bin,
        lockFile,
      });
      assert.equal(result.status, 0, `${mode}: ${result.stderr}${result.stdout}`);
      assert.match(result.stderr, /repairing signature in place/, mode);
      const uploads = loggedUploads(ghLog);
      assert.equal(uploads.length, 1, `${mode}: ${uploads.join("\n")}`);
      assert.match(uploads[0], /windows-update\.json\.sig$/);
      assert.doesNotMatch(uploads[0], /Ardia-Setup-|windows-update\.json(?:\s|$)/);
      verifyLiveFeed(state, pubPem, 500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("empty HTTP 200 live windows-update.json still aborts without uploading", () => {
  ensureVerifier();
  const dir = mkdtempSync(join(tmpdir(), "ardia-win-pub-empty-json-"));
  try {
    const { installers, privPem, pubPem } = makeFixture(dir, "0.2.99", 500);
    const { bin, ghLog, lockFile } = makeFakeBin(dir, { liveJson: "" });
    const result = runPublish(["--installers", installers, "--out", join(dir, "out"), "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath], {
      binDir: bin,
      lockFile,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not check live windows-update\.json \(http:200-empty\)/);
    assert.deepEqual(loggedUploads(ghLog), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same-build repair refuses rebuilt installers whose sha256 differs from live windows-update.json", () => {
  ensureVerifier();
  const dir = mkdtempSync(join(tmpdir(), "ardia-win-pub-rebuilt-"));
  try {
    const { installers, privPem, pubPem, privateKey } = makeFixture(dir, "0.2.99", 500, {
      x64Body: Buffer.from("rebuilt-different-x64-payload-500"),
    });
    const { json } = signedManifest("0.2.99", 500, privateKey);
    const { bin, ghLog, lockFile } = makeFakeBin(dir, { liveJson: json, liveSig: null });
    const result = runPublish(["--installers", installers, "--out", join(dir, "out"), "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath], {
      binDir: bin,
      lockFile,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /differs from the live windows-update\.json/);
    assert.deepEqual(loggedUploads(ghLog), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent repair of build 500 and publish of build 501 serialize on the release lock and keep build 501 validly signed", async () => {
  ensureVerifier();
  const dir = mkdtempSync(join(tmpdir(), "ardia-win-pub-lock-"));
  try {
    const keypair = makeKeypair(dir);
    const f500 = makeFixture(dir, "0.2.99", 500, { keypair });
    const f501 = makeFixture(dir, "0.2.99", 501, { keypair });
    const m500 = signedManifest("0.2.99", 500, keypair.privateKey);
    const pauseFiles = {
      onceFile: join(dir, "pause.once"),
      pausedFile: join(dir, "pause.paused"),
      resumeFile: join(dir, "pause.resume"),
    };
    const { bin, state, ghLog, lockFile } = makeFakeBin(dir, {
      liveJson: m500.json,
      liveSig: null,
      pauseOnUploadSig: pauseFiles,
    });

    const repair = spawnPublish(
      ["--installers", f500.installers, "--out", join(dir, "out-500"), "--key", keypair.privPem, "--public-key", keypair.pubPem, "--verify-bin", verifierPath],
      { binDir: bin, lockFile },
    );
    await waitForFile(pauseFiles.pausedFile);

    const publish501 = spawnPublish(
      ["--installers", f501.installers, "--out", join(dir, "out-501"), "--key", keypair.privPem, "--public-key", keypair.pubPem, "--verify-bin", verifierPath],
      { binDir: bin, lockFile },
    );
    const waitDeadline = Date.now() + 8000;
    while (!publish501.getStdout().includes("build 501") && Date.now() < waitDeadline) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 25));
    }
    assert.ok(publish501.getStdout().includes("build 501"), "build 501 never reached the publish lock");
    assert.equal(publish501.child.exitCode, null);
    assert.deepEqual(loggedUploads(ghLog), []);

    writeFileSync(pauseFiles.resumeFile, "go\n");
    const [r500, r501] = await Promise.all([repair.done, publish501.done]);
    assert.equal(r500.status, 0, r500.stderr + r500.stdout);
    assert.equal(r501.status, 0, r501.stderr + r501.stdout);
    verifyLiveFeed(state, keypair.pubPem, 501);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publish lock refuses symlinks, FIFOs, and non-finite timeouts, and times out cleanly when held", async () => {
  ensureVerifier();
  const dir = mkdtempSync(join(tmpdir(), "ardia-win-pub-lock-hardening-"));
  try {
    const { installers, privPem, pubPem } = makeFixture(dir, "0.2.99", 500);
    const { bin, ghLog, lockFile } = makeFakeBin(dir);
    const target = join(dir, "real-target");
    const symLock = join(dir, "sym.lock");
    writeFileSync(target, "keep\n");
    symlinkSync(target, symLock);
    const symRes = runPublish(
      ["--installers", installers, "--out", join(dir, "out-sym"), "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath],
      { binDir: bin, lockFile: symLock },
    );
    assert.notEqual(symRes.status, 0);
    assert.match(symRes.stderr, /failed to acquire publish lock/);
    assert.deepEqual(loggedUploads(ghLog), []);

    const fifoLock = join(dir, "fifo.lock");
    execFileSync("mkfifo", [fifoLock]);
    const fifoRes = runPublish(
      ["--installers", installers, "--out", join(dir, "out-fifo"), "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath],
      { binDir: bin, lockFile: fifoLock },
    );
    assert.notEqual(fifoRes.status, 0);
    assert.match(fifoRes.stderr, /failed to acquire publish lock/);
    assert.deepEqual(loggedUploads(ghLog), []);

    for (const badTimeout of ["nan", "inf", "-inf", "-1", "abc"]) {
      const badRes = runPublish(
        ["--installers", installers, "--out", join(dir, `out-bad-${badTimeout}`), "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath],
        { binDir: bin, lockFile, env: { ARDIA_WINDOWS_PUBLISH_LOCK_TIMEOUT: badTimeout } },
      );
      assert.notEqual(badRes.status, 0, badTimeout);
      assert.match(badRes.stderr, /invalid ARDIA_WINDOWS_PUBLISH_LOCK_TIMEOUT/, badTimeout);
      assert.deepEqual(loggedUploads(ghLog), [], badTimeout);
    }

    const heldMarker = join(dir, "lock-held");
    const releaseMarker = join(dir, "lock-release");
    const holder = spawn(
      "python3",
      [
        "-I",
        "-c",
        `import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_CREAT | os.O_WRONLY, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
open(sys.argv[2], "w").close()
deadline = time.monotonic() + 10.0
while not os.path.exists(sys.argv[3]) and time.monotonic() < deadline:
    time.sleep(0.02)
os.close(fd)
`,
        lockFile,
        heldMarker,
        releaseMarker,
      ],
      { stdio: "ignore" },
    );
    try {
      await waitForFile(heldMarker);
      const timeoutRes = runPublish(
        ["--installers", installers, "--out", join(dir, "out-timeout"), "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath],
        { binDir: bin, lockFile, env: { ARDIA_WINDOWS_PUBLISH_LOCK_TIMEOUT: "1" } },
      );
      assert.notEqual(timeoutRes.status, 0);
      assert.match(timeoutRes.stderr, /timed out waiting for publish lock/);
      assert.deepEqual(loggedUploads(ghLog), []);
    } finally {
      writeFileSync(releaseMarker, "done\n");
      await new Promise((resolveDone) => holder.on("close", resolveDone));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cross-host drift to build 501 before repair upload aborts build 500 without clobbering build 501's signature", () => {
  ensureVerifier();
  const dir = mkdtempSync(join(tmpdir(), "ardia-win-pub-drift-"));
  try {
    const keypair = makeKeypair(dir);
    const f500 = makeFixture(dir, "0.2.99", 500, { keypair });
    const m500 = signedManifest("0.2.99", 500, keypair.privateKey);
    const m501 = signedManifest("0.2.99", 501, keypair.privateKey);
    const { bin, state, ghLog, lockFile } = makeFakeBin(dir, {
      liveJson: m500.json,
      liveSig: null,
      driftAfterFirstJsonFetch: m501,
    });
    const result = runPublish(
      ["--installers", f500.installers, "--out", join(dir, "out-500"), "--key", keypair.privPem, "--public-key", keypair.pubPem, "--verify-bin", verifierPath],
      { binDir: bin, lockFile },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /live windows-update\.json changed during repair/);
    assert.deepEqual(loggedUploads(ghLog), []);
    verifyLiveFeed(state, keypair.pubPem, 501);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed cargo build aborts instead of silently falling back to a stale verifier", () => {
  const dir = mkdtempSync(join(tmpdir(), "ardia-win-pub-stale-cargo-"));
  try {
    const { installers, privPem, pubPem } = makeFixture(dir, "0.2.99", 500);
    const { bin, ghLog, lockFile } = makeFakeBin(dir);
    const fakeCargo = join(bin, "cargo");
    writeFileSync(fakeCargo, "#!/usr/bin/env bash\nexit 42\n");
    chmodSync(fakeCargo, 0o755);

    const targetDir = join(dir, "target");
    const releaseDir = join(targetDir, "release");
    mkdirSync(releaseDir, { recursive: true });
    const staleMarker = join(dir, "stale-ran");
    const staleVerifier = join(releaseDir, "ardia-update-verify");
    writeFileSync(staleVerifier, `#!/usr/bin/env bash\n: > "${staleMarker}"\nexit 0\n`);
    chmodSync(staleVerifier, 0o755);

    const result = runPublish(["--installers", installers, "--out", join(dir, "out"), "--key", privPem, "--public-key", pubPem], {
      binDir: bin,
      lockFile,
      env: { CARGO_TARGET_DIR: targetDir },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cargo build ardia-update-verify failed/);
    assert.equal(existsSync(staleMarker), false);
    assert.deepEqual(loggedUploads(ghLog), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signature fetch timeout or 5xx error aborts instead of triggering same-build repair", () => {
  ensureVerifier();
  for (const fault of [{ name: "timeout", sigCurlExit: 28 }, { name: "503", sigHttpCode: 503 }]) {
    const dir = mkdtempSync(join(tmpdir(), `ardia-win-pub-${fault.name}-`));
    try {
      const { installers, privPem, pubPem, privateKey } = makeFixture(dir, "0.2.99", 500);
      const { json } = signedManifest("0.2.99", 500, privateKey);
      const { bin, ghLog, lockFile } = makeFakeBin(dir, { liveJson: json, ...fault });
      const result = runPublish(["--installers", installers, "--out", join(dir, "out"), "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath], {
        binDir: bin,
        lockFile,
      });
      assert.notEqual(result.status, 0, fault.name);
      assert.match(result.stderr, /could not check live windows-update\.json\.sig/, fault.name);
      assert.deepEqual(loggedUploads(ghLog), [], fault.name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("an already validly signed same build and any lower build are refused", () => {
  ensureVerifier();
  const dir = mkdtempSync(join(tmpdir(), "ardia-win-pub-monotonic-"));
  try {
    const { installers, privPem, pubPem, privateKey } = makeFixture(dir, "0.2.99", 500);
    const same = signedManifest("0.2.99", 500, privateKey);
    const sameBin = makeFakeBin(join(dir, "same"), { liveJson: same.json, liveSig: same.sig });
    const sameRes = runPublish(["--installers", installers, "--out", join(dir, "out-same"), "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath], {
      binDir: sameBin.bin,
      lockFile: sameBin.lockFile,
    });
    assert.notEqual(sameRes.status, 0);
    assert.match(sameRes.stderr, /isn't above the live feed's build 500/);

    const higher = signedManifest("0.2.99", 501, privateKey);
    const lowerBin = makeFakeBin(join(dir, "lower"), { liveJson: higher.json, liveSig: null });
    const lowerRes = runPublish(["--installers", installers, "--out", join(dir, "out-lower"), "--key", privPem, "--public-key", pubPem, "--verify-bin", verifierPath], {
      binDir: lowerBin.bin,
      lockFile: lowerBin.lockFile,
    });
    assert.notEqual(lowerRes.status, 0);
    assert.match(lowerRes.stderr, /isn't above the live feed's build 501/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live publish fails closed without a signing key while --dry-run works locally with an ephemeral key", () => {
  ensureVerifier();
  const dir = mkdtempSync(join(tmpdir(), "ardia-win-pub-key-"));
  try {
    const { installers } = makeFixture(dir, "0.2.99", 500);
    const { bin, lockFile } = makeFakeBin(dir);
    const liveNoKey = runPublish(["--installers", installers, "--out", join(dir, "out-live"), "--verify-bin", verifierPath], { binDir: bin, lockFile });
    assert.notEqual(liveNoKey.status, 0);
    assert.match(liveNoKey.stderr, /a signing key is required to publish/);

    const dryOut = join(dir, "out-dry");
    const dryRes = runPublish(["--dry-run", "--installers", installers, "--out", dryOut, "--verify-bin", verifierPath], {
      binDir: bin,
      lockFile,
      githubActions: false,
    });
    assert.equal(dryRes.status, 0, dryRes.stderr + dryRes.stdout);
    assert.equal(readFileSync(join(dryOut, "windows-update.json.sig")).length, 64);
    assert.ok(execFileSync("bash", ["-n", publishScript], { encoding: "utf8" }) === "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
