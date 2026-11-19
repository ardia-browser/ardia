import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.0", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false });
const { setSharing } = await import("./client.ts");
const { captureException, reportNativeCrashes } = await import("./errors.ts");
const { appInfo } = await import("./transport.ts");

globalThis.fetch = async () => ({ status: 200 });
setSharing(true, "settings");
after(() => setSharing(false, "settings"));

const queued = () => JSON.parse(stub.docs.get("telemetry-queue.json") ?? "{}").events?.filter((e) => e.event === "$exception") ?? [];

test("a JS error is on disk the moment it's captured, so a crash right after can't lose it", () => {
  const before = queued().length;
  captureException(new TypeError("Attempting to run JS driven animation on a native node"), "react");
  const events = queued();
  assert.equal(events.length, before + 1);
  const props = events.at(-1).properties;
  assert.deepEqual(props.$exception_types, ["TypeError"]);
  assert.deepEqual(props.$exception_values, ["Attempting to run JS driven animation on a native node"]);
  assert.equal(props.$exception_list[0].value, "Attempting to run JS driven animation on a native node");
});

test("a native crash names its exception and the app's images at the top level, never its reason", async () => {
  stub.shellNativeModules.ArdiaApp.crashReports = async () => [
    {
      time: Date.now(),
      process: "browser",
      appVersion: "0.3.0",
      exceptionType: "EXC_CRASH",
      signal: "SIGABRT",
      exceptionName: "RCTFatalException",
      exceptionReason: "Unhandled JS Exception: moved to \"native\" earlier, js engine: hermes, stack:\nGroupBlock@1:2",
      frames: [{ image: "Chromium Framework", symbol: "ArdiaCoreMain", symbolOffset: 66417332, offset: 0x41a36e8 }],
      exceptionFrames: [{ image: "Ardia", offset: 0x38eab8 }],
      images: [{ name: "Ardia", uuid: "1c77ef99-77d4-3de8-9ba2-6929e276bc60" }],
    },
  ];
  await reportNativeCrashes();
  const props = queued().at(-1).properties;
  assert.equal(props.source, "native_crash");
  assert.equal(props.objc_exception, "RCTFatalException");
  assert.deepEqual(props.$exception_types, ["RCTFatalException", "EXC_CRASH"]);
  assert.deepEqual(props.$exception_values, ["Uncaught RCTFatalException", "EXC_CRASH (SIGABRT)"]);
  assert.equal(JSON.stringify(queued().at(-1)).includes("GroupBlock"), false);
  assert.deepEqual(props.crash_images, [{ name: "Ardia", uuid: "1c77ef99-77d4-3de8-9ba2-6929e276bc60" }]);
  assert.equal(props.$exception_list[0].stacktrace.frames[0].function, "Ardia + 0x38eab8");
  assert.equal(props.$exception_list[1].stacktrace.frames[0].function, "Chromium Framework + 0x41a36e8");
  assert.equal(props.$geoip_disable, true);
});

test("a Linux crash keeps chrome's GNU build id and offsets, and names the signal without a Mach exception", async () => {
  stub.shellNativeModules.ArdiaApp.crashReports = async () => [
    {
      incidentId: "89747b7c-1ee8-49d8-8e5a-ba71046b4683",
      time: Date.now(),
      fileTime: Date.now(),
      process: "renderer",
      engineVersion: "157.0.8103.50",
      signal: "SIGSEGV",
      exceptionSubtype: "SEGV_MAPERR",
      terminationNamespace: "SIGNAL",
      uptimeSeconds: 4,
      frames: [{ image: "chrome", offset: 0x4e10320 }, { image: "libc.so.6", offset: 0x29ca8 }],
      images: [{ name: "chrome", uuid: "c1b96add39548a6390cf940731feb816940d279b" }, { name: "libc.so.6", uuid: "0123456789abcdef0123456789abcdef01234567" }],
    },
  ];
  await reportNativeCrashes();
  const props = queued().at(-1).properties;
  assert.equal(props.source, "helper_crash");
  assert.equal(props.crash_process, "renderer");
  assert.equal(props.crash_signal, "SIGSEGV");
  assert.equal(props.crash_subtype, "SEGV_MAPERR");
  assert.equal(props.crashed_engine_version, "157.0.8103.50");
  assert.deepEqual(props.$exception_values, ["Crash (SIGSEGV)"]);
  assert.deepEqual(props.crash_images, [{ name: "chrome", uuid: "c1b96add39548a6390cf940731feb816940d279b" }]);
  const frames = props.$exception_list[0].stacktrace.frames;
  assert.equal(frames.at(-1).function, "chrome + 0x4e10320");
  assert.equal(frames.at(-1).in_app, true);
  assert.equal(frames[0].in_app, false);
});

