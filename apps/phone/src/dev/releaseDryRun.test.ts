import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const script = read("../../scripts/release-ios");
const workflow = read("../../../../.github/workflows/ios-release.yml");
const exportOptions = read("../../ios/Config/ExportOptions-TestFlight.plist");

test("a dry run stops at the signed archive, before the export that opens an App Store Connect upload record", () => {
  const exports = [...script.matchAll(/xcodebuild -exportArchive/g)];
  assert.equal(exports.length, 2, "release-ios exports in two places: the development build and the upload");
  const stop = script.indexOf('if [ "$upload" = 0 ]; then');
  assert.ok(stop > 0, "release-ios stops when it isn't uploading");
  const stopBlock = script.slice(stop, script.indexOf("\nfi\n", stop));
  assert.match(stopBlock, /exit 0/);
  assert.ok(exports[1]!.index! > stop, "the App Store Connect export runs only after the dry run has stopped");
});

test("the development build exports for the team's registered iPhones and never for App Store Connect", () => {
  const start = script.indexOf('if [ "$development" = 1 ]; then');
  assert.ok(start > 0, "release-ios has a development export");
  const block = script.slice(start, script.indexOf("\nfi\n", start));
  const exported = block.indexOf("xcodebuild -exportArchive");
  const method = block.indexOf('-c "Set :method debugging" -c "Set :destination export" -c "Delete :uploadSymbols"');
  assert.ok(method > 0 && exported > method, "the export options become a development export before it runs");
  assert.match(block, /exit 0/, "it stops there, before the upload");
  assert.equal([...script.matchAll(/Set :destination export/g)].length, 1, "nothing else exports without uploading: an app-store export opens an upload record");
  assert.match(script, /--development\) development=1; upload=0/, "it never uploads");
  assert.match(script, /"\$development" = 0 \] \|\| \[ "\$unsigned" = 0 \] \|\| die/, "it is always signed");
});

test("the upload is the only step that sends anything, and the dry run reads the number without reserving it", () => {
  assert.match(exportOptions, /<key>destination<\/key>\s*<string>upload<\/string>/);
  assert.match(script, /--no-upload\) upload=0/);
  assert.match(workflow, /if \[ "\$MODE" = device \]; then args\+=\(--development\); elif \[ "\$MODE" != upload \]; then args\+=\(--no-upload\); fi/, "device builds for a cable, and every other mode but upload passes --no-upload");
  assert.match(workflow, /steps:\n\s+- if: inputs\.mode == 'device'\n\s+name: Mask the UDID/, "the UDID is masked by the job's first step, before any step's environment is printed");
  assert.doesNotMatch(workflow, /apps\/ios\//, "the workflow runs the Expo app's scripts");
  const nextBuild = read("../../scripts/asc.mjs").match(/async function nextBuild\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(nextBuild.length > 0);
  assert.doesNotMatch(nextBuild, /\bpost\(|\bpatch\(|method: "(POST|PATCH|DELETE)"/, "next-build only reads");
});
