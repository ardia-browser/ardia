import assert from "node:assert/strict";
import test from "node:test";
import { resolveHostModule } from "./hostModules.ts";
import { CRASH_DUMPS, hostCrashReport, isWindowsDump, linuxCrashReport, servesCrashDumps, windowsCrashReport } from "./hostCrashReports.ts";
import { parseMinidump } from "./minidump.ts";

const CHROME_BASE = 0x5555_0000_0000n;
const CHROME_SIZE = 0x1000_0000;
const LIBC_BASE = 0x7f00_0000_0000n;
const LIBC_SIZE = 0x20_0000;
const STACK = 0x7ffc_0000_0000n;
const CHROME_ID = "c1b96add39548a6390cf940731feb816940d279b";
const LIBC_ID = "f1e2d3c4b5a6978877665544332211000ffeeddc";

class Blob {
  constructor() {
    this.chunks = [];
    this.size = 0;
  }
  put(bytes) {
    const rva = this.size;
    this.chunks.push(bytes);
    this.size += bytes.length;
    const pad = (4 - (this.size % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.size += pad;
    }
    return rva;
  }
  bytes() {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

const struct = (size, fill) => {
  const bytes = new Uint8Array(size);
  fill(new DataView(bytes.buffer));
  return bytes;
};
const utf8 = (blob, text) => {
  const encoded = new TextEncoder().encode(text);
  return blob.put(struct(4 + encoded.length + 1, (v) => { v.setUint32(0, encoded.length, true); new Uint8Array(v.buffer).set(encoded, 4); }));
};
const utf16 = (blob, text) => blob.put(struct(4 + text.length * 2, (v) => {
  v.setUint32(0, text.length * 2, true);
  for (let i = 0; i < text.length; i++) v.setUint16(4 + i * 2, text.charCodeAt(i), true);
}));

function minidump({ time = 1_794_770_653, created = 1_794_770_649, ptype = "renderer", version, signal = 11, code = 1, rip, rsp, rbp, stack = [], modules = defaultModules(), platform = 0x8201, address = 0n, parameters = [], systemInfo = true, moduleListSize }) {
  const blob = new Blob();
  const streams = [];
  blob.put(new Uint8Array(32));
  if (systemInfo) streams.push([7, 56, blob.put(struct(56, (v) => { v.setUint16(0, 9, true); v.setUint32(20, platform, true); }))]);
  streams.push([15, 24, blob.put(struct(24, (v) => { v.setUint32(0, 24, true); v.setUint32(4, 2, true); v.setUint32(8, 1, true); v.setUint32(12, created, true); }))]);
  const context = blob.put(struct(1232, (v) => { v.setBigUint64(0x98, rsp, true); v.setBigUint64(0xa0, rbp, true); v.setBigUint64(0xf8, rip, true); }));
  const stackBytes = struct(0x400, (v) => { for (const [address, value] of stack) v.setBigUint64(Number(address - rsp), value, true); });
  const stackRva = blob.put(stackBytes);
  streams.push([3, 52, blob.put(struct(52, (v) => {
    v.setUint32(0, 1, true);
    v.setUint32(4, 262, true);
    v.setBigUint64(4 + 24, rsp, true);
    v.setUint32(4 + 32, stackBytes.length, true);
    v.setUint32(4 + 36, stackRva, true);
    v.setUint32(4 + 40, 1232, true);
    v.setUint32(4 + 44, context, true);
  }))]);
  streams.push([6, 168, blob.put(struct(168, (v) => {
    v.setUint32(0, 262, true);
    v.setUint32(8, signal, true);
    v.setUint32(12, code >>> 0, true);
    v.setBigUint64(24, address, true);
    v.setUint32(32, parameters.length, true);
    parameters.forEach((parameter, index) => v.setBigUint64(40 + index * 8, parameter, true));
    v.setUint32(160, 1232, true);
    v.setUint32(164, context, true);
  }))]);
  const records = modules.map(({ base, size, path, buildId }) => {
    const name = utf16(blob, path);
    const id = Uint8Array.from(buildId.match(/../g), (pair) => parseInt(pair, 16));
    const cv = blob.put(struct(4 + id.length, (v) => { v.setUint32(0, 0x4270454c, true); new Uint8Array(v.buffer).set(id, 4); }));
    return { base, size, name, cv, cvSize: 4 + id.length };
  });
  streams.push([4, moduleListSize ?? 4 + records.length * 108, blob.put(struct(4 + records.length * 108, (v) => {
    v.setUint32(0, records.length, true);
    records.forEach((record, index) => {
      const at = 4 + index * 108;
      v.setBigUint64(at, record.base, true);
      v.setUint32(at + 8, record.size, true);
      v.setUint32(at + 20, record.name, true);
      v.setUint32(at + 76, record.cvSize, true);
      v.setUint32(at + 80, record.cv, true);
    });
  }))]);
  const verKey = utf8(blob, "ver");
  const verValue = utf8(blob, "157.0.8103.50");
  const simple = blob.put(struct(12, (v) => { v.setUint32(0, 1, true); v.setUint32(4, verKey, true); v.setUint32(8, verValue, true); }));
  const annotated = Object.entries({ ptype, ...(version ? { "ardia-ver": version } : {}) }).map(([key, value]) => {
    const bytes = new TextEncoder().encode(value);
    return [utf8(blob, key), blob.put(struct(4 + bytes.length, (v) => { v.setUint32(0, bytes.length, true); new Uint8Array(v.buffer).set(bytes, 4); }))];
  });
  const objectsSize = 4 + annotated.length * 12;
  const objects = blob.put(struct(objectsSize, (v) => {
    v.setUint32(0, annotated.length, true);
    annotated.forEach(([name, value], i) => { v.setUint32(4 + i * 12, name, true); v.setUint16(8 + i * 12, 1, true); v.setUint32(12 + i * 12, value, true); });
  }));
  const moduleInfo = blob.put(struct(28, (v) => { v.setUint32(0, 1, true); v.setUint32(20, objectsSize, true); v.setUint32(24, objects, true); }));
  const moduleList = blob.put(struct(16, (v) => { v.setUint32(0, 1, true); v.setUint32(4, 0, true); v.setUint32(8, 28, true); v.setUint32(12, moduleInfo, true); }));
  streams.push([0x43500001, 64, blob.put(struct(64, (v) => {
    v.setUint32(0, 1, true);
    v.setUint32(36, 12, true);
    v.setUint32(40, simple, true);
    v.setUint32(44, 16, true);
    v.setUint32(48, moduleList, true);
  }))]);
  const directory = blob.put(struct(streams.length * 12, (v) => streams.forEach(([type, size, rva], i) => { v.setUint32(i * 12, type, true); v.setUint32(i * 12 + 4, size, true); v.setUint32(i * 12 + 8, rva, true); })));
  const bytes = blob.bytes();
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 0x504d444d, true);
  header.setUint32(4, 0xa793, true);
  header.setUint32(8, streams.length, true);
  header.setUint32(12, directory, true);
  header.setUint32(20, time, true);
  return bytes;
}

function defaultModules() {
  return [
    { base: CHROME_BASE, size: CHROME_SIZE, path: "/usr/lib/ardia/chrome", buildId: CHROME_ID },
    { base: LIBC_BASE, size: LIBC_SIZE, path: "/usr/lib/x86_64-linux-gnu/libc.so.6", buildId: LIBC_ID },
    { base: 0x7f10_0000_0000n, size: 0x10_0000, path: "/usr/lib/ardia/libEGL.so", buildId: "aa".repeat(20) },
  ];
}

const chainedStack = () => {
  const frame1 = STACK + 0x40n;
  const frame2 = STACK + 0x80n;
  const frame3 = STACK + 0xc0n;
  return {
    rip: CHROME_BASE + 0x4e1_0320n,
    rsp: STACK,
    rbp: frame1,
    stack: [
      [frame1, frame2], [frame1 + 8n, CHROME_BASE + 0x4e0_d079n],
      [frame2, frame3], [frame2 + 8n, CHROME_BASE + 0xf41_6a4dn],
      [frame3, 0n], [frame3 + 8n, LIBC_BASE + 0x2_9ca8n],
    ],
  };
};

const base64 = (bytes) => Buffer.from(bytes).toString("base64");

function crashHost(dumps, capabilities = [CRASH_DUMPS]) {
  const invoked = [];
  return {
    invoked,
    bootstrap: { windowId: "main", profileId: "default", startup: false, capabilities },
    invoke: async (method, { args }) => {
      invoked.push([method, ...args]);
      if (method === "ArdiaCrash.list") return dumps.map(({ id, time }) => ({ id, time }));
      if (method === "ArdiaCrash.read") return dumps.find((dump) => dump.id === args[0])?.text ?? null;
      throw Object.assign(new Error(`Unknown host method ${method}`), { code: "ERR_UNKNOWN_CALL" });
    },
    call: async () => "{}",
    onEvent: () => () => {},
  };
}

test("a renderer's crashpad dump becomes the Mac's report: process, signal and code, uptime, the engine version, and a frame-pointer walk through chrome", () => {
  const dump = parseMinidump(minidump(chainedStack()));
  const report = linuxCrashReport(dump, { id: "89747b7c", time: 1_794_770_654_000 });
  assert.deepEqual(report, {
    incidentId: "89747b7c",
    time: 1_794_770_653_000,
    fileTime: 1_794_770_654_000,
    process: "renderer",
    frames: [
      { image: "chrome", offset: 0x4e1_0320 },
      { image: "chrome", offset: 0x4e0_d079 },
      { image: "chrome", offset: 0xf41_6a4d },
      { image: "libc.so.6", offset: 0x2_9ca8 },
    ],
    terminationNamespace: "SIGNAL",
    signal: "SIGSEGV",
    exceptionSubtype: "SEGV_MAPERR",
    engineVersion: "157.0.8103.50",
    uptimeSeconds: 4,
    images: [{ name: "chrome", uuid: CHROME_ID }, { name: "libEGL.so", uuid: "aa".repeat(20) }],
  });
});

test("a browser crash inside libc, whose frame pointer libc reused, still walks from the first frame record on the stack", () => {
  const record = STACK + 0x30n;
  const caller = STACK + 0x90n;
  const dump = parseMinidump(minidump({
    ptype: "browser",
    signal: 6,
    code: -6,
    rip: LIBC_BASE + 0x9_a72en,
    rsp: STACK,
    rbp: 0x7fff_ffffn,
    stack: [
      [STACK + 0x8n, LIBC_BASE + 0x100n],
      [STACK + 0x10n, STACK + 0x8n],
      [record, caller], [record + 8n, CHROME_BASE + 0xa5d_3680n],
      [caller, 0n], [caller + 8n, CHROME_BASE + 0x311_537dn],
    ],
  }));
  const report = linuxCrashReport(dump, { id: "97db2f32", time: 1 });
  assert.equal(report.process, "browser");
  assert.equal(report.signal, "SIGABRT");
  assert.equal(report.exceptionSubtype, "SI_TKILL");
  assert.equal(report.engineVersion, undefined);
  assert.deepEqual(report.frames, [
    { image: "libc.so.6", offset: 0x9_a72e },
    { image: "chrome", offset: 0xa5d_3680 },
    { image: "chrome", offset: 0x311_537d },
  ]);
});

test("a browser crash carries the Ardia version the engine annotated, and a helper or a malformed version doesn't", () => {
  const browser = linuxCrashReport(parseMinidump(minidump({ ...chainedStack(), ptype: "browser", version: "0.2.47-nightly.3" })), { id: "v", time: 1 });
  assert.equal(browser.appVersion, "0.2.47-nightly.3");
  const helper = linuxCrashReport(parseMinidump(minidump({ ...chainedStack(), version: "0.2.47-nightly.3" })), { id: "h", time: 1 });
  assert.equal(helper.appVersion, undefined);
  const malformed = linuxCrashReport(parseMinidump(minidump({ ...chainedStack(), ptype: "browser", version: "<b>0.2</b>" })), { id: "m", time: 1 });
  assert.equal(malformed.appVersion, undefined);
});

test("a GPU and an unknown helper map to the Mac's process kinds, and an address outside every module has no image", () => {
  const gpu = linuxCrashReport(parseMinidump(minidump({ ...chainedStack(), ptype: "gpu-process" })), { id: "a", time: 1 });
  assert.equal(gpu.process, "gpu");
  const utility = linuxCrashReport(parseMinidump(minidump({ ...chainedStack(), ptype: "utility", rip: 0x10n })), { id: "b", time: 1 });
  assert.equal(utility.process, "utility");
  assert.deepEqual(utility.frames[0], { image: "???" });
});

test("a dump written without a crash, and bytes that aren't a minidump, are never reported", () => {
  assert.equal(linuxCrashReport(parseMinidump(minidump({ ...chainedStack(), signal: 0xffffffff })), { id: "c", time: 1 }), null);
  assert.equal(parseMinidump(new Uint8Array(64)), null);
  const truncated = minidump(chainedStack()).subarray(0, 300);
  assert.doesNotThrow(() => parseMinidump(truncated));
});

const HOST_PLATFORM = { win: 2, mac: 0x8101 }[process.env.ARDIA_DESKTOP_MODE] ?? 0x8201;
const READS_HOST_DUMPS = HOST_PLATFORM !== 0x8101;

test("ArdiaApp.crashReports reads the engine's crashpad dumps after the cursor, newest five of each kind, and skips a dump it can't read", async () => {
  const at = (n) => 1_794_770_000_000 + n * 1000;
  const renderer = base64(minidump({ ...chainedStack(), platform: HOST_PLATFORM }));
  const browser = base64(minidump({ ...chainedStack(), ptype: "browser", platform: HOST_PLATFORM }));
  const dumps = [
    { id: "old", time: at(0), text: renderer },
    ...Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, time: at(10 + i), text: renderer })),
    { id: "b1", time: at(20), text: browser },
    { id: "gone", time: at(21), text: null },
    { id: "junk", time: at(22), text: base64(new Uint8Array(40)) },
  ];
  const host = crashHost(dumps);
  assert.equal(servesCrashDumps(host), true);
  const reports = await resolveHostModule(host, "ArdiaApp", "crashReports")(at(5));
  assert.deepEqual(reports.map((report) => report.incidentId), READS_HOST_DUMPS ? ["r2", "r3", "r4", "r5", "r6", "b1"] : []);
  assert.deepEqual(host.invoked[0], ["ArdiaCrash.list", at(5)]);
  assert.equal(host.invoked.some(([method, id]) => method === "ArdiaCrash.read" && id === "old"), false);
});

