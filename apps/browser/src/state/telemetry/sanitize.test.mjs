import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanProperties, errorCode, errorMessage, errorType, JS_FATAL_KINDS, jsFatalKind, nativeCrashExceptions, nativeFrames, parseStack, scrubText } from "./sanitize.ts";
import { customColorProfiles, narrowWindows, settingsSnapshot, themeFileSnapshot } from "./settingsSnapshot.ts";
const { DEFAULT_SETTINGS, SETTING_SPECS } = await import("../settings/settings.ts");

const leaks = (text, ...secrets) => secrets.filter((s) => text.includes(s));

test("web addresses, hosts and app URLs are stripped", () => {
  const out = scrubText(
    "Failed to load https://mail.example.com/inbox?q=secret#frag, then ardia://settings/passwords and chrome://version from bank.co.uk:8443",
  );
  assert.deepEqual(leaks(out, "example", "inbox", "secret", "passwords", "settings", "version", "bank"), []);
  assert.match(out, /^Failed to load <url> then <url> and <url> from <host>$/);
  assert.equal(scrubText("blob:https://x.test/abc data:text/html,<h1>hi</h1> about:blank"), "<url> <url> <url>");
  assert.equal(scrubText("visit www.secret-site.io now"), "visit <host> now");
  assert.equal(scrubText("dev server at localhost:8081 and 192.168.1.20:3000"), "dev server at <host> and <ip>");
});

test("file paths and file names are stripped, with the user's name", () => {
  const out = scrubText("Couldn't read /Users/alice/Library/Application Support/Ardia/history.json");
  assert.deepEqual(leaks(out, "alice", "Library", "Ardia", "history"), []);
  assert.ok(out.startsWith("Couldn't read <path>"));
  assert.equal(scrubText("Couldn't save live-folders-work.json"), "Couldn't save <file>");
  assert.equal(scrubText("open ~/Documents/Taxes 2025.pdf failed"), "open <path> <file> failed");
  assert.equal(scrubText("see ./relative/dir/file and C/D"), "see <path> and <path>");
  assert.deepEqual(leaks(scrubText("file:///Users/bob/Desktop/plan.docx"), "bob", "plan"), []);
});

test("quoted text, emails, ids and long numbers are stripped", () => {
  assert.equal(scrubText(`Profile "Bob's Work" not found`), "Profile <text>");
  assert.equal(scrubText("Cannot read property 'password' of undefined"), "Cannot read property <text>");
  assert.equal(scrubText("mail alice.smith+x@corp.example.org"), "mail <email>");
  assert.equal(scrubText("tab 3f2c1a9e-1b2c-4d5e-8f90-123456789abc gone"), "tab <id> gone");
  assert.equal(scrubText("card 4111111111111111 declined"), "card <n> declined");
  assert.equal(scrubText("Couldn't save the sync state; can't retry"), "Couldn't save the sync state; can't retry");
});

test("Hermes stacks keep function and bundle names, not the dev host, query or directories", () => {
  const stack = [
    "TypeError: boom",
    "    at choose (http://localhost:8081/index.bundle//&platform=macos&dev=true&minify=false:123:45)",
    "    at anonymous (address at /Users/alice/Library/Developer/Xcode/DerivedData/main.jsbundle:1:9876)",
    "    at apply (native)",
    "    at ?anon_0_ (index.bundle:1:2)",
  ].join("\n");
  const frames = parseStack(stack);
  const json = JSON.stringify(frames);
  assert.deepEqual(leaks(json, "localhost", "8081", "platform=macos", "alice", "DerivedData", "Users"), []);
  assert.equal(frames.at(-1).function, "choose");
  assert.equal(frames.at(-1).filename, "index.bundle");
  assert.equal(frames.at(-1).lineno, 123);
  assert.equal(frames.at(-1).colno, 45);
  assert.equal(frames.at(-2).filename, "main.jsbundle");
  assert.equal(frames.at(-3).filename, "native");
  assert.equal(frames.at(-3).in_app, false);
  for (const f of frames) assert.equal(f.platform, "custom");
});

test("a Hermes or V8 stack's header line, the error's own message, is never read as a frame", () => {
  const stack = ["Error: Failed for someone@customer.example", "    at choose (index.bundle:1:2)"].join("\n");
  const frames = parseStack(stack);
  assert.deepEqual(frames.map((f) => f.function), ["choose"]);
  assert.deepEqual(leaks(JSON.stringify(frames), "someone", "customer.example"), []);
  const jsc = parseStack(["choose@index.bundle:1:2", "apply@[native code]"].join("\n"));
  assert.deepEqual(jsc.map((f) => f.function), ["apply", "choose"]);
});

