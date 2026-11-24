import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareApp, untouchedCopy } from "./app-copy.mjs";

const macTest = (name, fn) => test(name, { skip: process.platform !== "darwin" && "codesign is macOS only" }, fn);

const PLIST = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fake</string><key>CFBundleIdentifier</key><string>dev.ardia.fake</string></dict></plist>`;
const entitlements = (keys) => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${keys.map((k) => `<key>${k}</key><true/>`).join("")}</dict></plist>`;

function fakeApp({ debug = false, bundle = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "app-copy-"));
  const app = join(dir, "Fake.app");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents/Resources"), { recursive: true });
  writeFileSync(join(app, "Contents/Info.plist"), PLIST);
  copyFileSync("/usr/bin/true", join(app, "Contents/MacOS/Fake"));
  if (bundle) writeFileSync(join(app, "Contents/Resources/main.jsbundle"), "shipped");
  writeFileSync(join(app, "Contents/Resources/strings.txt"), "sealed");
  const plist = join(dir, "ent.plist");
  writeFileSync(plist, entitlements(debug ? ["com.apple.security.get-task-allow"] : []));
  execFileSync("codesign", ["--force", "--sign", "-", "--entitlements", plist, app], { stdio: "ignore" });
  const own = join(dir, "own.jsbundle");
  writeFileSync(own, "shipped");
  const other = join(dir, "other.jsbundle");
  writeFileSync(other, "the tree");
  return { dir, app, own, other };
}

const inodeOf = (path) => statSync(path).ino;

macTest("a release app run with its own bundle and no injection is cloned untouched: no ip.txt, no re-sign", () => {
  const { dir, app, own } = fakeApp();
  const copy = prepareApp(app, join(dir, "out"), { bundle: own });
  assert.equal(existsSync(join(copy, "Contents/Resources/ip.txt")), false);
  execFileSync("codesign", ["--verify", "--strict", copy]);
  assert.equal(readFileSync(join(copy, "Contents/Resources/main.jsbundle"), "utf8"), "shipped");
});

macTest("the untouched copy is reused on the next run instead of cloned again", () => {
  const { dir, app, own } = fakeApp();
  const first = prepareApp(app, join(dir, "out"), { bundle: own });
  const made = inodeOf(join(first, "Contents/Info.plist"));
  const second = prepareApp(app, join(dir, "out"), { bundle: own });
  assert.equal(second, first);
  assert.equal(inodeOf(join(second, "Contents/Info.plist")), made);
});

macTest("a copy left from another bundle is cloned fresh, not reused", () => {
  const { dir, app, own, other } = fakeApp();
  prepareApp(app, join(dir, "out"), { bundle: other });
  const copy = prepareApp(app, join(dir, "out"), { bundle: own });
  assert.equal(existsSync(join(copy, "Contents/Resources/ip.txt")), false);
  assert.equal(readFileSync(join(copy, "Contents/Resources/main.jsbundle"), "utf8"), "shipped");
  execFileSync("codesign", ["--verify", "--strict", copy]);
});

macTest("another bundle is swapped in and the copy re-signed", () => {
  const { dir, app, other } = fakeApp();
  const copy = prepareApp(app, join(dir, "out"), { bundle: other });
  assert.equal(readFileSync(join(copy, "Contents/Resources/main.jsbundle"), "utf8"), "the tree");
  assert.equal(existsSync(join(copy, "Contents/Resources/ip.txt")), true);
  execFileSync("codesign", ["--verify", "--strict", copy]);
});

macTest("a debug build still gets ip.txt, so it can't load Metro's code instead of its bundle", () => {
  const { dir, app, own } = fakeApp({ debug: true });
  const copy = prepareApp(app, join(dir, "out"), { bundle: own });
  assert.equal(existsSync(join(copy, "Contents/Resources/ip.txt")), true);
  execFileSync("codesign", ["--verify", "--strict", copy]);
});

macTest("the injection entitlements still force a re-sign", () => {
  const { dir, app, own } = fakeApp();
  const copy = prepareApp(app, join(dir, "out"), { bundle: own, entitlements: ["com.apple.security.cs.disable-library-validation"] });
  assert.match(execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", copy], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), /disable-library-validation/);
});

test("untouchedCopy: only an unchanged release bundle without missing entitlements skips the re-sign", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-copy-plain-"));
  const app = join(dir, "Plain.app");
  mkdirSync(join(app, "Contents/Resources"), { recursive: true });
  writeFileSync(join(app, "Contents/Resources/main.jsbundle"), "shipped");
  const own = join(dir, "own.jsbundle");
  writeFileSync(own, "shipped");
  const other = join(dir, "other.jsbundle");
  writeFileSync(other, "the tree");
  const granted = "<plist><dict></dict></plist>";
  assert.equal(untouchedCopy({ source: app, bundle: null, granted, missing: [] }), true);
  assert.equal(untouchedCopy({ source: app, bundle: own, granted, missing: [] }), true);
  assert.equal(untouchedCopy({ source: app, bundle: other, granted, missing: [] }), false);
  assert.equal(untouchedCopy({ source: app, bundle: own, granted, missing: ["x"] }), false);
  assert.equal(untouchedCopy({ source: app, bundle: own, granted: "<key>com.apple.security.get-task-allow</key>", missing: [] }), false);
});

macTest("a cached copy whose resources were changed after cloning is cloned again, not reused", () => {
  const { dir, app, own } = fakeApp();
  const first = prepareApp(app, join(dir, "out"), { bundle: own });
  writeFileSync(join(first, "Contents/Resources/main.jsbundle"), "tampered");
  const second = prepareApp(app, join(dir, "out"), { bundle: own });
  assert.equal(readFileSync(join(second, "Contents/Resources/main.jsbundle"), "utf8"), "shipped");
  execFileSync("codesign", ["--verify", "--strict", second]);
});

macTest("a source app whose bundle was edited without re-signing fails before launch, asking for a re-sign, instead of handing out a stale or broken copy", () => {
  const { dir, app, own } = fakeApp();
  prepareApp(app, join(dir, "out"), { bundle: own });
  writeFileSync(join(app, "Contents/Resources/main.jsbundle"), "edited in place");
  writeFileSync(own, "edited in place");
  assert.throws(() => prepareApp(app, join(dir, "out"), { bundle: own }), /re-sign the source app/);
  assert.throws(() => prepareApp(app, join(dir, "fresh"), { bundle: own }), /re-sign the source app/);
});

macTest("a source with no bundle of its own, run without one, is reused rather than cloned every time", () => {
  const { dir, app } = fakeApp({ bundle: false });
  const first = prepareApp(app, join(dir, "out"));
  const made = inodeOf(join(first, "Contents/Info.plist"));
  assert.equal(inodeOf(join(prepareApp(app, join(dir, "out")), "Contents/Info.plist")), made);
});

macTest("a cached copy isn't reused when any sealed resource of the source changed without a re-sign, not only its bundle", () => {
  const { dir, app, own } = fakeApp();
  prepareApp(app, join(dir, "out"), { bundle: own });
  writeFileSync(join(app, "Contents/Resources/strings.txt"), "edited in place");
  assert.throws(() => prepareApp(app, join(dir, "out"), { bundle: own }), /re-sign the source app/);
});