test("without the engine's crash dumps ArdiaApp.crashReports answers an empty list and asks the host nothing", async () => {
  const host = crashHost([{ id: "r", time: 2, text: base64(minidump(chainedStack())) }], []);
  assert.equal(servesCrashDumps(host), false);
  assert.deepEqual(await resolveHostModule(host, "ArdiaApp", "crashReports")(0), []);
  assert.deepEqual(host.invoked, []);
});

const WIN_CHROME_BASE = 0x7ffa_1000_0000n;
const WIN_MODULES = [
  { base: 0x7ff6_0000_0000n, size: 0x30_0000, path: "C:\\Users\\someone\\AppData\\Local\\Ardia WebUI\\Application\\ardia.exe", buildId: "bb".repeat(20) },
  { base: WIN_CHROME_BASE, size: 0x1000_0000, path: "C:\\Users\\someone\\AppData\\Local\\Ardia WebUI\\Application\\158.0.8127.36\\chrome.dll", buildId: "cc".repeat(20) },
  { base: 0x7ffb_0000_0000n, size: 0x10_0000, path: "\\\\server\\share\\not a module.txt", buildId: "dd".repeat(20) },
  { base: 0x7ffc_0000_0000n, size: 0x10_0000, path: "https://example.test/evil.dll", buildId: "ee".repeat(20) },
];
const windowsDump = (overrides) => minidump({ ...chainedStack(), platform: 2, modules: WIN_MODULES, signal: 0xc0000005, code: 0, address: WIN_CHROME_BASE + 0x12_3456n, parameters: [1n, 0x10n], ...overrides });