test("event properties are flat, plain and scrubbed", () => {
  const out = cleanProperties({
    kind: "history",
    count: 3,
    ok: true,
    none: null,
    nan: NaN,
    url: "https://secret.test/path",
    nested: { url: "https://x.test" },
    list: ["a"],
    "bad key": 1,
  });
  assert.deepEqual(out, { kind: "history", count: 3, ok: true, none: null, url: "<url>" });
});

test("the built-in page keeps its slash in the crash context, and still can't carry a path, address or id", () => {
  assert.deepEqual(cleanProperties({ ctx_webui_page: "settings/cookies", prev_webui_page: "history", webui_page: null }), {
    ctx_webui_page: "settings/cookies",
    prev_webui_page: "history",
    webui_page: null,
  });
  for (const bad of ["settings/https://private.example/a", "me@example.com/0123456789abcdef0123", "a/b/c/d/Users/someone/x.json", "/Users/someone/x.json"]) {
    const page = cleanProperties({ ctx_webui_page: bad }).ctx_webui_page;
    assert.match(page, /^<[a-z]+>(?:\/?<[a-z]+>)*$/, bad);
    assert.deepEqual(leaks(page, "private", "someone", "example.com"), [], bad);
  }
  assert.equal(cleanProperties({ other_page: "settings/cookies" }).other_page, "<path>", "only the built-in page field is exempt from the path scrub");
});

test("a saved context keeps the built-in page only as a host and first path segment", async () => {
  const { readContext } = await import("./savedContext.ts");
  assert.equal(readContext({ at: 1, tabs: 3, webui_page: "settings/cookies" }).webui_page, "settings/cookies");
  assert.equal(readContext({ at: 1, webui_page: null }).webui_page, null);
  assert.equal("webui_page" in readContext({ at: 1, tabs: 3 }), false, "a sample saved before the field existed stays without it");
  for (const bad of ["https://private.example/inbox?token=secret", "settings/cookies/detail", "Users/someone/x", "a b", 7, {}]) {
    assert.equal(readContext({ at: 1, webui_page: bad }).webui_page, null, String(bad));
  }
});

test("the last built-in pages survive the property cleaner as page:minutes, and a value that is anything else is scrubbed", () => {
  const kept = "flags:8,downloads:15,settings/cookies:25";
  assert.deepEqual(cleanProperties({ ctx_webui_pages: kept, webui_pages: null }), { ctx_webui_pages: kept, webui_pages: null });
  for (const bad of [
    "settings/https://private.example/a:5",
    "me@example.com:5",
    "flags:8,downloads:15,settings/cookies:25,history:30",
    "/Users/someone/x.json:1",
  ]) {
    const value = cleanProperties({ ctx_webui_pages: bad }).ctx_webui_pages;
    assert.notEqual(value, bad, bad);
    assert.deepEqual(leaks(value, "private", "someone", "example.com"), [], bad);
  }
});

test("a saved context keeps at most the last 3 built-in pages with their time, and drops anything else", async () => {
  const { readContext } = await import("./savedContext.ts");
  assert.equal(readContext({ at: 1, webui_pages: "flags@3000,downloads@2000,settings/cookies@1000" }).webui_pages, "flags@3000,downloads@2000,settings/cookies@1000");
  assert.equal(readContext({ at: 1, webui_pages: "flags@3000,downloads@2000,settings/cookies@1000,history@1" }).webui_pages, "flags@3000,downloads@2000,settings/cookies@1000");
  assert.equal(readContext({ at: 1, webui_pages: "flags@3000,https://private.example/a@2,settings/cookies/detail@5,me@example.com@7,downloads@x" }).webui_pages, "flags@3000");
  assert.equal(readContext({ at: 1, webui_pages: null }).webui_pages, null);
  assert.equal("webui_pages" in readContext({ at: 1, tabs: 3 }), false, "a sample saved before the field existed stays without it");
  for (const bad of ["", "private", 7, {}, ["flags@1"]]) {
    assert.equal(readContext({ at: 1, webui_pages: bad }).webui_pages, null, String(bad));
  }
});

