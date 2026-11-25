import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const nativeRoots = ["apps/phone/ios", "apps/phone/android", "packages/phone/ios", "packages/phone/android"];
const nativeSource = /\.(swift|kt|java|m|mm|c|cc|cpp|h)$/;
const testPath = /(^|\/)(Tests|src\/test|src\/androidTest)\//;

const allowedSystemSqlite = new Map([
  ["packages/phone/ios/PhoneSync/Sources/PhoneSync/SQLiteEngine.swift", "defines SQLiteEngine.system, which only PhoneSync's Mac tests use"],
  ["packages/phone/ios/PhoneLegacy.swift", "reads the old SwiftData store, a file expo-sqlite never opens"],
  ["packages/phone/android/src/main/java/com/ardia/phone/PhoneLegacy.kt", "reads the old Android app's database, a file expo-sqlite never opens"],
]);

const systemSqlite = [
  { name: "a system SQLite call", pattern: /(?<![A-Za-z0-9_.])sqlite3_[a-z0-9_]+\s*\(|\bSQLite3\.sqlite3_/ },
  { name: "Android's framework SQLite", pattern: /android\.database\.sqlite|SQLiteOpenHelper|openOrCreateDatabase\s*\(/ },
  { name: "the system SQLiteEngine", pattern: /SQLiteEngine\.system|engine:\s*\.system/ },
];

function nativeFiles() {
  const listed = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard", "--", ...nativeRoots], { cwd: repository, encoding: "utf8" });
  return listed.split("\0").filter((path) => nativeSource.test(path) && !testPath.test(path) && !path.includes("/node_modules/") && !path.includes("/Pods/"));
}

function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("the phone's native code reaches SQLite only through expo-sqlite's engine", () => {
  const files = nativeFiles();
  assert.ok(files.length > 50, `expected the phone's native sources, found ${files.length}`);
  const offenders = [];
  for (const path of files) {
    if (allowedSystemSqlite.has(path)) continue;
    const source = codeOnly(readFileSync(join(repository, path), "utf8"));
    for (const { name, pattern } of systemSqlite) {
      const match = source.match(pattern);
      if (match) offenders.push(`${path}: ${name} (${match[0].trim()})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "expo-sqlite bundles its own SQLite (exsqlite3_*), and the app's JS keeps browser.db open through it. A second engine in the " +
      "same process can't see that engine's file locks, so it resets the WAL index the first one has mapped and the app dies with " +
      "SIGBUS. Read through SQLiteEngine.expoSQLite on iOS or ExpoSqliteBrowserRows on Android instead, or add the file to " +
      "allowedSystemSqlite with the reason expo-sqlite never opens its database.",
  );
});

test("every file allowed to use the system SQLite still exists and still needs it", () => {
  const files = new Set(nativeFiles());
  for (const [path, reason] of allowedSystemSqlite) {
    assert.ok(files.has(path), `${path} is allowed to use the system SQLite (${reason}) but is gone: remove it from the list`);
    const source = codeOnly(readFileSync(join(repository, path), "utf8"));
    assert.ok(
      systemSqlite.some(({ pattern }) => pattern.test(source)),
      `${path} no longer uses the system SQLite: remove it from allowedSystemSqlite`,
    );
  }
});