test("a Windows crashpad dump becomes the RNW report: NTSTATUS name, access kind, only the faulting module's file name, uptime and versions", () => {
  const dump = parseMinidump(windowsDump({}));
  assert.equal(isWindowsDump(dump), true);
  assert.deepEqual(windowsCrashReport(dump, { id: "5d0c3e8e-0f3a-4f39-9a59-2f8c2d4f6a11", time: 1_794_770_654_000 }), {
    incidentId: "5d0c3e8e-0f3a-4f39-9a59-2f8c2d4f6a11",
    time: 1_794_770_653_000,
    fileTime: 1_794_770_654_000,
    process: "renderer",
    frames: [{ image: "chrome.dll", offset: 0x12_3456 }],
    terminationNamespace: "WIN32_EXCEPTION",
    signal: "EXCEPTION_ACCESS_VIOLATION",
    exceptionSubtype: "ACCESS_WRITE",
    engineVersion: "157.0.8103.50",
    uptimeSeconds: 4,
  });
  const browser = windowsCrashReport(parseMinidump(windowsDump({ ptype: "browser", version: "0.2.47-nightly.3", parameters: [8n] })), { id: "b", time: 1 });
  assert.equal(browser.appVersion, "0.2.47-nightly.3");
  assert.equal(browser.exceptionSubtype, "ACCESS_EXECUTE");
  assert.equal(browser.engineVersion, undefined);
});