test("an uncaught NSException sends its name and its throw site first, never its reason", () => {
  const { name, signal, exceptions } = nativeCrashExceptions({
    exceptionType: "EXC_BREAKPOINT",
    signal: "SIGTRAP",
    exceptionName: "NSRangeException",
    exceptionReason:
      "*** -[TabStrip select:]: index 3 beyond bounds for https://private.example/a?q=1 in /Users/someone/Library/x.json by me@example.com, id 0123456789abcdef0123\nsecond line",
    frames: [{ image: "AppKit", symbol: "+[NSApplication _crashOnException:]", offset: 0x3d5e74 }, { image: "Ardia", symbol: "main", offset: 0x4a10, symbolOffset: 8 }],
    exceptionFrames: [
      { image: "CoreFoundation", symbol: "__exceptionPreprocess", offset: 0x1007b0 },
      { image: "libobjc.A.dylib", symbol: "objc_exception_throw", offset: 0x165c },
      { image: "ArdiaShell", symbol: "TabStrip.select(_:)", offset: 0x2010, symbolOffset: 40 },
    ],
  });
  assert.equal(name, "NSRangeException");
  assert.equal(signal, "SIGTRAP");
  assert.deepEqual(exceptions.map((e) => [e.type, e.value]), [
    ["NSRangeException", "Uncaught NSRangeException"],
    ["EXC_BREAKPOINT", "EXC_BREAKPOINT (SIGTRAP)"],
  ]);
  assert.equal(exceptions[0].frames.at(-1).function, "__exceptionPreprocess");
  assert.equal(exceptions[0].frames[0].function, "TabStrip.select(_:)");
  assert.equal(exceptions[0].frames[0].image_offset, "0x2010");
  assert.equal(exceptions[0].frames[0].in_app, true);
  assert.equal(exceptions[1].frames.at(-1).function, "+[NSApplication _crashOnException:]");
  assert.equal(exceptions[1].frames.at(-1).image_offset, "0x3d5e74");
});

test("an exception without a name or reason still says what it was", () => {
  const { name, subtype, exceptions } = nativeCrashExceptions({
    exceptionType: "EXC_BAD_ACCESS",
    signal: "SIGBUS",
    exceptionSubtype: "EXC_ARM_DA_ALIGN",
    frames: [{ image: "libsystem_platform.dylib", symbol: "_platform_memmove", offset: 0x1100 }],
    exceptionFrames: [{ image: "libobjc.A.dylib", symbol: "objc_exception_throw", offset: 0x165c }],
  });
  assert.equal(name, null);
  assert.equal(subtype, "EXC_ARM_DA_ALIGN");
  assert.equal(nativeCrashExceptions({ frames: [], exceptionSubtype: "at 0x4f776f646168732f" }).subtype, null);
  assert.deepEqual(exceptions.map((e) => [e.type, e.value]), [
    ["NSException", "Uncaught NSException"],
    ["EXC_BAD_ACCESS", "EXC_BAD_ACCESS (SIGBUS)"],
  ]);
});

test("native frames keep their image offset and drop a stripped image's nearest export", () => {
  const frames = nativeFrames([
    { image: "Chromium Framework", symbol: "ArdiaCoreMain", symbolOffset: 66417332, offset: 0x41a36e8 },
    { image: "Chromium Framework", symbol: "ac_engine_set_event_sink", offset: 0x2139600 },
    { image: "Chromium Framework", symbol: "ArdiaCoreMain", symbolOffset: 760, offset: 0x442c72c },
    { image: "Chromium Framework", offset: 0x2ef170 },
    { image: "Ardia", offset: 0x3fd9f0 },
    { image: "CoreAutoLayout", symbol: "_NSBitSetResize", symbolOffset: 120000, offset: 0x9a10 },
    { image: "/Users/someone/Ardia.app/Contents/MacOS/Ardia", symbol: "-[X open:/Users/someone/a]", symbolOffset: 4, offset: 16 },
  ]).reverse();
  assert.deepEqual(
    frames.map((f) => [f.function, f.image_offset, f.resolved]),
    [
      ["Chromium Framework + 0x41a36e8", "0x41a36e8", false],
      ["Chromium Framework + 0x2139600", "0x2139600", false],
      ["ArdiaCoreMain", "0x442c72c", true],
      ["Chromium Framework + 0x2ef170", "0x2ef170", false],
      ["Ardia + 0x3fd9f0", "0x3fd9f0", false],
      ["_NSBitSetResize", "0x9a10", true],
      ["-[X <path>", "0x10", true],
    ],
  );
  assert.equal(frames[6].module, "Ardia");
  assert.deepEqual(frames.map((f) => f.in_app), [true, true, true, true, true, false, true]);
});

