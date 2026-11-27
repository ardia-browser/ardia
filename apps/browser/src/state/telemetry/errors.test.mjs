import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.0", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false });
const { setSharing } = await import("./client.ts");
const { captureException, reportNativeCrashes } = await import("./errors.ts");

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

test("an error that wraps a cause, like React's recovered render error, sends the cause after it", () => {
  const before = queued().length;
  const cause = new TypeError("Cannot read properties of undefined (reading 'title')");
  const wrapper = new Error("Minified React error #520; visit https://react.dev/errors/520 for the full message", { cause });
  captureException(wrapper, "onerror");
  const looping = new Error("outer loop");
  looping.cause = looping;
  captureException(looping, "onerror");
  const events = queued();
  assert.equal(events.length, before + 2);
  const props = events.at(-2).properties;
  assert.deepEqual(props.$exception_types, ["Error", "TypeError"]);
  assert.equal(props.$exception_list[0].value.startsWith("Minified React error #520"), true);
  assert.equal(props.$exception_list[1].type, "TypeError");
  assert.equal(props.$exception_list[1].mechanism.type, "onerror");
  assert.deepEqual(events.at(-1).properties.$exception_types, ["Error"]);
});

test("a cause's message is scrubbed exactly as the error's own message is", () => {
  const raw = "Failed to load https://mail.example.com/u/0/inbox?id=42 for 'someone@example.com'";
  const cause = new Error(raw);
  captureException(new Error("outer wrapper", { cause }), "onerror");
  captureException(new RangeError(raw), "onerror");
  const events = queued();
  const asCause = events.at(-2).properties.$exception_list[1].value;
  const asError = events.at(-1).properties.$exception_list[0].value;
  assert.equal(asCause, asError);
  assert.equal(asCause.includes("mail.example.com") || asCause.includes("someone@example.com"), false);
});

test("only error objects are followed as causes, a cause that throws ends the chain, and chains that only join the same are different reports", () => {
  const before = queued().length;
  captureException(new Error("wrapper of text", { cause: "Unreleased acquisition plan" }), "onerror");
  const throwing = new Error("wrapper of a broken cause", { cause: Object.defineProperty(new Error("x"), "message", { get() { throw new Error("getter"); } }) });
  captureException(throwing, "onerror");
  const deep = new Error("d0", { cause: new Error("d1", { cause: new Error("d2", { cause: Object.defineProperty(new Error("d3"), "cause", { get() { throw new Error("getter"); } }) }) }) });
  captureException(deep, "onerror");
  captureException(new Error("same", { cause: new Error("one|TypeError|two") }), "onerror");
  captureException(new Error("same", { cause: new Error("one", { cause: new TypeError("two") }) }), "onerror");
  const events = queued().slice(before);
  assert.equal(events.length, 5);
  assert.deepEqual(events[0].properties.$exception_values, ["wrapper of text"]);
  assert.deepEqual(events[1].properties.$exception_values, ["wrapper of a broken cause"]);
  assert.deepEqual(events[2].properties.$exception_values, ["d0", "d1", "d2", "d3"]);
  assert.equal(events[4].properties.$exception_types.length, 3);
});

test("an error's own message never reaches its frames, even across lines or with no frames, and a plain object is not a cause", () => {
  const before = queued().length;
  const multi = new Error("Failed\n    at Quarterly budget draft (customer.example:2:4)");
  captureException(multi, "onerror");
  const bare = new Error("Failed for someone@customer.example");
  bare.stack = "Error: Failed for someone@customer.example";
  captureException(bare, "onerror");
  captureException(new Error("wrapper of a record", { cause: { name: "CustomerAlias", message: "Quarterly budget draft" } }), "onerror");
  const events = queued().slice(before);
  assert.equal(events.length, 3);
  const frames = JSON.stringify(events.map((e) => e.properties.$exception_list.map((x) => x.stacktrace.frames)));
  for (const secret of ["Quarterly", "customer.example", "someone"]) assert.equal(frames.includes(secret), false, secret);
  assert.deepEqual(events[2].properties.$exception_values, ["wrapper of a record"]);
});

test("frames never carry the message when the header has no name, the message changed after the stack, or a cause only claims to be an Error", () => {
  const before = queued().length;
  const nameless = new Error("Failed\n    at Quarterly budget draft (customer.example:2:4)");
  nameless.name = "";
  nameless.stack = `${nameless.message}\n    at choose (index.bundle:1:2)`;
  captureException(nameless, "onerror");
  const changed = new Error("Failed\n    at Quarterly budget draft (customer.example:2:4)");
  changed.message = "Changed later";
  captureException(changed, "onerror");
  const spoof = { message: "Quarterly budget draft", [Symbol.toStringTag]: "Error" };
  captureException(new Error("wrapper of a lookalike", { cause: spoof }), "onerror");
  const jsc = new Error("from Safari");
  jsc.stack = "choose@index.bundle:1:2\napply@[native code]";
  captureException(jsc, "onerror");
  const events = queued().slice(before);
  assert.equal(events.length, 4);
  const frames = JSON.stringify(events.map((e) => e.properties.$exception_list.map((x) => x.stacktrace.frames)));
  for (const secret of ["Quarterly", "customer.example"]) assert.equal(frames.includes(secret), false, secret);
  assert.deepEqual(events[0].properties.$exception_list[0].stacktrace.frames.map((f) => f.function), ["choose"]);
  assert.deepEqual(events[2].properties.$exception_values, ["wrapper of a lookalike"]);
  assert.deepEqual(events[3].properties.$exception_list[0].stacktrace.frames.map((f) => f.function), ["choose"]);
});

