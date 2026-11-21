import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("personal build configuration stays separate from the official app", { skip: process.platform !== "darwin" }, () => {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const scratch = mkdtempSync(join(tmpdir(), "ardia-personal-paths-"));
  try {
    const binary = join(scratch, "probe");
    const build = spawnSync("clang++", ["-std=c++20", "-fobjc-arc", "-Wno-deprecated-declarations", "-framework", "Foundation", "-framework", "Security", "-I", join(root, "packages/ardiacore/ios"), join(root, "scripts/personal/tests/launch-config-probe.mm"), join(root, "packages/ardiacore/ios/ArdiaLaunchConfig.mm"), "-o", binary], { encoding: "utf8", timeout: 30000 });
    assert.equal(build.status, 0, build.stderr);
    let number = 0;
    const run = (identifier, personal, environment = {}) => {
      const bundle = join(scratch, `${number++}.bundle`);
      mkdirSync(join(bundle, "Contents"), { recursive: true });
      writeFileSync(join(bundle, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>ACPersonalBuild</key><${personal ? "true" : "false"}/></dict></plist>`);
      return spawnSync(binary, [bundle, JSON.stringify(environment)], { encoding: "utf8", timeout: 5000 });
    };
    const official = run("com.ardia.browser", false);
    assert.equal(official.status, 0, official.stderr);
    assert.equal(JSON.parse(official.stdout).configDirectory, join(homedir(), ".config/ardia"));
    const personal = run("dev.simon.ardia.personal", true);
    assert.equal(personal.status, 0, personal.stderr);
    const config = JSON.parse(personal.stdout);
    assert.equal(config.configDirectory, join(homedir(), "Library/Application Support/dev.simon.ardia.personal/config"));
    assert.equal(config.isolated, false);
    const data = join(scratch, "profile");
    for (const [id, enabled] of [["com.ardia.browser", false], ["dev.simon.ardia.personal", true]]) {
      const result = run(id, enabled, { ARDIA_DATA_DIR: data });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).configDirectory, join(data, "config"));
      assert.equal(JSON.parse(result.stdout).isolated, true);
    }
    const invalid = run("com.ardia.browser", true);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /own bundle identifier/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("personal CLI pins its profile despite inherited official endpoints", () => {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const scratch = mkdtempSync("/tmp/ap-cli-");
  try {
    const home = join(scratch, "home");
    mkdirSync(home);
    const launcher = join(scratch, "scripts/personal/ardia-personal");
    const runtime = join(scratch, "apps/browser/build-personal-cli/current/bin/ardia");
    mkdirSync(join(scratch, "scripts/personal"), { recursive: true });
    mkdirSync(join(scratch, "apps/browser/build-personal-cli/current/bin"), { recursive: true });
    copyFileSync(join(root, "scripts/personal/ardia-personal"), launcher);
    writeFileSync(runtime, '#!/bin/sh\nif [ "$1" = endpoint-env ]; then printf "%s%s%s%s" "${ARDIA_WS-}" "${ARDIA_PORT-}" "${ARDIA_CDP_URL-}" "${AGENT_BROWSER_CDP-}"; exit; fi\nexec python3 -m ardia_cli "$@"\n');
    chmodSync(runtime, 0o755);
    const environment = { ...process.env, HOME: home, PYTHONPATH: join(root, "apps/cli"), ARDIA_DATA_DIR: "/official/profile", ARDIA_WS: "ws://127.0.0.1:1/devtools/browser/official", ARDIA_PORT: "1", ARDIA_CDP_URL: "ws://127.0.0.1:1/devtools/browser/official", AGENT_BROWSER_CDP: "ws://127.0.0.1:1/devtools/browser/official" };
    const invoke = (args) => spawnSync("sh", [launcher, ...args], { env: environment, encoding: "utf8", timeout: 10000 });
    const inherited = invoke(["endpoint-env"]);
    assert.equal(inherited.status, 0, inherited.stderr);
    assert.equal(inherited.stdout, "");
    const path = invoke(["config", "path"]);
    assert.equal(path.status, 0, path.stderr);
    assert.equal(path.stdout.trim(), join(home, "Library/Application Support/dev.simon.ardia.personal/config"));
    const unavailable = invoke(["windows"]);
    assert.notEqual(unavailable.status, 0);
    assert.match(unavailable.stderr, /Ardia isn't running/);
    for (const args of [["windows", "--data-dir", "/official/profile"], ["windows", "--port=1"], ["browse", "--cdp", "http://127.0.0.1:1", "snapshot"], ["windows", "--ws=ws://127.0.0.1:1/devtools/browser/official"]]) {
      const result = invoke(args);
      assert.equal(result.status, 64);
      assert.match(result.stderr, /endpoint overrides are refused/);
    }
    const vault = spawnSync("python3", ["-c", "from ardia_cli.browse.vault import SERVICE; print(SERVICE)"], { env: { ...environment, ARDIA_BROWSE_KEYCHAIN_SERVICE: "dev.simon.ardia.personal.browse.auth" }, encoding: "utf8", timeout: 5000 });
    assert.equal(vault.status, 0, vault.stderr);
    assert.equal(vault.stdout.trim(), "dev.simon.ardia.personal.browse.auth");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