test("crash reports name only the app's own images, by UUID", () => {
  const { images } = nativeCrashExceptions({
    frames: [],
    images: [
      { name: "Ardia", uuid: "1C77EF99-77D4-3DE8-9BA2-6929E276BC60" },
      { name: "Chromium Framework", uuid: "4c4c4479-5555-3144-a199-a2cbd9a6d85f" },
      { name: "AppKit", uuid: "77e3adb8-e4e8-3912-8599-d43182877c10" },
      { name: "Ardia", uuid: "not a uuid" },
      { name: "/Users/someone/evil", uuid: "4c4c4479-5555-3144-a199-a2cbd9a6d85f" },
    ],
  });
  assert.deepEqual(images, [
    { name: "Ardia", uuid: "1c77ef99-77d4-3de8-9ba2-6929e276bc60" },
    { name: "Chromium Framework", uuid: "4c4c4479-5555-3144-a199-a2cbd9a6d85f" },
  ]);
});

test("a quoted span cut off by a length limit is still redacted, through the end of the line", () => {
  const cut = `Unhandled JS Exception: "private patient history ${"x".repeat(700)}`;
  assert.equal(scrubText(cut, 300), "Unhandled JS Exception: <text>");
  assert.equal(scrubText("refused 'secret project plans"), "refused <text>");
  assert.equal(scrubText("it's the user's tab"), "it's the user's tab");
});

test("a named exception without a thrown backtrace still sends its name, not its reason", () => {
  const { exceptions } = nativeCrashExceptions({
    exceptionType: "EXC_CRASH",
    signal: "SIGABRT",
    exceptionName: "NSInternalInconsistencyException",
    exceptionReason: "window not ready",
    frames: [{ image: "AppKit", symbol: "-[NSWindow display]", offset: 0x10 }],
    exceptionFrames: [],
  });
  assert.deepEqual(exceptions.map((e) => [e.type, e.value, e.frames.length]), [
    ["NSInternalInconsistencyException", "Uncaught NSInternalInconsistencyException", 0],
    ["EXC_CRASH", "EXC_CRASH (SIGABRT)", 1],
  ]);
});

test("an unclosed quote holding an apostrophe is redacted; an apostrophe inside a word isn't a closing quote", () => {
  assert.equal(scrubText("refused 'patient's private medical history\ncontinued"), "refused <text>");
  assert.equal(scrubText("x ‘Ana’s private notes"), "x <text>");
  assert.equal(scrubText("'patient's file' was locked"), "<text>");
  assert.equal(scrubText("x ‘Ana’s notes’ y"), "x <text>");
  assert.equal(scrubText("Don't 'quote' the user's tab"), "Don't <text>");
});

test("an apostrophe between non-Latin letters never closes a quote, so the rest of the line is redacted", () => {
  assert.equal(scrubText("refused ‘ім’я пацієнта та медична історія"), "refused <text>");
  assert.equal(scrubText("refused ‘του’ασθενούς ιστορικό"), "refused <text>");
  assert.equal(scrubText("refused ‘患’者の病歴"), "refused <text>");
  assert.equal(scrubText("refused 'ім'я пацієнта"), "refused <text>");
  assert.equal(scrubText("refused \"患\"者の病歴"), "refused <text>");
  assert.equal(scrubText("x ‘Ana’s notes’ y"), "x <text>");
});

test("everything from the first quote to the end of the line is redacted, whatever the quotes", () => {
  assert.equal(scrubText('refused "ok"—‘patient" private medical history'), "refused <text>");
  assert.equal(scrubText("it's the user's tab, don't “mix” them"), "it's the user's tab, don't <text>");
  assert.equal(scrubText("closing ” first, then private"), "closing <text>");
  assert.equal(scrubText("(’patient’s history"), "(<text>");
});

test("scrubbing a long reason full of quotes takes linear time", () => {
  const reason = '"a'.repeat(32768);
  const started = performance.now();
  assert.equal(scrubText(reason, 300), "<text>");
  assert.equal(scrubText(`x ${"'a".repeat(32768)}`, 300), "x <text>");
  assert.ok(performance.now() - started < 500, `${performance.now() - started} ms`);
});

test("a reason cut to length drops its last, partial word instead of leaking half of it", () => {
  const out = scrubText(`${"word ".repeat(59)}patient.name@private-clinic.example.org trailing`, 300);
  assert.ok(!/patient|private|@/.test(out), out);
  assert.ok(out.endsWith("word…"), out);
});