test("a native crash carries the built-in page its session was on as ctx_webui_page, null for a web page or an older sample", async () => {
  const later = Date.now() + 60 * 60_000;
  let n = 0;
  for (const [webui_page, expected] of [["settings/cookies", "settings/cookies"], [null, null], [undefined, null]]) {
    const time = later + 10_000 * ++n;
    const saved = { at: time - 500, session_start: time - 5000, tabs: 4, ...(webui_page === undefined ? {} : { webui_page }) };
    stub.shellNativeModules.ArdiaApp.crashReports = async () => [
      { time, fileTime: time, process: "browser", exceptionType: "EXC_BREAKPOINT", signal: "SIGTRAP", frames: [{ image: "Chromium Framework", offset: 0x41a36e8 }] },
    ];
    await reportNativeCrashes([saved]);
    const props = queued().at(-1).properties;
    assert.equal(props.crash_process, "browser");
    assert.equal(props.ctx_tabs, 4);
    assert.equal(props.ctx_webui_page, expected, String(webui_page));
    assert.equal(props.ctx_webui_pages, null, "a sample without the recent pages sends none");
  }
});

test("a native crash carries the last built-in pages from the saved context as page:minutes, never a page that isn't a built-in one", async () => {
  const time = Date.now() + 3 * 60 * 60_000;
  const saved = {
    at: time - 500,
    session_start: time - 5000,
    webui_page: "flags",
    webui_pages: `flags@${time - 2 * 60_000},downloads@${time - 17 * 60_000},settings/cookies@${time - 22 * 60_000}`,
  };
  stub.shellNativeModules.ArdiaApp.crashReports = async () => [
    { time, fileTime: time, process: "browser", exceptionType: "EXC_BAD_ACCESS", signal: "SIGSEGV", frames: [{ image: "Chromium Framework", offset: 0xee9858 }] },
  ];
  await reportNativeCrashes([saved]);
  assert.equal(queued().at(-1).properties.ctx_webui_pages, "flags:2,downloads:17,settings/cookies:22");

  const tampered = { ...saved, webui_pages: `flags@${time},https://private.example/a@${time},settings/cookies/detail@${time}` };
  stub.shellNativeModules.ArdiaApp.crashReports = async () => [
    { time: time + 1000, fileTime: time + 1000, process: "browser", exceptionType: "EXC_BAD_ACCESS", signal: "SIGSEGV", frames: [{ image: "Chromium Framework", offset: 0xee9858 }] },
  ];
  await reportNativeCrashes([{ ...tampered, at: time + 500, session_start: time - 5000 }]);
  const props = queued().at(-1).properties;
  assert.equal(props.ctx_webui_pages, "flags:0");
  assert.equal(JSON.stringify(queued().at(-1)).includes("private"), false);
});