test("a frame made of message text never goes out, even when the message was shortened after the stack was taken", () => {
  const before = queued().length;
  const shortened = new Error("Failed to save the draft\n    at Quarterly budget draft (customer.example:2:4)\n    at Another line of notes (notes.js:1:1)\n    at PrivateDraft (sensitive-project.js:2:4)\n    at PrivateDraft (Private Project.js:2:4)\n    at PrivateDraft (sensitive-project.bundle:2:4)\n    at PrivateReport (https://example.com/index.bundle/PrivateReport.js:2:4)\n    at PrivateReport (http://localhost:8081/index.bundle/PrivateReport.js:2:4)\n    at PrivateReport (https://example.com/index.bundle:2:4)");
  void shortened.stack;
  shortened.message = "Failed to save the draft";
  captureException(shortened, "onerror");
  const events = queued().slice(before);
  const frames = events[0].properties.$exception_list[0].stacktrace.frames;
  const json = JSON.stringify(frames);
  for (const secret of ["Quarterly", "customer.example", "Another line", "notes.js", "PrivateDraft", "sensitive-project", "PrivateReport"]) assert.equal(json.includes(secret), false, secret);
});

test("frames from Ardia's own code on each platform are sent, and nothing else", () => {
  const before = queued().length;
  const error = new Error("Platform frames");
  error.stack = [
    "Error: Platform frames",
    "    at choose (http://localhost:8081/index.bundle//&platform=macos&dev=true&minify=false:123:45)",
    "    at release (address at /Applications/Ardia.app/Contents/Resources/main.jsbundle:1:9876)",
    "    at windows (index.windows.bundle:2:3)",
    "    at linux (chrome://ardia/assets/index-AbC123xy.js:4:5)",
    "    at bytecode (InternalBytecode.js:6:7)",
    "    at apply (native)",
    "    at PrivateDraft (sensitive-project.bundle:2:4)",
    "    at PrivateDraft (Private Project.js:2:4)",
    "    at PrivateDraft (https://example.com/app.js:2:4)",
    "    at PrivateDraft (/Users/someone/sensitive-project/index.windows:2:4)",
    "    at PrivateDraft (https://example.com/index.windows:2:4)",
  ].join("\n");
  captureException(error, "onerror");
  const frames = queued().slice(before)[0].properties.$exception_list[0].stacktrace.frames;
  assert.deepEqual(frames.map((f) => f.function).reverse(), ["choose", "release", "windows", "linux", "bytecode", "apply"]);
});

test("an unhandled rejection on Windows keeps its bytecode frame, whose source is named index.windows", () => {
  const before = queued().length;
  const error = new TypeError("Cannot read property 'ok' of undefined");
  error.stack = [
    "TypeError: Cannot read property 'ok' of undefined",
    "    at anonymous (address at index.windows:1:3049129)",
    "    at tryCallOne (address at InternalBytecode.js:1:27609)",
    "    at anonymous (address at InternalBytecode.js:1:36971)",
  ].join("\n");
  captureException(error, "onunhandledrejection");
  const frames = queued().slice(before)[0].properties.$exception_list[0].stacktrace.frames;
  assert.deepEqual(
    frames.map((f) => [f.filename, f.colno, f.in_app]),
    [
      ["InternalBytecode.js", 36971, false],
      ["InternalBytecode.js", 27609, false],
      ["index.windows", 3049129, true],
    ],
  );
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

test("a Mac crash sends how macOS ended the process, its exception codes and the crashed thread and queue", async () => {
  stub.shellNativeModules.ArdiaApp.crashReports = async () => [
    {
      time: Date.now(),
      fileTime: Date.now(),
      process: "renderer",
      engineVersion: "158.0.8127.36",
      exceptionType: "EXC_BREAKPOINT",
      signal: "SIGTRAP",
      terminationNamespace: "SIGNAL",
      terminationIndicator: "Trace/BPT trap: 5",
      terminationCode: 5,
      exceptionCodes: "0x0000000000000001, 0x00000001a055d604",
      crashedThread: "CrRendererMain",
      crashedQueue: "com.apple.main-thread",
      frames: [{ image: "Chromium Framework", offset: 0x8a0b1c4 }],
    },
  ];
  await reportNativeCrashes();
  const props = queued().at(-1).properties;
  assert.equal(props.crash_termination, "SIGNAL");
  assert.equal(props.crash_termination_indicator, "trace_trap");
  assert.equal(props.crash_termination_code, 5);
  assert.equal(props.crash_exception_code, 1);
  assert.equal(props.crash_fault_near_null, null);
  assert.equal(props.crash_thread, "chrome_main");
  assert.equal(props.crash_queue, "main");
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