test("on/off, pick-one and number settings are measured with their defaults; text and lists never are", () => {
  const snap = settingsSnapshot({ ...DEFAULT_SETTINGS, glassTintWithTheme: true, glassTintAmount: 0.55, interfaceStyle: "classic", customSearchUrl: "https://secret.example/?q=%s" });
  assert.equal(snap.setting_glassTintWithTheme, "true");
  assert.equal(snap.default_glassTintWithTheme, "false");
  assert.equal(snap.setting_glassTintAmount, "0.55");
  assert.equal(snap.default_glassTintAmount, "0.8");
  assert.equal(snap.setting_interfaceStyle, "classic");
  assert.equal(snap.default_interfaceStyle, "glass");
  for (const key of ["customSearchUrl", "searchEngine", "defaultProfileId", "customSearchEngines", "extensionSearchEngines"]) {
    assert.equal(snap[`setting_${key}`], undefined, key);
    assert.equal(snap[`default_${key}`], undefined, key);
  }
  assert.ok(!Object.values(snap).some((v) => v.includes("secret")));
});

test("every measured key survives the telemetry property cleaner unchanged", () => {
  const snap = settingsSnapshot(DEFAULT_SETTINGS);
  assert.deepEqual(cleanProperties(snap), snap);
  const measured = Object.keys(snap).filter((k) => k.startsWith("setting_")).length;
  assert.ok(measured > 30, `only ${measured} settings measured`);
  assert.ok(measured < Object.keys(SETTING_SPECS).length);
});

test("the settings snapshot reports borderless mode and its default without changing the saved frame", () => {
  const snap = settingsSnapshot({ ...DEFAULT_SETTINGS, borderlessMode: true, pageFrame: 6 });
  assert.equal(snap.setting_borderlessMode, "true");
  assert.equal(snap.default_borderlessMode, "false");
  assert.equal(snap.setting_pageFrame, "6");
  assert.equal(snap.default_pageFrame, "9");
  assert.equal(snap.window_corner_radius, "19");
  assert.deepEqual(cleanProperties(snap), snap);
});

test("the snapshot says how many profiles have a custom colour, never which", () => {
  const theme = { stops: [{ x: 0, y: 0, color: { r: 0.88, g: 0.88, b: 0.88, a: 1 } }], intensity: 1, mode: "dark" };
  const counted = customColorProfiles({ a: { name: "Work", theme }, b: { name: "Home" }, c: { name: "Play", theme: null } });
  assert.deepEqual(counted, { custom_color_profiles: "1", edited_presets: "0" }, "a shown look that isn't this Mac's own isn't counted as edited");
  const withDefault = customColorProfiles({ a: { name: "Work", color: "blue", theme, presetThemes: { plum: theme } } }, "a");
  assert.deepEqual(withDefault, { custom_color_profiles: "1", edited_presets: "1", default_profile_color_edited: "true" }, "whether the default profile's colour is edited, never which colour");
  assert.deepEqual(cleanProperties(counted), counted);
});

test("the snapshot counts browser windows narrower than the old 720 point minimum and those that narrow the sidebar, never their size", () => {
  const frame = (width) => [10, 20, width, 600];
  const counted = narrowWindows({
    a: { kind: "main", frame: frame(500) },
    b: { kind: "private", frame: frame(719) },
    c: { kind: "main", frame: frame(720) },
    d: { kind: "small", frame: frame(400) },
    e: { kind: "main", frame: null },
    f: { kind: "main", frame: frame(600), fullScreen: 1700000000000 },
    g: { kind: "main", frame: frame(640) },
  }, 400);
  assert.deepEqual(counted, { narrow_windows: "3", sidebar_narrowed_windows: "2" });
  assert.deepEqual(cleanProperties(counted), counted);
  assert.deepEqual(narrowWindows({ a: { kind: "main", frame: frame(500) } }, 190), { narrow_windows: "1", sidebar_narrowed_windows: "0" });
});

test("a value the spec doesn't allow is left out rather than sent", () => {
  const snap = settingsSnapshot({ ...DEFAULT_SETTINGS, interfaceStyle: "https://not-an-option.example" });
  assert.equal(snap.setting_interfaceStyle, undefined);
});

test("a native exception's free-text reason never leaves, whatever it holds", () => {
  const secret = "Customer Alice private quarterly forecast";
  for (const report of [
    { frames: [], exceptionName: "NSInvalidArgumentException", exceptionReason: secret },
    { frames: [], exceptionReason: secret },
    { frames: [], exceptionFrames: [{ image: "Ardia", offset: 1 }], exceptionReason: secret },
  ]) {
    const out = nativeCrashExceptions(report);
    assert.equal(JSON.stringify(out).includes("Alice"), false, JSON.stringify(out));
    assert.equal("reason" in out, false);
  }
});