test("a Windows dump names an unknown status by its code, gives no access kind outside access faults, and leaves unsafe module paths out", () => {
  const unknown = windowsCrashReport(parseMinidump(windowsDump({ signal: 0xc0001234, parameters: [0n] })), { id: "u", time: 1 });
  assert.equal(unknown.signal, "STATUS_C0001234");
  assert.equal(unknown.exceptionSubtype, undefined);
  const overrun = windowsCrashReport(parseMinidump(windowsDump({ signal: 0xc0000409, parameters: [] })), { id: "o", time: 1 });
  assert.equal(overrun.signal, "STATUS_STACK_BUFFER_OVERRUN");
  const read = windowsCrashReport(parseMinidump(windowsDump({ signal: 0xc0000006, parameters: [0n] })), { id: "r", time: 1 });
  assert.equal(read.exceptionSubtype, "ACCESS_READ");
  for (const [base, image] of [[0x7ffb_0000_0000n, "???"], [0x7ffc_0000_0000n, "???"], [0x10n, undefined]]) {
    const report = windowsCrashReport(parseMinidump(windowsDump({ address: base + 4n })), { id: "p", time: 1 });
    assert.deepEqual(report.frames, image ? [{ image, offset: 4 }] : [{ image: "???" }]);
  }
});

test("a Windows dump written without a crash is never reported, and a Linux dump keeps the Linux reader", () => {
  assert.equal(windowsCrashReport(parseMinidump(windowsDump({ signal: 0x517a7ed })), { id: "s", time: 1 }), null);
  const linux = parseMinidump(minidump(chainedStack()));
  assert.equal(isWindowsDump(linux), false);
  assert.equal(linuxCrashReport(linux, { id: "l", time: 1 }).terminationNamespace, "SIGNAL");
});

