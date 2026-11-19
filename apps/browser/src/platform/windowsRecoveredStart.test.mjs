import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../../windows/Ardia/AppModule.h");
const engine = read("../../../../scripts/windows/engine/src/ardia/win/main.cc");
const guard = app.slice(app.indexOf("namespace LaunchGuard {"), app.indexOf("REACT_STRUCT(SystemInfo)"));

test("launchConfig() carries recoveredStart as a real boolean from the launch guard", () => {
  assert.match(app, /LaunchSnapshot\(AppLaunch::Config const &config, bool recoveredStart\) noexcept/);
  assert.match(app, /snapshot\["recoveredStart"\] = JSValue\{recoveredStart\};/);
  assert.match(app, /return LaunchSnapshot\(AppLaunch::Shared\(\), LaunchGuard::RecoveredStart\(\)\);/);
});

test("the app reads the file and field the engine writes, from the same data folder", () => {
  assert.ok(guard.length > 0, "namespace LaunchGuard not found in AppModule.h");
  assert.match(engine, /data_dir \+ L"\\\\launch-guard\.json"/);
  assert.match(engine, /saved\.Set\("restoreStateSetAside", !facts\.recovered_to\.empty\(\)\);/);
  assert.match(guard, /constexpr wchar_t FactsFile\[\] = L"launch-guard\.json";/);
  assert.match(guard, /Paths::DataDirectory\(\) \/ FactsFile/);
  assert.match(guard, /TryLookup\(L"restoreStateSetAside"\)/);
});

test("only a boolean true written during this process's start counts, and nothing throws", () => {
  assert.match(guard, /setAside && setAside\.ValueType\(\) == JsonValueType::Boolean && setAside\.GetBoolean\(\)/);
  assert.match(guard, /if \(!JsonObject::TryParse\(winrt::to_hstring\(text\), facts\) \|\| !facts\) return false;/);
  assert.match(guard, /AppDiagnostics::ProcessStart\(\);\n  return start && AppDiagnostics::UnixMilliseconds\(written\) >= \*start;/);
  assert.match(guard, /if \(!WrittenThisStart\(info\.ftLastWriteTime\)\) return false;/);
  assert.match(guard, /if \(!file\) return false;/);
  const functions = [...guard.matchAll(/^inline [^\n]*\(/gm)].map((m) => m[0]);
  assert.equal(functions.length, 4);
  for (const name of functions) assert.match(guard, new RegExp(`${name.replace(/[()*&]/g, "\\$&")}[^)]*\\) noexcept \\{`), name);
  assert.equal((guard.match(/try \{/g) ?? []).length, 2);
  assert.match(guard, /static const bool recovered = ReadRecoveredStart\(\);/);
});
