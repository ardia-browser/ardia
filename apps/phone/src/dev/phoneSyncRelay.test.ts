import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { copyInto, emptySide, LIST_STAT_SCRIPT, LISTED, listed, nextRecord, parseListing, partsFolder, pass, plan, probePhone, typePhrase } from "../../scripts/phone-sync-relay.mjs";
import { writeFakeAdb } from "../../test/fakeAdb.ts";

type Entry = { mtime: number; size: number };
type Side = Record<string, Entry>;

const at = (mtime: number, size = 10): Entry => ({ mtime, size });

function simulate(record: Record<string, { mac?: Entry; phone?: Entry }>, mac: Side, phone: Side, copiedAt: number) {
  const steps = plan(mac, phone, record);
  const afterMac = { ...mac };
  const afterPhone = { ...phone };
  for (const { kind, file } of steps) {
    if (kind === "toPhone") afterPhone[file] = at(copiedAt, mac[file]!.size);
    else if (kind === "toMac") afterMac[file] = at(copiedAt, phone[file]!.size);
    else if (kind === "deleteOnMac") delete afterMac[file];
    else delete afterPhone[file];
  }
  const after = { mac: afterMac, phone: afterPhone };
  return { steps, after, record: nextRecord(record, { mac, phone }, after, steps, steps) };
}

test("new files go across, and a second pass with nothing changed does nothing", () => {
  const first = simulate({}, { "a.json": at(100) }, { "b.json": at(200) }, 300);
  assert.deepEqual(first.steps, [
    { kind: "toPhone", file: "a.json" },
    { kind: "toMac", file: "b.json" },
  ]);
  const second = simulate(first.record, first.after.mac, first.after.phone, 400);
  assert.deepEqual(second.steps, []);
});

test("a change on one side is copied to the other even though the copy is newer than the change", () => {
  const synced = simulate({}, { "a.json": at(100) }, {}, 300);
  const changed = simulate(synced.record, { "a.json": at(150, 12) }, synced.after.phone, 500);
  assert.deepEqual(changed.steps, [{ kind: "toPhone", file: "a.json" }]);
  const phoneChanged = simulate(changed.record, changed.after.mac, { "a.json": at(600, 14) }, 700);
  assert.deepEqual(phoneChanged.steps, [{ kind: "toMac", file: "a.json" }]);
});

test("a file deleted on one side after both had it is deleted on the other; one that never synced is copied", () => {
  const synced = simulate({}, { "a.json": at(100), "b.json": at(100) }, {}, 300);
  const deleted = simulate(synced.record, synced.after.mac, { "b.json": synced.after.phone["b.json"]! }, 400);
  assert.deepEqual(deleted.steps, [{ kind: "deleteOnMac", file: "a.json" }]);
  assert.deepEqual(Object.keys(deleted.record), ["b.json"]);
});

test("changed on both sides, the newer one wins", () => {
  const synced = simulate({}, { "a.json": at(100) }, {}, 300);
  const both = plan({ "a.json": at(800, 20) }, { "a.json": at(900, 30) }, synced.record);
  assert.deepEqual(both, [{ kind: "toMac", file: "a.json" }]);
});

test("a source that changed while it was copied is copied again on the next pass, never copied back", () => {
  const before = { mac: { "a.json": at(100) }, phone: {} };
  const steps = plan(before.mac, before.phone, {});
  const after = { mac: { "a.json": at(150, 11) }, phone: { "a.json": at(300) } };
  const record = nextRecord({}, before, after, steps, steps);
  assert.deepEqual(plan(after.mac, after.phone, record), [{ kind: "toPhone", file: "a.json" }]);
});

test("a step that failed keeps its old record, so the next pass tries it again", () => {
  const before = { mac: { "a.json": at(100) }, phone: {} };
  const steps = plan(before.mac, before.phone, {});
  const record = nextRecord({}, before, before, steps, []);
  assert.deepEqual(record, {});
  assert.deepEqual(plan(before.mac, before.phone, record), [{ kind: "toPhone", file: "a.json" }]);
});

test("listings from BSD and GNU stat parse, with spaces in names and the relay's own partial files left out", () => {
  const files = parseListing("1700000000 42 ./scope/one file.json\n1700000001 7 ./b.json\n1700000002 9 ./b.json.relay-part\nnoise\n");
  assert.deepEqual(files, { "scope/one file.json": { mtime: 1700000000, size: 42 }, "b.json": { mtime: 1700000001, size: 7 } });
});