test("ArdiaApp.crashReports reads only dumps of the platform the host was built for, with that platform's reader", async () => {
  const host = crashHost([{ id: "w", time: 5, text: base64(windowsDump({ ptype: "browser" })) }, { id: "l", time: 6, text: base64(minidump(chainedStack())) }]);
  const reports = await resolveHostModule(host, "ArdiaApp", "crashReports")(0);
  const expected = { 2: [["w", "WIN32_EXCEPTION"]], 0x8201: [["l", "SIGNAL"]] }[HOST_PLATFORM] ?? [];
  assert.deepEqual(reports.map((report) => [report.incidentId, report.terminationNamespace]), expected);
});

test("a dump without system info, or whose platform contradicts the host, is never reported", () => {
  const entry = { id: "m", time: 1 };
  assert.equal(hostCrashReport(parseMinidump(windowsDump({ systemInfo: false })), entry, 2), null);
  assert.equal(hostCrashReport(parseMinidump(minidump({ ...chainedStack(), systemInfo: false })), entry, 0x8201), null);
  assert.equal(hostCrashReport(parseMinidump(minidump({ ...chainedStack(), platform: 0x8101 })), entry, 0x8201), null);
  assert.equal(hostCrashReport(parseMinidump(windowsDump({})), entry, 0x8201), null);
  assert.equal(hostCrashReport(parseMinidump(minidump(chainedStack())), entry, 2), null);
  assert.equal(hostCrashReport(parseMinidump(windowsDump({})), entry, 2).terminationNamespace, "WIN32_EXCEPTION");
  assert.equal(hostCrashReport(parseMinidump(minidump(chainedStack())), entry, 0x8201).terminationNamespace, "SIGNAL");
  assert.equal(hostCrashReport(parseMinidump(minidump({ ...chainedStack(), platform: 0x8101 })), entry, 0x8101), null, "the Mac WebUI has no Mac dump reader yet, so it never reports a Mac dump as a Linux signal");
});

