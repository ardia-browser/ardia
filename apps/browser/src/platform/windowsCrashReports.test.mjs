import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SAMPLE_GPU_MODULE, sampleMinidump, toHex } from "../../../../packages/expo-windows/src/selfCheck/sampleMinidump.ts";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const read = (path) => readFileSync(here(path), "utf8");
const host = "../../windows/Ardia/";

const work = mkdtempSync(join(tmpdir(), "windows-crash-"));
const probe = join(work, "probe");
let compiled = false;
let compileError = "";
let sequence = 0;

before(() => {
  for (const compiler of ["c++", "g++", "clang++"]) {
    try {
      execFileSync(compiler, ["-std=c++20", "-Wall", "-Wextra", "-Werror", "-I", here(host), here("./fixtures/crashDumpsProbe.cc"), "-o", probe], { stdio: "pipe" });
      compiled = true;
      return;
    } catch (error) {
      if (error.code !== "ENOENT") {
        compileError = String(error.stderr || error.message);
        throw error;
      }
    }
  }
});

after(() => rmSync(work, { recursive: true, force: true }));

const folder = () => {
  const dir = join(work, `reports-${sequence++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const put = (dir, name, bytes, seconds) => {
  const file = join(dir, name);
  writeFileSync(file, bytes);
  if (seconds !== undefined) utimesSync(file, seconds, seconds);
  return file;
};

const collect = (since, ...dirs) => {
  const out = execFileSync(probe, ["collect", String(since), ...dirs], { encoding: "utf8" });
  const reports = [];
  let current = null;
  for (const line of out.split("\n")) {
    if (line === "report") current = { frames: [] };
    else if (line === "end") reports.push(current);
    else if (line && current) {
      const [key, ...rest] = line.split("\t");
      if (key === "frame") current.frames.push({ image: rest[0], offset: rest[1] === undefined ? undefined : Number(rest[1]) });
      else current[key] = rest.join("\t");
    }
  }
  return { out, reports };
};

const gate = (t) => {
  if (!compiled) t.skip("no C++ compiler here");
  return compiled;
};

test("the header compiles clean with no warnings", (t) => {
  if (gate(t)) assert.equal(compileError, "");
});

test("a GPU process dump reads as process, exception, faulting module, uptime and engine version", (t) => {
  if (!gate(t)) return;
  const dir = folder();
  put(dir, "5b1f3c2e-9d4a-4c7e-8a10-0123456789ab.dmp", sampleMinidump({ process: "gpu-process", engineVersion: "157.0.8103.50" }), 1_700_000_000);
  const { reports, out } = collect(0, dir);
  assert.equal(reports.length, 1, out);
  const [report] = reports;
  assert.equal(report.incidentId, "5b1f3c2e-9d4a-4c7e-8a10-0123456789ab");
  assert.equal(report.process, "gpu");
  assert.equal(report.terminationNamespace, "WIN32_EXCEPTION");
  assert.equal(report.signal, "EXCEPTION_ACCESS_VIOLATION");
  assert.equal(report.exceptionSubtype, "ACCESS_READ");
  assert.equal(report.engineVersion, "157.0.8103.50");
  assert.equal(report.appVersion, "");
  assert.equal(report.uptimeSeconds, "3");
  assert.equal(report.time, "1794770653000");
  assert.ok(Math.abs(Number(report.fileTime) - 1_700_000_000_000) < 5000, `fileTime is ${report.fileTime}`);
  assert.deepEqual(report.frames, [{ image: SAMPLE_GPU_MODULE, offset: 0x1234 }]);
});

test("a browser process dump has no ptype, names the app module and carries the app version", (t) => {
  if (!gate(t)) return;
  const dir = folder();
  put(dir, "browser.dmp", sampleMinidump({ appVersion: "1.4.2", code: 0xc0000409, address: 0x7ff600000000 + 0x400 }));
  const [report] = collect(0, dir).reports;
  assert.equal(report.process, "browser");
  assert.equal(report.signal, "STATUS_STACK_BUFFER_OVERRUN");
  assert.equal(report.exceptionSubtype, "");
  assert.equal(report.appVersion, "1.4.2");
  assert.equal(report.engineVersion, "");
  assert.deepEqual(report.frames, [{ image: "Ardia.exe", offset: 0x400 }]);
});

test("the access kind, unknown codes and addresses outside every module read without guessing", (t) => {
  if (!gate(t)) return;
  const dir = folder();
  put(dir, "write.dmp", sampleMinidump({ process: "renderer", firstParameter: 1 }), 1_700_000_001);
  put(dir, "execute.dmp", sampleMinidump({ process: "extension", firstParameter: 8 }), 1_700_000_002);
  put(dir, "unknown.dmp", sampleMinidump({ process: "utility", code: 0xdeadbeef, address: 0x10 }), 1_700_000_003);
  put(dir, "other.dmp", sampleMinidump({ process: "ppapi" }), 1_700_000_004);
  put(dir, "odd.dmp", sampleMinidump({ process: "something-new", code: 0xc0000005, firstParameter: 7 }), 1_700_000_005);
  const byName = Object.fromEntries(collect(0, dir).reports.map((report) => [report.incidentId, report]));
  assert.equal(byName.write.exceptionSubtype, "ACCESS_WRITE");
  assert.equal(byName.write.process, "renderer");
  assert.equal(byName.execute.exceptionSubtype, "ACCESS_EXECUTE");
  assert.equal(byName.execute.process, "renderer");
  assert.equal(byName.unknown.signal, "STATUS_DEADBEEF");
  assert.equal(byName.unknown.exceptionSubtype, "");
  assert.deepEqual(byName.unknown.frames, [{ image: "???", offset: undefined }]);
  assert.equal(byName.other.process, "plugin");
  assert.equal(byName.odd.process, "utility");
  assert.equal(byName.odd.exceptionSubtype, "");
});

test("a report holds no path, URL or free text, whatever the dump carries", (t) => {
  if (!gate(t)) return;
  const dir = folder();
  put(dir, "gpu.dmp", sampleMinidump({ process: "gpu-process", engineVersion: "157.0.8103.50" }));
  put(dir, "browser.dmp", sampleMinidump({ appVersion: "1.4.2" }));
  put(dir, "hostileBrowser.dmp", sampleMinidump({ appVersion: "1.2.3 C:\\Users\\someone\\secret" }));
  put(dir, "hostileGpu.dmp", sampleMinidump({ process: "gpu-process", engineVersion: "https://example.com/?q=private" }));
  const { out, reports } = collect(0, dir);
  assert.equal(reports.length, 4);
  assert.doesNotMatch(out, /Program Files|System32|DriverStore|Users|someone|secret|example\.com|https?:|[A-Za-z]:\\|\\|\/Users|\/tmp/, out);
  const byName = Object.fromEntries(reports.map((report) => [report.incidentId, report]));
  assert.equal(byName.hostileBrowser.appVersion, "");
  assert.equal(byName.hostileGpu.engineVersion, "");
  assert.equal(byName.hostileGpu.process, "gpu");
});

test("an engine version is accepted only as two to four dotted numbers, an app version only with an optional channel", (t) => {
  if (!gate(t)) return;
  const engines = [["157.0", "157.0"], ["157.0.8103", "157.0.8103"], ["157.0.8103.50", "157.0.8103.50"], ["1.2.3.4.5", ""], ["157", ""], ["157..0", ""], ["157.0.", ""], ["a.b", ""], ["", ""]];
  for (const [sent, expected] of engines) {
    const dir = folder();
    put(dir, "one.dmp", sampleMinidump({ process: "gpu-process", engineVersion: sent }));
    const reports = collect(0, dir).reports;
    assert.equal(reports.length, 1, sent);
    assert.equal(reports[0].engineVersion, expected, `engine version ${JSON.stringify(sent)}`);
  }
  const apps = [["1.4.2", "1.4.2"], ["1.4.2-beta.3", "1.4.2-beta.3"], ["1.4", ""], ["1.4.2-", ""], ["1.4.2-Beta.3", ""], ["v1.4.2", ""]];
  for (const [sent, expected] of apps) {
    const dir = folder();
    put(dir, "one.dmp", sampleMinidump({ appVersion: sent }));
    const reports = collect(0, dir).reports;
    assert.equal(reports.length, 1, sent);
    assert.equal(reports[0].appVersion, expected, `app version ${JSON.stringify(sent)}`);
  }
});

test("a simulated dump, a dump with no exception and damaged files are skipped, not fatal", (t) => {
  if (!gate(t)) return;
  const dir = folder();
  const good = sampleMinidump({ process: "gpu-process" });
  put(dir, "simulated.dmp", sampleMinidump({ code: 0x517a7ed }));
  put(dir, "good.dmp", good);
  put(dir, "short.dmp", good.slice(0, 40));
  put(dir, "half.dmp", good.slice(0, Math.floor(good.length / 2)));
  put(dir, "garbage.dmp", new Uint8Array(512).fill(0xab));
  put(dir, "empty.dmp", new Uint8Array(0));
  put(dir, "note.txt", good);
  put(dir, "good.dmp.tmp", good);
  const withoutException = Uint8Array.from(good);
  new DataView(withoutException.buffer).setUint32(8, 0, true);
  put(dir, "noStreams.dmp", withoutException);
  mkdirSync(join(dir, "folder.dmp"));
  const { reports } = collect(0, dir);
  assert.deepEqual(reports.map((report) => report.incidentId), ["good"]);
  assert.deepEqual(collect(0, join(work, "missing")).reports, []);
});

test("only dumps newer than since come back, from every folder, newest five of each kind", (t) => {
  if (!gate(t)) return;
  const first = folder();
  const second = folder();
  put(first, "old.dmp", sampleMinidump({ process: "gpu-process" }), 1_600_000_000);
  put(second, "new.dmp", sampleMinidump({ process: "gpu-process" }), 1_700_000_000);
  assert.deepEqual(collect(1_650_000_000_000, first, second).reports.map((report) => report.incidentId), ["new"]);
  assert.deepEqual(collect(1_750_000_000_000, first, second).reports, []);
  assert.deepEqual(collect(0, first, second).reports.map((report) => report.incidentId), ["old", "new"]);

  const many = folder();
  for (let index = 0; index < 7; index++) {
    put(many, `b${index}.dmp`, sampleMinidump({ appVersion: "1.4.2" }), 1_700_000_100 + index);
    put(many, `g${index}.dmp`, sampleMinidump({ process: "gpu-process" }), 1_700_000_200 + index);
  }
  const kept = collect(0, many).reports.map((report) => report.incidentId);
  assert.deepEqual(kept, ["b2", "b3", "b4", "b5", "b6", "g2", "g3", "g4", "g5", "g6"]);
});

test("a file name that is not a plain dump name has no incident id and the fixture writer refuses it", (t) => {
  if (!gate(t)) return;
  const dir = folder();
  put(dir, "has space.dmp", sampleMinidump({ process: "gpu-process" }));
  assert.equal(collect(0, dir).reports[0].incidentId, "");
  const name = (value) => execFileSync(probe, ["name", value], { encoding: "utf8" }).trim();
  assert.equal(name("a.dmp"), "1");
  assert.equal(name("A.DMP"), "1");
  for (const bad of [".dmp", "a.txt", "..\\a.dmp", "../a.dmp", "C:a.dmp", "a/b.dmp", "a*.dmp", "..", "x".repeat(130) + ".dmp"]) assert.equal(name(bad), "0", bad);
  const hex = (value) => execFileSync(probe, ["hex", value], { encoding: "utf8" }).trim();
  assert.equal(hex("00ff10"), "3");
  assert.equal(hex("0g"), "none");
  assert.equal(hex("abc"), "none");
});

test("a dump over the size limit is left unread", (t) => {
  if (!gate(t)) return;
  const dir = folder();
  const file = put(dir, "big.dmp", sampleMinidump({ process: "gpu-process" }));
  truncateSync(file, 33 * 1024 * 1024);
  assert.deepEqual(collect(0, dir).reports, []);
});

test("the hex encoder and the sample builder agree on a dump's bytes", () => {
  const bytes = sampleMinidump({});
  assert.equal(toHex(bytes).length, bytes.length * 2);
  assert.equal(toHex(bytes).slice(0, 8), "4d444d50");
});

test("the Windows host reads the profile's Crashpad folders instead of answering an empty list", () => {
  const module = read(`${host}AppModule.h`);
  const crashReports = module.slice(module.indexOf("REACT_METHOD(crashReports)"), module.indexOf("REACT_METHOD(devWriteCrashFixture)"));
  assert.match(crashReports, /AppCrashReports::Since\(since\)/);
  assert.match(crashReports, /std::thread/);
  assert.match(module, /Crashpad" \/ L"reports"/);
  assert.match(module, /User Data" \/ L"Crashpad"/);
  assert.match(module, /#include "CrashDumps\.h"/);
});

test("the report built for JS names no file and the host reads no environment for it", () => {
  const module = read(`${host}AppModule.h`);
  const describe = module.slice(module.indexOf("inline winrt::Microsoft::ReactNative::JSValue Describe"), module.indexOf("inline winrt::Microsoft::ReactNative::JSValue Since"));
  assert.ok(describe.length > 200);
  assert.doesNotMatch(describe, /path|\.native\(\)|string\(\)|filename|Folders\(\)/i);
  const dumps = read(`${host}CrashDumps.h`);
  assert.doesNotMatch(`${module}${dumps}`, /getenv|GetEnvironmentVariable|_wgetenv/);
  assert.match(dumps, /annotations\.find\("ptype"\)/);
  assert.match(dumps, /annotations\.find\("ver"\)/);
  assert.match(dumps, /annotations\.find\("ardia-ver"\)/);
});

test("only a test instance can write a dump fixture, and only a plain dump name", () => {
  const module = read(`${host}AppModule.h`);
  const writer = module.slice(module.indexOf("REACT_METHOD(devWriteCrashFixture)"), module.indexOf("REACT_METHOD(appIcons)"));
  assert.match(writer, /AppLaunch::Shared\(\)\.testInstance/);
  assert.match(writer, /Reject/);
  assert.ok(writer.indexOf("testInstance") < writer.indexOf("AppCrashReports::Store"));
  assert.match(module, /CrashDumps::IsDumpFileName\(name\)/);
});

test("the project builds CrashDumps.h and the self-check writes a sample dump through the fixture writer", () => {
  assert.match(read(`${host}Ardia.vcxproj`), /<ClInclude Include="CrashDumps\.h" \/>/);
  const check = read("../../../../packages/expo-windows/src/selfCheck/appSystem.ts");
  assert.match(check, /devWriteCrashFixture\(`\$\{stem\}\.dmp`, toHex\(dump\)\)/);
  assert.match(check, /sampleMinidump\(\{ process: "gpu-process"/);
  assert.match(read("../../../../packages/expo-windows/src/nativeModuleTypes.ts"), /devWriteCrashFixture\(name: string, hex: string\): Promise<boolean>/);
});