test("a side that lists nothing after a pass saw files there stops the pass instead of deleting the other side", () => {
  const synced = simulate({}, { "a.json": at(100) }, {}, 300);
  assert.equal(emptySide({ mac: synced.after.mac, phone: {} }, synced.record), "phone");
  assert.equal(emptySide({ mac: {}, phone: synced.after.phone }, synced.record), "mac");
  assert.equal(emptySide({ mac: synced.after.mac, phone: synced.after.phone }, synced.record), null);
  assert.equal(emptySide({ mac: {}, phone: {} }, {}), null);
});

test("the relay's probe file is left out of a pass's listing and kept for the probe itself", () => {
  const out = "1700000000 18 ./.ardia-relay-probe\n1700000001 7 ./b.json\n";
  assert.deepEqual(Object.keys(parseListing(out)), ["b.json"]);
  assert.deepEqual(parseListing(out, { withProbe: true })[".ardia-relay-probe"], { mtime: 1700000000, size: 18 });
});

const made: string[] = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function relayWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-world-"));
  made.push(root);
  const adb = writeFakeAdb(root);
  const mac = path.join(root, "mac", "folder");
  const phone = path.join(root, "phone", "Ardia Sync");
  const work = path.join(root, "work");
  fs.mkdirSync(mac, { recursive: true });
  fs.mkdirSync(phone, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const opts = { mac, phoneFolder: phone, work, adb, serial: "fake" };
  const phoneSide = {
    folder: phone,
    shell: (command: string): [string, string[]] => [adb, ["-s", "fake", "shell", command]],
    write: (part: string): [string, string[]] => [adb, ["-s", "fake", "exec-in", `cat > '${part}'`]],
    read: (file: string): [string, string[]] => [adb, ["-s", "fake", "exec-out", `cat '${file}'`]],
  };
  const files = (dir: string) => (fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort() : []);
  return { root, adb, mac, phone, work, opts, phoneSide, files };
}

test("the stand-in adb behaves like the F4: exec-in runs only the command that reads stdin and drops the rest", () => {
  const { adb, root } = relayWorld();
  execFileSync(adb, ["-s", "fake", "exec-in", `cat > '${root}/p' && mv -f '${root}/p' '${root}/q'`], { input: "hello" });
  assert.equal(fs.readFileSync(path.join(root, "p"), "utf8"), "hello");
  assert.equal(fs.existsSync(path.join(root, "q")), false);
});

test("a copy to the phone is written whole beside the folder, checked, then renamed into place, leaving no part file", async () => {
  const { phone, phoneSide, files, mac } = relayWorld();
  fs.writeFileSync(path.join(mac, "a.nns"), "x".repeat(70_000));
  const target = path.join(phone, "scope", "a.nns");
  const sent = await copyInto(phoneSide, ["cat", [path.join(mac, "a.nns")]], target);
  assert.equal(sent.bytes, 70_000);
  assert.equal(fs.readFileSync(target, "utf8"), "x".repeat(70_000));
  assert.deepEqual(files(phone), ["scope/a.nns"]);
  assert.deepEqual(files(partsFolder(phone)), []);
});

test("a write that lands late, as on the F4, is waited for and then put in place", async () => {
  const { phone, phoneSide, files, mac } = relayWorld();
  fs.writeFileSync(path.join(mac, "a.nns"), "late bytes");
  process.env.FAKE_ADB_WRITE_DELAY_MS = "600";
  try {
    const sent = await copyInto(phoneSide, ["cat", [path.join(mac, "a.nns")]], path.join(phone, "a.nns"));
    assert.ok(sent.attempts > 1, `checked ${sent.attempts} time(s)`);
  } finally {
    delete process.env.FAKE_ADB_WRITE_DELAY_MS;
  }
  assert.equal(fs.readFileSync(path.join(phone, "a.nns"), "utf8"), "late bytes");
  assert.deepEqual(files(partsFolder(phone)), []);
});

test("the probe passes on a phone whose writes land late", async () => {
  const { phone, opts, files } = relayWorld();
  process.env.FAKE_ADB_WRITE_DELAY_MS = "400";
  try {
    await probePhone(opts);
  } finally {
    delete process.env.FAKE_ADB_WRITE_DELAY_MS;
  }
  assert.deepEqual(files(phone), []);
});

