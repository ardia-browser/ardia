import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const path = (name) => fileURLToPath(new URL(name, import.meta.url));
const repo = (name) => path(`../../../${name}`);
const read = (name) => readFileSync(repo(name), "utf8");
const swiftc = process.env.SWIFTC || "swiftc";
const swiftAvailable = () => {
  const probe = spawnSync(swiftc, ["--version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
};

function compile(dir, flags, sources) {
  const binary = join(dir, "probe");
  const built = spawnSync(swiftc, ["-parse-as-library", ...flags, ...sources, "-o", binary], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  return binary;
}

test("the WebUI host route: ARDIA_WEBUI_APP, then the dev host beside the app, else stay on React Native", (t) => {
  if (!swiftAvailable()) return t.skip("swiftc is not available");
  const dir = mkdtempSync(join(tmpdir(), "ardia-webui-host-"));
  try {
    const ran = spawnSync(compile(dir, ["-DDEBUG", "-Onone"], [path("../ios/WebUIShellHost.swift"), path("./webUIShellHost.test.swift")]), { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function handOffProbe(t, flags) {
  if (!swiftAvailable()) return t.skip("swiftc is not available");
  const dir = mkdtempSync(join(tmpdir(), "ardia-webui-handoff-"));
  try {
    const host = join(dir, "Host.app");
    mkdirSync(join(host, "Contents/MacOS"), { recursive: true });
    writeFileSync(join(host, "Contents/Info.plist"), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>host</string><key>CFBundleIdentifier</key><string>test.webui.host</string></dict></plist>');
    writeFileSync(join(host, "Contents/MacOS/host"), '#!/bin/sh\necho "host $* data=$ARDIA_DATA_DIR shell=$ARDIA_SHELL back=$ARDIA_WEBUI_HANDED_OFF"\n');
    chmodSync(join(host, "Contents/MacOS/host"), 0o755);
    const main = join(dir, "main.swift");
    writeFileSync(main, `@main enum Probe { static func main() { WebUIShellHost.perform(WebUIShellHost.Request(dataDirectory: "${dir}/data", dataDirectoryDefaulted: true, hostApp: "${host}", handedOff: false), arguments: ["app", "--x"]); print("stayed") } }\n`);
    const ran = spawnSync(compile(dir, flags, [path("../ios/WebUIShellHost.swift"), main]), { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    return ran.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a debug build hands off to the WebUI host with its profile, the flag and the loop guard", (t) => {
  const out = handOffProbe(t, ["-DDEBUG", "-Onone"]);
  if (out !== undefined) assert.match(out, /^host --x --ardia-shell=webui data=\/.+\/data shell=webui back=1$/);
});

test("a release build never hands off, even when asked to directly", (t) => {
  const out = handOffProbe(t, ["-O"]);
  if (out !== undefined) assert.equal(out, "stayed");
});

const body = (source, name) => {
  const start = source.indexOf(name);
  assert.ok(start >= 0, `${name} is missing`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(open + 1, index).trim();
  }
  throw new Error(`${name} never closes`);
};

test("the flag is read in the launch config, under DEBUG only, and the app acts on it under DEBUG only", () => {
  const config = read("packages/ardiacore/ios/ArdiaLaunchConfig.mm");
  assert.match(config, /#if DEBUG\nBOOL WebUIShellRequested\(/, "release builds have no WebUIShellRequested");
  assert.match(config, /#if DEBUG\n\s+_webUIShell = WebUIShellRequested\(environment\[kShellVariable\], arguments\);[\s\S]*?\n#endif\n/, "release never sets webUIShell or the dev data dir");
  const init = config.slice(config.indexOf("- (instancetype)initWithEnvironment:"));
  const debugBlock = init.slice(init.indexOf("#if DEBUG\n"), init.indexOf("#endif\n") + 7);
  assert.equal(config.match(/_webUI\w+ = /g).length, debugBlock.match(/_webUI\w+ = /g).length, "every WebUI field is set inside the DEBUG block");
  assert.match(debugBlock, /if \(InsideLiveProfile\(_dataDirectory, homeDirectory\) \|\| \(requested && InsideLiveProfile\(requested, homeDirectory\)\)\) \{[\s\S]*_dataDirectory = nil;\n\s+_webUIShell = NO;/, "a live profile turns the WebUI shell off before ArdiaIsolation reads the data dir");
  assert.match(body(read("packages/shell/ios/WebUIShellLaunch.swift"), "func routeIfRequested"), /^#if DEBUG\n[\s\S]*\n\s*#endif$/);
  assert.match(body(read("packages/shell/ios/WebUIShellHost.swift"), "static func perform"), /^#if DEBUG\n[\s\S]*\n\s*#endif$/);
  const main = read("apps/browser/macos/Ardia-macOS/main.swift");
  assert.match(main, /^let config = LaunchConfig\.shared\nif config\.prewarm \{ exit\(0\) \}\nWebUIShellLaunch\.routeIfRequested\(config\)\n/m, "the app routes before it migrates or starts the engine");
});

test("release archives the app in Release, where DEBUG is never defined", () => {
  assert.match(read("scripts/release/archive.sh"), /-configuration Release\b/);
  const project = read("apps/browser/macos/Ardia.xcodeproj/project.pbxproj");
  const configurations = [...project.matchAll(/isa = XCBuildConfiguration;([\s\S]*?)name = (\w+);/g)];
  const release = configurations.filter(([, , name]) => name === "Release");
  assert.ok(release.length >= 2, "the project and the app target each have a Release configuration");
  assert.ok(configurations.some(([, settings, name]) => name === "Debug" && /SWIFT_ACTIVE_COMPILATION_CONDITIONS = "[^"]*\bDEBUG\b/.test(settings)), "Debug defines DEBUG");
  for (const [, settings] of release) {
    assert.doesNotMatch(settings, /SWIFT_ACTIVE_COMPILATION_CONDITIONS = "[^"]*\bDEBUG\b|OTHER_SWIFT_FLAGS = "[^"]*-D ?DEBUG\b|GCC_PREPROCESSOR_DEFINITIONS[^;]*\bDEBUG=1/, "a Release configuration defines DEBUG");
  }
});

test("no release path builds, bundles or turns on the Mac WebUI", () => {
  const releaseFiles = [
    ".github/workflows/release.yml",
    "scripts/release.sh",
    ...readdirSync(repo("scripts/release")).filter((name) => /\.(sh|mjs|py)$/.test(name) && !name.includes(".test.") && name !== "no-debug-build.sh").map((name) => `scripts/release/${name}`),
  ];
  for (const file of releaseFiles) {
    const text = read(file);
    for (const banned of [/ARDIA_SHELL/, /ardia-shell/, /ARDIA_WEBUI/, /--mode mac\b/, /build:mac\b/, /run-webui-dev/, /dist\/mac\b/, /Ardia WebUI Dev/]) {
      assert.doesNotMatch(text, banned, `${file} mentions ${banned}`);
    }
  }
});

const guard = repo("scripts/release/no-debug-build.sh");
const settingsDump = (target, lines, base = ["CONFIGURATION = Release", "SDK_NAME = macosx27.2", "ARCHS = arm64"]) =>
  [`Build settings for action build and target ${target}:`, ...[...base, ...lines].map((line) => `    ${line}`), ""].join("\n");

test("a release refuses build settings that would define DEBUG or name the WebUI shell", () => {
  const settings = (...args) => spawnSync(guard, ["--settings", ...args], { encoding: "utf8" }).status;
  assert.equal(settings(), 0);
  assert.equal(settings("ARCHS=arm64", "DEBUG_INFORMATION_FORMAT=dwarf-with-dsym", "ARDIACORE_STAGE_DIR=/tmp/x"), 0);
  for (const refused of ["GCC_PREPROCESSOR_DEFINITIONS=$(inherited) DEBUG=1", "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG", "OTHER_SWIFT_FLAGS=-DDEBUG", "OTHER_SWIFT_FLAGS=-D DEBUG", "OTHER_CFLAGS=-DDEBUG=1", "ARDIA_WEBUI_APP=/x", "ARDIA_SHELL=webui"]) {
    assert.equal(settings("ARCHS=arm64", refused), 1, refused);
  }
});

test("a release fails when the effective Release settings of the app or any pod define DEBUG", () => {
  const effective = (input) => spawnSync(guard, ["--effective"], { input, encoding: "utf8" });
  const release = settingsDump("Ardia-macOS", ["GCC_PREPROCESSOR_DEFINITIONS =  COCOAPODS=1", "OTHER_SWIFT_FLAGS =  -D COCOAPODS -D EXPO_CONFIGURATION_RELEASE", "DEBUG_INFORMATION_FORMAT = dwarf-with-dsym"])
    + settingsDump("ArdiaCore", ["GCC_PREPROCESSOR_DEFINITIONS = POD_CONFIGURATION_RELEASE=1 COCOAPODS=1", "SWIFT_ACTIVE_COMPILATION_CONDITIONS = "]);
  assert.equal(effective(release).status, 0, effective(release).stderr);
  const debugPod = release + settingsDump("ArdiaShell", ["SWIFT_ACTIVE_COMPILATION_CONDITIONS =  DEBUG"]);
  const failed = effective(debugPod);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /target ArdiaShell defines DEBUG in SWIFT_ACTIVE_COMPILATION_CONDITIONS/);
  assert.equal(effective(settingsDump("Ardia-macOS", ["GCC_PREPROCESSOR_DEFINITIONS = DEBUG=1  COCOAPODS=1"])).status, 1);
  assert.equal(effective(settingsDump("Ardia-macOS", ["OTHER_SWIFT_FLAGS = -D COCOAPODS -DDEBUG"])).status, 1);
  assert.equal(effective("").status, 1, "no settings at all fails closed");
});

test("the archive step checks the app's and the pods' effective Release settings apart, with the archive's own settings, before it archives", () => {
  const archive = read("scripts/release/archive.sh");
  assert.match(archive, /build_settings=\(-configuration Release ARCHS=arm64 ARDIACORE_STAGE_DIR="\$build\/ArdiaCoreFramework" "\$@" "\$\{archive_signing\[@\]\}"\)\nrelease_settings=\(-destination 'generic\/platform=macOS' "\$\{build_settings\[@\]\}"\)/);
  assert.match(archive, /xcodebuild "\$@" "\$\{build_settings\[@\]\}" ACTION=install -showBuildSettings\) > "\$dist\/release-settings-\$name\.txt" 2>&1/, "each query is saved on its own, as the archive's install action, with what xcodebuild says on stderr");
  assert.match(archive, /no-debug-build\.sh" --effective --require-targets "\$required" < "\$dist\/release-settings-\$name\.txt"/, "each dump is checked on its own");
  assert.match(archive, /^check_release_settings app Ardia-macOS -workspace macos\/Ardia\.xcworkspace -scheme Ardia-macOS -destination 'generic\/platform=macOS'$/m);
  assert.match(archive, /^check_release_settings pods ArdiaCore,ArdiaShell -project macos\/Pods\/Pods\.xcodeproj -alltargets -sdk macosx$/m, "the pods query names the macOS SDK, since xcodebuild drops a destination without a scheme");
  assert.match(archive, /xcodebuild -workspace macos\/Ardia\.xcworkspace -scheme Ardia-macOS \\\n\s+"\$\{release_settings\[@\]\}" -derivedDataPath "\$build" -archivePath "\$dist\/Ardia\.xcarchive" archive\)/, "the archive builds with exactly the settings checked");
  const checks = archive.indexOf('no-debug-build.sh" --settings "$@"');
  const app = archive.indexOf("check_release_settings app ");
  const pods = archive.indexOf("check_release_settings pods ");
  const archiving = archive.indexOf('-archivePath "$dist/Ardia.xcarchive" archive)');
  assert.ok(checks > 0 && app > checks && pods > app && archiving > pods, "every guard runs before xcodebuild archive");
  assert.match(read("scripts/release.sh"), /extra_build_settings/);
});

test("each settings dump must hold the targets it was asked for, so an empty or wrong dump never passes", () => {
  const effective = (input, ...args) => spawnSync(guard, ["--effective", ...args], { input, encoding: "utf8" });
  const app = settingsDump("Ardia-macOS", ["GCC_PREPROCESSOR_DEFINITIONS =  COCOAPODS=1"]);
  const pods = settingsDump("ArdiaCore", ["SWIFT_ACTIVE_COMPILATION_CONDITIONS = "]) + settingsDump("ArdiaShell", ["SWIFT_ACTIVE_COMPILATION_CONDITIONS = "]);
  assert.equal(effective(app, "--require-targets", "Ardia-macOS").status, 0);
  assert.equal(effective(pods, "--require-targets", "ArdiaCore,ArdiaShell").status, 0);
  assert.equal(effective("", "--require-targets", "ArdiaCore,ArdiaShell").status, 1, "an empty pods dump fails");
  const wrong = effective(app, "--require-targets", "ArdiaCore,ArdiaShell");
  assert.equal(wrong.status, 1, "the app's dump can't stand in for the pods'");
  assert.match(wrong.stderr, /no target ArdiaShell/);
  assert.equal(effective(app, "--require-targets").status, 2);
});

test("run-webui-dev.sh refuses any data dir inside the installed app's profile, by case, symlink or default", () => {
  const home = mkdtempSync(join(tmpdir(), "ardia-webui-home-"));
  try {
    const support = join(home, "Library/Application Support");
    for (const folder of ["com.ardia.browser/Chromium", "Ardia/Default", "scratch"]) mkdirSync(join(support, folder), { recursive: true });
    symlinkSync(join(support, "com.ardia.browser"), join(home, "live-link"));
    const run = (...args) => spawnSync(repo("scripts/mac/run-webui-dev.sh"), ["--dry-run", "--no-build", "--app", "/tmp/Ardia Dev.app", ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
    for (const live of ["com.ardia.browser", "com.ardia.browser/Chromium", "com.ardia.browser/not-made-yet", "Ardia", "Ardia/Default", "COM.ARDIA.BROWSER", "ardia/default"]) {
      const result = run("--data-dir", join(support, live));
      assert.equal(result.status, 1, `${live} was accepted`);
      assert.match(result.stderr, /inside the installed app's profile/);
    }
    for (const linked of ["live-link", "live-link/Chromium", "live-link/not-made-yet"]) assert.equal(run("--data-dir", join(home, linked)).status, 1, `${linked} was accepted`);
    symlinkSync(join(support, "com.ardia.browser/Chromium"), join(home, "deep"));
    for (const climbing of ["deep/..", "deep/../made-later", "missing/../deep/../made-later"]) {
      assert.equal(run("--data-dir", `${home}/${climbing}`).status, 1, `${climbing} resolves physically into the profile but was accepted`);
    }
    assert.equal(run("--data-dir", `${home}/deep/../../../../scratch-after-climb`).status, 0, "climbing back out of the profile is fine");
    assert.equal(run("--data-dir", join(home, "library/application support/com.ardia.browser")).status, 1, "a case alias of the folders above was accepted");
    symlinkSync(join(support, "Ardia"), join(support, "Ardia WebUI Dev"));
    assert.equal(run().status, 1, "a default dir symlinked into the profile was accepted");
    rmSync(join(support, "Ardia WebUI Dev"));
    for (const safe of [join(support, "scratch"), join(home, "fresh/webui"), join(support, "com.ardia.browser-copy")]) {
      const result = run("--data-dir", safe);
      assert.equal(result.status, 0, `${safe}: ${result.stderr}`);
    }
    assert.equal(run().status, 0, "the default dir is fine");
    mkdirSync(join(home, "hosts/Ardia WebUI.app"), { recursive: true });
    symlinkSync(join(home, "hosts/Ardia WebUI.app"), join(home, "host-link.app"));
    const linkedHost = run("--webui-app", `${home}/hosts/../host-link.app`);
    assert.equal(linkedHost.status, 0, linkedHost.stderr);
    const resolvedHost = realpathSync(join(home, "hosts/Ardia WebUI.app")).replaceAll(" ", "\\ ");
    assert.ok(linkedHost.stdout.includes(`ARDIA_WEBUI_APP=${resolvedHost} `), `--webui-app goes on resolved: ${linkedHost.stdout}`);
    const relative = spawnSync(repo("scripts/mac/run-webui-dev.sh"), ["--dry-run", "--no-build", "--app", "/tmp/Ardia Dev.app", "--webui-app", "host-link.app"], { encoding: "utf8", cwd: home, env: { ...process.env, HOME: home } });
    assert.equal(relative.status, 0, relative.stderr);
    assert.match(relative.stdout, /ARDIA_WEBUI_APP=\//, "a relative --webui-app becomes absolute, so open's app finds it");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the data dir is resolved and checked before anything is made", () => {
  const script = read("scripts/mac/run-webui-dev.sh");
  assert.match(script, /os\.path\.realpath\(sys\.argv\[1\]\)/, "symlinks and .. resolve physically");
  const resolved = script.indexOf('data_dir=$(canonical_path "$data_dir")');
  const refused = script.indexOf('refuse_live_profile "$data_dir"', resolved);
  const made = script.indexOf('mkdir -p "$data_dir"');
  assert.ok(resolved > 0 && refused > resolved && made > refused, "resolve, then refuse, then mkdir");
});

function probeFolder() {
  return mkdtempSync(join(tmpdir(), "ardia-webui-probe-"));
}

test("a debug app whose WebUI data dir was refused exits before it migrates or opens anything", (t) => {
  if (!swiftAvailable()) return t.skip("swiftc is not available");
  const dir = probeFolder();
  try {
    const main = join(dir, "main.swift");
    writeFileSync(main, '@main enum Probe { static func main() { WebUIShellHost.refuseLiveProfile(); print("continued") } }\n');
    const debug = spawnSync(compile(dir, ["-DDEBUG", "-Onone"], [path("../ios/WebUIShellHost.swift"), main]), { encoding: "utf8" });
    assert.equal(debug.status, 78);
    assert.doesNotMatch(debug.stdout, /continued/);
    assert.match(debug.stderr, /refusing to start/);
    const release = spawnSync(compile(dir, ["-O"], [path("../ios/WebUIShellHost.swift"), main]), { encoding: "utf8" });
    assert.equal(release.status, 0);
    assert.match(release.stdout, /continued/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const launch = read("packages/shell/ios/WebUIShellLaunch.swift");
  assert.match(body(launch, "func routeIfRequested"), /^#if DEBUG\n\s+if config\.webUIRefusedDataDirectory \{ WebUIShellHost\.refuseLiveProfile\(\) \}\n/, "the refusal comes first");
});

test("ArdiaIsolation never installs itself on a refused WebUI data dir", (t) => {
  const clang = spawnSync("clang++", ["--version"], { encoding: "utf8" });
  if (clang.error || clang.status !== 0) return t.skip("clang is not available");
  const dir = probeFolder();
  try {
    mkdirSync(join(dir, "include/ArdiaCore"), { recursive: true });
    symlinkSync(repo("packages/ardiacore/ios/ArdiaLaunchConfig.h"), join(dir, "include/ArdiaCore/ArdiaLaunchConfig.h"));
    const object = join(dir, "isolation.o");
    const isolation = spawnSync("clang", ["-fobjc-arc", "-Wall", "-Werror", "-DDEBUG=1", `-I${join(dir, "include")}`, "-c", path("../ios/ArdiaIsolation.m"), "-o", object], { encoding: "utf8" });
    assert.equal(isolation.status, 0, isolation.stderr);
    const binary = join(dir, "probe");
    const linked = spawnSync("clang++", ["-std=c++20", "-fobjc-arc", "-Wall", "-Werror", "-DDEBUG=1", "-framework", "Foundation", "-framework", "Security", "-framework", "AppKit", repo("packages/ardiacore/ios/ArdiaLaunchConfig.mm"), path("./webUIIsolation.test.mm"), object, "-o", binary], { encoding: "utf8" });
    assert.equal(linked.status, 0, linked.stderr);
    const run = (env) => spawnSync(binary, { encoding: "utf8", env: { PATH: process.env.PATH, ...env } }).stdout.trim();
    assert.equal(run({ ARDIA_DATA_DIR: join(dir, "scratch") }), "isolated", "a scratch data dir is isolated as before");
    const live = join(homedir(), "Library/Application Support/com.ardia.browser", `ardia-probe-${process.pid}-never-made`);
    assert.equal(run({ ARDIA_SHELL: "webui", ARDIA_DATA_DIR: live }), "system", "a refused live data dir gets no isolation");
    assert.equal(existsSync(live), false, "and nothing is made in the live profile");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(read("packages/shell/ios/ArdiaIsolation.m"), /ArdiaLaunchConfig \*config = ArdiaLaunchConfig\.shared;\n\s+if \(config\.webUIRefusedDataDirectory\) return;/);
});

test("a dump xcodebuild couldn't fill, or one that isn't a macOS Release build, never passes", () => {
  const effective = (input) => spawnSync(guard, ["--effective", "--require-targets", "ArdiaCore,ArdiaShell"], { input, encoding: "utf8" });
  const good = settingsDump("ArdiaCore", ["GCC_PREPROCESSOR_DEFINITIONS = POD_CONFIGURATION_RELEASE=1"]) + settingsDump("ArdiaShell", ["SWIFT_ACTIVE_COMPILATION_CONDITIONS = "]);
  assert.equal(effective(good).status, 0, effective(good).stderr);
  const unreadable = "Build settings for action build and target ArdiaCore:\nCould not get build settings for target ArdiaCore\n\n" + settingsDump("ArdiaShell", []);
  const failed = effective(unreadable);
  assert.equal(failed.status, 1, "xcodebuild exiting 0 with a target it couldn't read");
  assert.match(failed.stderr, /did not give every setting: Could not get build settings/);
  assert.match(failed.stderr, /target ArdiaCore \(block 1\) lists no settings/);
  const headersOnly = "Build settings for action build and target ArdiaCore:\n\nBuild settings for action build and target ArdiaShell:\n\n";
  const empty = effective(headersOnly);
  assert.equal(empty.status, 1, "target headers without a single KEY = VALUE line");
  assert.match(empty.stderr, /target ArdiaCore \(block 1\) lists no settings/);
  assert.match(empty.stderr, /target ArdiaShell \(block 2\) lists no settings/);
  assert.equal(effective(good + settingsDump("ArdiaSync", [], [])).status, 1, "any target without settings fails, not just the required ones");
  assert.match(effective(settingsDump("ArdiaCore", [], ["CONFIGURATION = Debug", "SDK_NAME = macosx27.2"]) + settingsDump("ArdiaShell", [])).stderr, /configured Debug, not Release/);
  assert.match(effective(settingsDump("ArdiaCore", [], ["CONFIGURATION = Release", "SDK_NAME = iphoneos27.2"]) + settingsDump("ArdiaShell", [])).stderr, /builds for iphoneos27\.2, not macOS/);
  const dropped = effective("--- xcodebuild: WARNING: Ignoring provided run destination because no scheme was passed.\n" + good);
  assert.equal(dropped.status, 1, "a destination xcodebuild ignored means the settings aren't the archive's");
  assert.equal(effective("xcodebuild: error: The project named \"Pods\" does not contain a scheme\n" + good).status, 1);
  assert.equal(effective("    error: settings query failed\n" + good).status, 1, "an indented error: line");
  assert.equal(effective(good + "\terror: settings query failed\n").status, 1, "a tab-indented error: line after the settings");
  assert.equal(effective("error:\tsettings query failed\n" + good).status, 1, "a tab after error:");
  assert.equal(effective("  xcodebuild:\terror:\tsettings query failed\n" + good).status, 1, "an xcodebuild error with tabs");
  assert.equal(effective("error:\n" + good).status, 1, "a bare error:");
  assert.equal(effective(settingsDump("ArdiaCore", ["ERROR_REPORTING = error: never"]) + settingsDump("ArdiaShell", [])).status, 0, "a setting whose value mentions error: is not a diagnostic");
});

test("each settings block is checked on its own, even when a target name repeats", () => {
  const effective = (input) => spawnSync(guard, ["--effective", "--require-targets", "ArdiaCore,ArdiaShell"], { input, encoding: "utf8" });
  const good = settingsDump("ArdiaCore", []) + settingsDump("ArdiaShell", []);
  assert.equal(effective(good + settingsDump("ArdiaCore", [])).status, 0, "two good blocks for one target are fine");
  const thenEmpty = effective(good + "Build settings for action build and target ArdiaCore:\n\n");
  assert.equal(thenEmpty.status, 1, "a good ArdiaCore block can't vouch for a later empty one");
  assert.match(thenEmpty.stderr, /target ArdiaCore \(block 3\) lists no settings/);
  const debugFirst = effective(settingsDump("ArdiaCore", [], ["CONFIGURATION = Debug", "SDK_NAME = macosx27.2"]) + good);
  assert.equal(debugFirst.status, 1, "a later Release block can't hide an earlier Debug one");
  assert.match(debugFirst.stderr, /target ArdiaCore \(block 1\) is configured Debug, not Release/);
  const iosFirst = effective(settingsDump("ArdiaShell", [], ["CONFIGURATION = Release", "SDK_NAME = iphoneos27.2"]) + good);
  assert.match(iosFirst.stderr, /target ArdiaShell \(block 1\) builds for iphoneos27\.2, not macOS/);
  assert.equal(effective(settingsDump("ArdiaCore", []) + settingsDump("ArdiaCore", [])).status, 1, "repeating one target doesn't stand in for another required one");
});

test("DEBUG in any preprocessor-definitions setting, such as the product type's, fails the release", () => {
  const effective = (input) => spawnSync(guard, ["--effective", "--require-targets", "Ardia-macOS"], { input, encoding: "utf8" });
  for (const line of ["GCC_PRODUCT_TYPE_PREPROCESSOR_DEFINITIONS = DEBUG=1", "GCC_PREPROCESSOR_DEFINITIONS_NOT_USED_IN_PRECOMPS = DEBUG", "INFOPLIST_PREPROCESSOR_DEFINITIONS = DEBUG=1", "OTHER_CPLUSPLUSFLAGS = -DDEBUG=1"]) {
    const failed = effective(settingsDump("Ardia-macOS", [line]));
    assert.equal(failed.status, 1, line);
    assert.match(failed.stderr, new RegExp(`defines DEBUG in ${line.split(" ")[0]}`));
  }
  assert.equal(effective(settingsDump("Ardia-macOS", ["GCC_PRODUCT_TYPE_PREPROCESSOR_DEFINITIONS = ", "DEBUG_INFORMATION_FORMAT = dwarf-with-dsym"])).status, 0);
});