test("the theme file snapshot is flags and counts only, and survives sanitizing", () => {
  assert.deepEqual(themeFileSnapshot(null, null), {
    theme_file: "false", theme_type: "false", theme_metrics: "false", theme_layout: "false", theme_icons: "false",
    theme_hidden_parts: "0", theme_moved_parts: "0", theme_icon_overrides: "0",
  });
  const snap = themeFileSnapshot("nord", { type: { family: "Avenir Next" }, layout: { hide: ["pinned", "profile"], addressField: "bottom" }, icons: { plus: "plus.circle" } });
  assert.deepEqual(snap, {
    theme_file: "true", theme_type: "true", theme_metrics: "false", theme_layout: "true", theme_icons: "true",
    theme_hidden_parts: "2", theme_moved_parts: "1", theme_icon_overrides: "1",
  });
  assert.equal(JSON.stringify(snap).includes("nord") || JSON.stringify(snap).includes("Avenir"), false);
  assert.deepEqual(cleanProperties(snap), snap);
});

test("jsFatalKind sends only a kind from a fixed list, never the message, and null when there's nothing", () => {
  const cases = [
    ["hermes", "OOM: error_code(value = 1, category = vm_allocate_category, message = Max heap size was exceeded)", "hermes_heap_limit"],
    ["hermes", "OOM: error_code(value = 12, category = generic, message = Cannot allocate memory)", "hermes_out_of_memory"],
    ["hermes", "Native stack overflow in Hermes", "hermes_stack_overflow"],
    ["hermes", "failed at https://example.com/a?token=abc and ~/Library/x/y.json", "hermes_other"],
    ["reactNative", "Unhandled JS Exception: TypeError: undefined is not a function", "rn_js_type_error"],
    ["reactNative", "Unhandled JS Exception: ReferenceError: x is not defined", "rn_js_reference_error"],
    ["reactNative", "Unhandled JS Exception: RangeError: Maximum call stack size exceeded", "rn_js_stack_overflow"],
    ["reactNative", "Unhandled JS Exception: RangeError: Invalid array length", "rn_js_range_error"],
    ["reactNative", "Unhandled JS Exception: SyntaxError: bad JSON", "rn_js_syntax_error"],
    ["reactNative", "Unhandled JS Exception: something thrown at https://example.com", "rn_js_error"],
    ["reactNative", "Exception in HostFunction: Unknown native module at https://example.com/x?token=secret", "rn_host_function"],
    ["reactNative", "Exception in HostObject::get for prop 'x'", "rn_host_object"],
    ["reactNative", "non-std ObjC Exception", "rn_objc_exception"],
    ["reactNative", "non-std C++ exception", "rn_cpp_exception"],
    ["reactNative", "vector::_M_range_check: __n (which is 7)", "rn_other"],
    [undefined, "anything", "unknown"],
  ];
  for (const [source, text, kind] of cases) {
    assert.equal(jsFatalKind(source, text), kind, text);
    assert.ok(JS_FATAL_KINDS.includes(kind), kind);
  }
  for (const empty of ["", "   ", undefined, null, 7, {}, ["x"]]) assert.equal(jsFatalKind("hermes", empty), null, String(empty));
});

test("the snapshot reports the interface size in whole percent with its default, and counts narrow windows in root points", async () => {
  const { useInterfaceScale } = await import("../settings/interfaceScale.ts");
  useInterfaceScale.setState({ scale: 1.25 });
  try {
    const snap = settingsSnapshot(DEFAULT_SETTINGS);
    assert.equal(snap.setting_interfaceScale, "125");
    assert.equal(snap.default_interfaceScale, "100");
    assert.deepEqual(cleanProperties(snap), snap);
    const wide = { kind: "main", frame: [0, 0, 800, 700] };
    assert.deepEqual(narrowWindows({ a: wide }, 190), { narrow_windows: "1", sidebar_narrowed_windows: "0" }, "800 window points are 640 root points at 125%");
    assert.deepEqual(narrowWindows({ a: wide }, 400), { narrow_windows: "1", sidebar_narrowed_windows: "1" });
  } finally {
    useInterfaceScale.setState({ scale: 1 });
  }
  assert.equal(settingsSnapshot(DEFAULT_SETTINGS).setting_interfaceScale, "100");
});