test("a copy that arrives short is not put in place and its part is removed", async () => {
  const { phone, phoneSide, files, mac } = relayWorld();
  fs.writeFileSync(path.join(mac, "a.nns"), "y".repeat(5_000));
  process.env.FAKE_ADB_TRUNCATE = "1";
  try {
    await assert.rejects(copyInto(phoneSide, ["cat", [path.join(mac, "a.nns")]], path.join(phone, "a.nns")), /didn't arrive whole/);
  } finally {
    delete process.env.FAKE_ADB_TRUNCATE;
  }
  assert.deepEqual(files(phone), []);
  assert.deepEqual(files(partsFolder(phone)), []);
});

test("the probe goes through the real copy path, and leaves neither name nor an old run's part behind", async () => {
  const { phone, opts, files } = relayWorld();
  fs.writeFileSync(path.join(phone, ".ardia-relay-probe.relay-part"), "left by sync10's relay");
  const log = path.join(opts.work, "adb.log");
  process.env.FAKE_ADB_LOG = log;
  try {
    await probePhone(opts);
  } finally {
    delete process.env.FAKE_ADB_LOG;
  }
  assert.deepEqual(files(phone), []);
  assert.equal(fs.existsSync(partsFolder(phone)), false);
  const calls = fs.readFileSync(log, "utf8");
  assert.match(calls, /^exec-in cat > '[^']*\.ardia-relay-parts\/[^']*\.relay-part'$/m);
  assert.match(calls, /relay-committed/);
});

test("a pass copies both ways through the stand-in and a second pass does nothing", async () => {
  const { mac, phone, opts, files } = relayWorld();
  fs.mkdirSync(path.join(mac, "s"), { recursive: true });
  fs.writeFileSync(path.join(mac, "s", "from-mac.nns"), "mac bytes");
  fs.writeFileSync(path.join(phone, "from-phone.nns"), "phone bytes");
  const first = await pass(opts);
  assert.deepEqual(first.failed, []);
  assert.deepEqual(files(mac), ["from-phone.nns", "s/from-mac.nns"]);
  assert.deepEqual(files(phone), ["from-phone.nns", "s/from-mac.nns"]);
  assert.equal(fs.readFileSync(path.join(phone, "s", "from-mac.nns"), "utf8"), "mac bytes");
  assert.equal(fs.readFileSync(path.join(mac, "from-phone.nns"), "utf8"), "phone bytes");
  const second = await pass(opts);
  assert.deepEqual(second.steps, []);
});

test("a file that vanishes between find and stat is left out, and the listing still counts", () => {
  const { phone, adb } = relayWorld();
  fs.writeFileSync(path.join(phone, "kept.nns"), "k");
  const script = LIST_STAT_SCRIPT;
  const out = execFileSync("sh", ["-c", `cd '${phone}' && sh -c '${script.replace(/'/g, `'\\''`)}' sh ./kept.nns ./vanished.nns; echo ${LISTED}`], { encoding: "utf8" });
  assert.deepEqual(Object.keys(listed(out, "phone's")), ["kept.nns"]);
  assert.ok(adb);
});

test("a listing that never ran is an error, not an empty folder", () => {
  assert.throws(() => listed("", "phone's"), /could not be listed/);
  assert.throws(() => listed("1700000000 3 ./a.nns\n", "phone's"), /could not be listed/);
});

test("type-phrase reads the phrase beside the Mac's folder and types it through stdin, never on a command line", () => {
  const { root, mac, opts } = relayWorld();
  const words = Array.from({ length: 24 }, (_, index) => `word${index}`).join(" ");
  fs.writeFileSync(path.join(path.dirname(mac), "phrase.txt"), `${words}\n`, { mode: 0o600 });
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "input"), `#!/bin/sh\nprintf '%s' "$2" > '${root}/typed'\n`, { mode: 0o755 });
  const log = path.join(root, "adb.log");
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  process.env.FAKE_ADB_LOG = log;
  try {
    assert.match(typePhrase(opts), /typed the 24 words/);
  } finally {
    process.env.PATH = before;
    delete process.env.FAKE_ADB_LOG;
  }
  assert.equal(fs.readFileSync(path.join(root, "typed"), "utf8"), words.replace(/ /g, "%s"));
  assert.doesNotMatch(fs.readFileSync(log, "utf8"), /word7/);
});