test("a browser crash carries the kind of JS fatal that stopped it as crash_js_fatal, never the message, and no other crash does", async () => {
  const time = Date.now() + 3 * 60 * 60_000;
  const hermes = (process, jsFatal, at) => ({ time: at, fileTime: at, process, exceptionType: "EXC_CRASH", signal: "SIGABRT", jsFatal, jsFatalSource: "hermes", frames: [{ image: "hermes", offset: 0x19bea4 }] });
  const reactNative = (process, jsFatal, at) => ({ time: at, fileTime: at, process, exceptionType: "EXC_BREAKPOINT", signal: "SIGTRAP", exceptionName: "RCTFatalException", jsFatal, jsFatalSource: "reactNative", frames: [{ image: "Ardia", offset: 0x444da4 }] });
  const cases = [
    [hermes, "browser", "OOM: error_code(value = 1, category = vm_allocate_category, message = Max heap size was exceeded)", "hermes_heap_limit"],
    [hermes, "browser", "OOM at https://example.com/private?q=secret on /Users/someone/Library/page.json for me@example.com", "hermes_out_of_memory"],
    [hermes, "browser", "", null],
    [hermes, "browser", undefined, null],
    [hermes, "renderer", "OOM: error_code(value = 1, category = vm_allocate_category, message = Max heap size was exceeded)", null],
    [reactNative, "browser", "Exception in HostFunction: Unknown native module at https://example.com/private?q=secret", "rn_host_function"],
    [reactNative, "browser", "Unhandled JS Exception: TypeError: cannot read title of /Users/someone/page.json", "rn_js_type_error"],
  ];
  let n = 0;
  for (const [make, process, jsFatal, expected] of cases) {
    const at = time + 10_000 * ++n;
    const report = make(process, jsFatal, at);
    stub.shellNativeModules.ArdiaApp.crashReports = async () => [report];
    await reportNativeCrashes();
    const sent = queued().at(-1);
    const props = sent.properties;
    assert.equal(props.crash_process, process);
    if (report.exceptionName) assert.equal(props.objc_exception, report.exceptionName);
    assert.equal(props.crash_js_fatal, expected, `${process} ${String(jsFatal)}`);
    assert.equal("crash_js_reason" in props, false);
    const json = JSON.stringify(sent);
    for (const leak of ["example.com", "secret", "/Users", "someone", "page.json", "native module", "Max heap size", "cannot read"]) assert.equal(json.includes(leak), false, leak);
  }
});

const hermesRejectionStack = [
  "TypeError: Cannot read property 'password' of undefined",
  "    at anonymous (address at index.windows:1:3049129)",
  "    at tryCallOne (address at InternalBytecode.js:1:27609)",
  "    at anonymous (address at InternalBytecode.js:1:36971)",
].join("\n");

const rejection = (message = "Cannot read property 'password' of undefined") => {
  const error = new TypeError(message);
  error.stack = hermesRejectionStack.replace("Cannot read property 'password' of undefined", message);
  return error;
};

test("an unhandled rejection names the bundle build and the raw offset on its app frame, and nothing it quotes", () => {
  appInfo().appBuild = "5256";
  captureException(rejection(), "onunhandledrejection");
  const sent = queued().at(-1);
  const frames = sent.properties.$exception_list[0].stacktrace.frames;
  assert.equal(sent.properties.$exception_list[0].mechanism.type, "onunhandledrejection");
  assert.equal(sent.properties.$exception_list[0].value, "Cannot read property <text>");
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.filter((f) => f.in_app).map((f) => [f.filename, f.bundle_build, f.bundle_offset, f.colno]), [["index.windows", "5256", 3049129, 3049129]]);
  for (const frame of frames.filter((f) => !f.in_app)) {
    assert.equal("bundle_build" in frame, false);
    assert.equal("bundle_offset" in frame, false);
  }
  assert.equal(JSON.stringify(sent).includes("password"), false);
});

test("the bundle build and offset are only recorded for unhandled rejections", () => {
  appInfo().appBuild = "5256";
  captureException(rejection("Cannot read title of null"), "onerror");
  const frames = queued().at(-1).properties.$exception_list[0].stacktrace.frames;
  assert.equal(frames.some((f) => "bundle_build" in f || "bundle_offset" in f), false);
});

test("a build that isn't a plain identifier is sent as null, the offset still is", () => {
  for (const [n, build] of [["a", "5256 (nightly) alice@example.com"], ["b", ""], ["c", "x".repeat(33)]]) {
    appInfo().appBuild = build;
    captureException(rejection(`Cannot read property of ${n}`), "onunhandledrejection");
    const sent = queued().at(-1);
    const app = sent.properties.$exception_list[0].stacktrace.frames.find((f) => f.in_app);
    assert.equal(app.bundle_build, null);
    assert.equal(app.bundle_offset, 3049129);
    assert.equal(JSON.stringify(sent.properties.$exception_list).includes("alice"), false);
  }
});
