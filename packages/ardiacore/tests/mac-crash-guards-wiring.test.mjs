import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const delegate = read("../../../engine/ardiacore/src/ardia/core/ac_main_delegate.cc");
const switchesSource = read("../../../engine/ardiacore/src/ardia/core/ac_feature_switches.cc");
const clang = ["clang++"].find((name) => spawnSync(name, ["--version"]).status === 0);
const softNavigationPatchName = "chromium-mac-soft-navigation-time-origin.patch";
const softNavigationPatch = read(`../../../engine/patches/${softNavigationPatchName}`);
const parseSteps = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [kind, name, platform = "all"] = line.split(/\s+/);
      return { kind, name, platform };
    });
const series = parseSteps(read("../../../engine/patches/series"));
const seriesWin = parseSteps(read("../../../scripts/windows/engine/series-win"));

const functionBody = (source, signature) => {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `no ${signature}`);
  const open = source.indexOf("{", start + signature.length - 1);
  let depth = 0;
  for (let at = open; at < source.length; at += 1) {
    if (source[at] === "{") depth += 1;
    if (source[at] === "}") depth -= 1;
    if (depth === 0) return source.slice(open, at + 1);
  }
  assert.fail(`${signature} never closes`);
};

test("the dump mode and the user's own overrides hold when the real helper runs", { skip: !clang && "clang++ is required" }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "ardia-feature-switches-"));
  try {
    const binary = join(scratch, "feature-switches");
    const compiled = spawnSync(
      clang,
      [
        "-std=c++20", "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined,address", "-g",
        "-I", fileURLToPath(new URL("./fixtures/feature-switches", import.meta.url)),
        "-I", fileURLToPath(new URL("../../../engine/ardiacore/src", import.meta.url)),
        fileURLToPath(new URL("../../../engine/ardiacore/src/ardia/core/ac_feature_switches.cc", import.meta.url)),
        fileURLToPath(new URL("./feature-switches.test.cc", import.meta.url)),
        "-o", binary,
      ],
      { encoding: "utf8", timeout: 180_000 },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 60_000 });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /feature switch scenarios passed/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the helper takes the names from base and reads entries with Chromium's own parser", () => {
  const body = functionBody(switchesSource, "void ReportDanglingUnretainedWithoutCrashing(base::CommandLine* command_line)");
  assert.match(body, /base::features::kPartitionAllocUnretainedDanglingPtr\.name/);
  assert.match(body, /base::features::kUnretainedDanglingPtrModeParam\.name/);
  assert.match(body, /"\/dump_without_crashing"/);
  assert.ok(!/kDisableFeatures/.test(body), "the feature stays on, so BackupRefPtr still quarantines the freed object");
  const decides = functionBody(switchesSource, "bool CommandLineDecidesFeature(const base::CommandLine& command_line, std::string_view feature)");
  assert.match(decides, /EnableListDecidesFeature\(command_line\.GetSwitchValueASCII\(switches::kEnableFeatures\), feature\)/);
  assert.match(decides, /DisableListNamesFeature\(command_line\.GetSwitchValueASCII\(switches::kDisableFeatures\), feature\)/);
  const enables = functionBody(switchesSource, "bool EnableListDecidesFeature(std::string_view value, std::string_view feature)");
  assert.match(enables, /base::FeatureList::ParseEnableFeatureString\(entry, &name, &study, &group, &params\)/);
  const disables = functionBody(switchesSource, "bool DisableListNamesFeature(std::string_view value, std::string_view feature)");
  assert.match(disables, /SameFeature\(entry\.substr\(0, entry\.find\('<'\)\), feature\)/);
  assert.ok(!/ParseEnableFeatureString/.test(disables), "Chromium reads --disable-features entries as Feature<Trial only");
  assert.match(switchesSource, /#include "base\/allocator\/partition_alloc_features\.h"/);
  assert.match(switchesSource, /#include "base\/feature_list\.h"/);
  assert.match(read("../../../engine/ardiacore/src/ardia/core/BUILD.gn"), /"ac_feature_switches\.cc",\n\s+"ac_feature_switches\.h",/);
});

test("only the browser process adds the mode, before Chrome initializes its feature list; helpers inherit the browser's", () => {
  const startup = functionBody(delegate, "std::optional<int> ACMainDelegate::BasicStartupComplete()");
  const browserOnly = functionBody(startup, "if (!command_line->HasSwitch(switches::kProcessType)) {");
  assert.equal(browserOnly.split("ReportDanglingUnretainedWithoutCrashing(command_line);").length, 2);
  assert.equal(startup.split("ReportDanglingUnretainedWithoutCrashing(").length, 2);
  assert.ok(startup.indexOf(browserOnly) < startup.indexOf("return ChromeMainDelegate::BasicStartupComplete();"));
  assert.match(delegate, /#include "ardia\/core\/ac_feature_switches\.h"/);
  assert.ok(!/void MergeFeatures\(/.test(delegate), "one MergeFeatures, the tested one");
});

test("the soft navigation patch takes Chromium's Fuchsia early return on the Mac and changes nothing else", () => {
  const changed = softNavigationPatch
    .split("\n")
    .filter((line) => /^[-+](?![-+]{2} )/.test(line));
  assert.deepEqual(changed, ["-#if BUILDFLAG(IS_FUCHSIA)", "+#if BUILDFLAG(IS_FUCHSIA) || BUILDFLAG(IS_MAC)"]);
  const files = softNavigationPatch.split("\n").filter((line) => line.startsWith("+++ "));
  assert.deepEqual(files, ["+++ b/third_party/blink/renderer/core/timing/soft_navigation_heuristics.cc"]);
  assert.equal(softNavigationPatch.split("\n").filter((line) => line.startsWith("@@ ")).length, 1);
  assert.match(softNavigationPatch, /\n {5}if \(context->TimeOrigin\(\) <= loader->GetTiming\(\)\.ReferenceMonotonicTime\(\)\) \{\n/);
});

test("the soft navigation patch is in the Mac series only, and Windows skips it so its engine key stays", () => {
  const steps = series.filter((step) => step.name === softNavigationPatchName);
  assert.deepEqual(steps, [{ kind: "chromium", name: softNavigationPatchName, platform: "mac" }]);
  const firstLayer = series.findIndex((step) => step.kind === "layer");
  assert.ok(series.indexOf(steps[0]) < firstLayer);
  assert.deepEqual(
    seriesWin.filter((step) => step.name === softNavigationPatchName),
    [{ kind: "skip", name: softNavigationPatchName, platform: "all" }],
  );
});