test("a Windows module path in a Linux dump leaves only its file name", () => {
  const leaky = [{ base: CHROME_BASE, size: CHROME_SIZE, path: "C:\\Users\\someone\\secret\\chrome.dll", buildId: CHROME_ID }];
  const report = linuxCrashReport(parseMinidump(minidump({ ...chainedStack(), modules: leaky })), { id: "x", time: 1 });
  assert.equal(report.frames[0].image, "chrome.dll");
  assert.ok(report.frames.every((frame) => !frame.image.includes("\\") && !frame.image.includes("/")));
});

test("module records past their stream's declared size, and module names over the string cap, are not read", () => {
  const short = parseMinidump(minidump({ ...chainedStack(), moduleListSize: 4 + 108 }));
  assert.deepEqual(short.modules, []);
  assert.deepEqual(linuxCrashReport(short, { id: "s", time: 1 }).frames[0], { image: "???" });
  const huge = [{ base: CHROME_BASE, size: CHROME_SIZE, path: `/usr/lib/${"a".repeat(5000)}`, buildId: CHROME_ID }];
  const named = parseMinidump(minidump({ ...chainedStack(), modules: huge }));
  assert.equal(named.modules[0].path, "");
  assert.equal(linuxCrashReport(named, { id: "h", time: 1 }).frames[0].image, "???");
  const windows = parseMinidump(windowsDump({ modules: [{ ...WIN_MODULES[1], path: `C:\\${"b".repeat(3000)}\\chrome.dll` }] }));
  assert.deepEqual(windowsCrashReport(windows, { id: "w", time: 1 }).frames, [{ image: "???", offset: 0x12_3456 }]);
});
