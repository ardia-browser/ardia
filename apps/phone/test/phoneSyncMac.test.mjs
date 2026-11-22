import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appProblems, seedProfile } from "../scripts/phone-sync-mac.mjs";

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phone-sync-mac-check-"));
  const app = path.join(root, "Ardia.app");
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  const binary = path.join(app, "Contents/MacOS/Ardia.debug.dylib");
  fs.writeFileSync(binary, "");
  const source = path.join(root, "AppModule.swift");
  fs.writeFileSync(source, 'Constant("apiVersion") { () -> Int in 68 }');
  const js = path.join(root, "nativeApi.ts");
  fs.writeFileSync(js, "export const NATIVE_API_VERSION = 68;");
  const pods = { lock: path.join(root, "Podfile.lock"), manifest: path.join(root, "Manifest.lock") };
  fs.writeFileSync(pods.lock, "PODS: a");
  fs.writeFileSync(pods.manifest, "PODS: a");
  const at = (file, seconds) => fs.utimesSync(file, seconds, seconds);
  return { app, binary, source, files: { source, js, pods }, at, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("an app built after the native API last changed, with current Pods, is fine", () => {
  const w = world();
  w.at(w.source, 1000);
  w.at(w.binary, 2000);
  assert.deepEqual(appProblems(w.app, w.files), []);
  w.cleanup();
});

test("an app built before the native API changed is refused before launch, naming the native API it lacks", () => {
  const w = world();
  w.at(w.binary, 1000);
  w.at(w.source, 2000);
  const problems = appProblems(w.app, w.files);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /needs native API 68/);
  w.cleanup();
});

test("Pods behind Podfile.lock are named, so pod install runs before the build", () => {
  const w = world();
  w.at(w.source, 1000);
  w.at(w.binary, 2000);
  fs.writeFileSync(w.files.pods.lock, "PODS: b");
  assert.match(appProblems(w.app, w.files).join("\n"), /Pods are behind/);
  w.cleanup();
});

test("a seeded copy keeps the profile and drops every sync file, so it never resumes the old identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
  const seed = path.join(root, "copy");
  const data = path.join(root, "mac");
  fs.mkdirSync(path.join(seed, "Chromium", "Default"), { recursive: true });
  for (const name of ["session.json", "sync.json", "sync-state.nns", "sync-journal.nns", "sync-snapshot.nns", "sync-key-abc", ".sync-key-staging", "Chromium/Default/History"]) fs.writeFileSync(path.join(seed, name), name);
  seedProfile(seed, data);
  assert.deepEqual(fs.readdirSync(data).sort(), ["Chromium", "session.json"]);
  assert.equal(fs.readFileSync(path.join(data, "Chromium/Default/History"), "utf8"), "Chromium/Default/History");
  assert.ok(fs.existsSync(path.join(seed, "sync-key-abc")), "the copy it was given is left alone");
  fs.rmSync(root, { recursive: true, force: true });
});

test("--seed refuses a live profile path", () => {
  assert.throws(() => seedProfile(path.join(os.homedir(), "Library/Application Support/Ardia"), "/tmp/never"), /never the live one|no profile copy/);
});
