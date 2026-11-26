import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LIQUID_DOM_NOTICE, PORTED_CREDITS } from "./portedCredits.ts";
import { creditInputs, CREDITS_FILE, gradleArtifacts, importerBlock, nativeCredits, packageRoot, projectDocument, repositoryUrl } from "../../../test/credits.ts";

test("the licenses page was generated from the current lockfile and the module's Gradle libraries", () => {
  const credits = JSON.parse(readFileSync(CREDITS_FILE, "utf8"));
  assert.equal(credits.inputs, creditInputs(), "dependencies changed: bundle once, then run pnpm -C apps/phone credits <source map>");
  assert.ok(credits.packages.length > 0);
  for (const credit of [...credits.packages, ...credits.native]) {
    assert.ok(credit.name && credit.license && /^https?:\/\//.test(credit.url), JSON.stringify(credit));
  }
});

test("a bundled module path names its package, scoped or not", () => {
  assert.equal(packageRoot("/r/node_modules/.pnpm/react-native@0.81.6/node_modules/react-native/Libraries/A.js"), "/r/node_modules/.pnpm/react-native@0.81.6/node_modules/react-native");
  assert.equal(packageRoot("/r/node_modules/@babel/runtime/helpers/x.js"), "/r/node_modules/@babel/runtime");
  assert.equal(packageRoot("/r/packages/core/src/mobile.ts"), null);
});

test("a package's link comes from its repository, then its homepage, then npm", () => {
  assert.equal(repositoryUrl({ name: "a", repository: "git+https://github.com/x/a.git" }), "https://github.com/x/a");
  assert.equal(repositoryUrl({ name: "a", repository: { url: "git://github.com/x/a.git" } }), "https://github.com/x/a");
  assert.equal(repositoryUrl({ name: "a", repository: "x/a" }), "https://github.com/x/a");
  assert.equal(repositoryUrl({ name: "a", homepage: "https://a.dev" }), "https://a.dev");
  assert.equal(repositoryUrl({ name: "@s/a" }), "https://www.npmjs.com/package/@s/a");
});

test("every Gradle library the module adds needs a recorded license", () => {
  const gradle = 'dependencies {\n  implementation "androidx.core:core:1.16.0"\n  implementation "com.google.zxing:core:3.5.4"\n  implementation "com.facebook.react:react-android"\n}';
  assert.deepEqual(gradleArtifacts(gradle), ["androidx.core:core", "com.google.zxing:core", "com.facebook.react:react-android"]);
  assert.deepEqual(nativeCredits(gradleArtifacts(gradle)).map((credit) => credit.name), ["Android Jetpack (AndroidX)", "ZXing"]);
  assert.throws(() => nativeCredits(["io.unknown:thing"]), /no license recorded/);
});

test("the app's importer comes from the project document, not pnpm's package manager document before it", () => {
  const project = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      y: 2\n\npackages:\n";
  const lockfile = `---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    packageManagerDependencies:\n      pnpm: 12\n\npackages: {}\n\n---\n${project}`;
  assert.equal(projectDocument(lockfile), project);
  assert.equal(projectDocument(project), project);
  assert.equal(importerBlock(projectDocument(lockfile), "."), "  .:\n    dependencies:\n      y: 2\n");
});

test("the lockfile section for one app ends where the next begins", () => {
  const lockfile = "importers:\n\n  apps/a:\n    dependencies:\n      x: 1\n\n  apps/phone:\n    dependencies:\n      y: 2\n\n  packages/z:\n    dependencies: {}\n\npackages:\n";
  assert.equal(importerBlock(lockfile, "apps/phone"), "  apps/phone:\n    dependencies:\n      y: 2\n");
});

test("both phones ship liquid-dom's MIT notice in full, the same text as third_party/liquid-dom/LICENSE", () => {
  const license = readFileSync(new URL("../../../../../third_party/liquid-dom/LICENSE", import.meta.url), "utf8").trimEnd();
  assert.equal(LIQUID_DOM_NOTICE, license);
  assert.match(LIQUID_DOM_NOTICE, /Copyright \(c\) 2026 Andras Prifer/);
  assert.match(LIQUID_DOM_NOTICE, /Permission is hereby granted, free of charge/);
  assert.deepEqual(PORTED_CREDITS.map((credit) => [credit.name, credit.license, credit.notice]), [["liquid-dom", "MIT", LIQUID_DOM_NOTICE]]);
  const source = readFileSync(new URL("./libraryCredits.ts", import.meta.url), "utf8");
  assert.match(source, /\[\.\.\.androidNative\(\), \.\.\.PORTED_CREDITS\]/);
  assert.match(source, /\[\.\.\.IPHONE_NATIVE_CREDITS, \.\.\.PORTED_CREDITS\]/);
});
