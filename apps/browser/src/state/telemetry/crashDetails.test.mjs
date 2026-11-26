import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeCrashDetails } from "./crashDetails.ts";

test("a crash report's termination, exception code and crashed thread are sent as fixed kinds", () => {
  assert.deepEqual(
    nativeCrashDetails({
      exceptionType: "EXC_BREAKPOINT",
      terminationIndicator: "Trace/BPT trap: 5",
      terminationCode: 5,
      exceptionCodes: "0x0000000000000001, 0x00000001A532E4A4",
      crashedThread: "ThreadPoolForegroundWorker",
      crashedQueue: "com.apple.main-thread",
    }),
    {
      crash_termination_indicator: "trace_trap",
      crash_termination_code: 5,
      crash_exception_code: 1,
      crash_fault_near_null: null,
      crash_thread: "thread_pool",
      crash_queue: "main",
    },
  );
  assert.deepEqual(nativeCrashDetails({}), {
    crash_termination_indicator: null,
    crash_termination_code: null,
    crash_exception_code: null,
    crash_fault_near_null: null,
    crash_thread: null,
    crash_queue: null,
  });
  for (const [thread, kind] of [
    ["CrRendererMain", "chrome_main"],
    ["CrBrowserMain", "chrome_main"],
    ["Chrome_ChildIOThread", "io"],
    ["VizCompositorThread", "compositor"],
    ["DedicatedWorker thread", "web_worker"],
    ["com.facebook.react.JavaScript", "react_js"],
    ["com.apple.NSEventThread", "appkit_events"],
  ]) {
    assert.equal(nativeCrashDetails({ crashedThread: thread }).crash_thread, kind, thread);
  }
  assert.equal(nativeCrashDetails({ terminationIndicator: "Segmentation fault: 11" }).crash_termination_indicator, "segmentation_fault");
  assert.equal(nativeCrashDetails({ terminationIndicator: "Namespace DYLD, Code 1 Library missing" }).crash_termination_indicator, "other");
});

test("a bad memory access says only whether it was near address zero, never the address", () => {
  const nearNull = nativeCrashDetails({ exceptionType: "EXC_BAD_ACCESS", exceptionCodes: "0x0000000000000001, 0x0000000000000290" });
  assert.equal(nearNull.crash_exception_code, 1);
  assert.equal(nearNull.crash_fault_near_null, true);
  assert.equal(nativeCrashDetails({ exceptionType: "EXC_BAD_ACCESS", exceptionCodes: "0x0000000000000002, 0x0000000132a8c000" }).crash_fault_near_null, false);
  for (const [codes, expected] of [
    ["0x0000000000000001, 0x0000000000000290, 0x0000000100000000", true],
    ["0x0000000000000001, 0x0000000000000290, 0x0000000100000000, 0x0000000000000005", true],
    ["0x0000000000000001, 0x0000000132a8c000, 0x0000000000000010", false],
    ["0x0000000000000001, 0x0000000132a8c000, 0x0000000000000010, 0x0000000000000020", false],
  ]) {
    const details = nativeCrashDetails({ exceptionType: "EXC_BAD_ACCESS", exceptionCodes: codes });
    assert.equal(details.crash_fault_near_null, expected, `the second code decides, whatever follows: ${codes}`);
    assert.equal(details.crash_exception_code, 1, codes);
  }
  assert.ok(!Object.values(nearNull).some((value) => typeof value === "string" && /290/.test(value)));
});

test("names a person or a site could have chosen never leave as text", () => {
  const hostile = nativeCrashDetails({
    exceptionType: "EXC_BAD_ACCESS",
    terminationIndicator: "namespace DYLD missing private internal",
    terminationCode: -1,
    exceptionCodes: "0x1, me@example.com",
    crashedThread: "Alice Example",
    crashedQueue: "internal-project",
  });
  assert.deepEqual(hostile, {
    crash_termination_indicator: "other",
    crash_termination_code: null,
    crash_exception_code: null,
    crash_fault_near_null: null,
    crash_thread: "other",
    crash_queue: "other",
  });
  for (const inherited of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(nativeCrashDetails({ terminationIndicator: inherited }).crash_termination_indicator, "other", inherited);
  }
  assert.equal(nativeCrashDetails({ terminationCode: 2 ** 40 }).crash_termination_code, null);
  assert.equal(nativeCrashDetails({ terminationCode: 1.5 }).crash_termination_code, null);
  assert.equal(nativeCrashDetails({ exceptionCodes: "0x1, 0x2, 0x3, 0x4, 0x5" }).crash_exception_code, null);
  assert.equal(nativeCrashDetails({ exceptionCodes: "0xffffffffffffffff" }).crash_exception_code, null);
});
