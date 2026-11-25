import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const { NativeModules } = await import("react-native");
const annotations = [];
const native = {
  epoch: 0,
  start: () => true,
  setConsentEpoch(epoch) {
    this.epoch = epoch;
    return true;
  },
  take: () => null,
  annotate: (id, activity) => (annotations.push([id, activity]), true),
};
NativeModules.ACFreezeWatch = native;

const client = await import("./client.ts");
const freezes = await import("./freezes.ts");
const events = await import("./freezeEvents.ts");
const records = await import("./freezeRecords.ts");
const sends = await import("./freezeSends.ts");
const jobs = await import("../app/jobActivity.ts");
after(() => client.setSharing(false, "settings"));

const reportFreeze = (r) => events.reportFreeze(r, r.epoch || null);
const frames = (...pairs) => pairs.map(([image, offset]) => ({ image, offset }));
let nextId = 100;
const record = (over = {}) => ({
  id: nextId++,
  thread: "js",
  startedAt: Date.now() - 3000,
  durationMs: 2400,
  inputWaitMs: 900,
  gcMs: 2100,
  gcCount: 7,
  thermal: 2,
  epoch: client.consentToken() ?? "",
  watchEpoch: native.epoch,
  samples: [{ state: 1, frames: frames(["hermes", 0x1ae2a0], ["hermes", 0x1ae528], ["Ardia", 0x4400], ["system", 0x123]) }],
  images: [
    { name: "hermes", uuid: "11111111-2222-3333-4444-555555555555" },
    { name: "/Users/someone/evil.dylib", uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
  ],
  ...over,
});

async function sentFreezes() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "app_freeze").map((e) => e.properties);
}

beforeEach(() => {
  stub.docs.delete("freeze-sends.json");
  client.loadChoice();
  client.setSharing(false, "settings");
  events.resetFreezeEventsForTests();
  jobs.forgetActivitiesForTests();
  stub.docs.delete("freezes.txt");
  stub.docs.delete("telemetry-queue.json");
  annotations.length = 0;
});

test("the frame scrubber keeps our own images and 'system' with offsets and turns anything else into 'other' with no offset", () => {
  assert.deepEqual(
    events.scrubFrames(frames(["Chromium Framework", 10], ["system", 20], ["/usr/lib/libfoo.dylib", 30], ["Evil Helper", 40], ["other", 50], ["hermes", -1])),
    frames(["Chromium Framework", 10], ["system", 20], ["other", 0], ["other", 0], ["other", 0], ["hermes", 0]),
  );
  assert.equal(events.scrubFrames(Array.from({ length: 40 }, (_, i) => ({ image: "Ardia", offset: i }))).length, 24);
});

test("a signature is the top three frames from our own images: same place, same signature; elsewhere, different", () => {
  const a = events.freezeSignature("js", frames(["system", 1], ["hermes", 0x10], ["hermes", 0x20], ["Ardia", 0x30], ["Ardia", 0x40]));
  const b = events.freezeSignature("js", frames(["system", 9], ["hermes", 0x10], ["hermes", 0x20], ["Ardia", 0x30], ["Ardia", 0x99]));
  const c = events.freezeSignature("js", frames(["hermes", 0x11], ["hermes", 0x20], ["Ardia", 0x30]));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^sig_[0-9a-f]{8}$/);
  assert.equal(events.freezeSignature("main", frames(["system", 1])), "none_main");
  assert.notEqual(events.freezeSignature("main", frames(["Ardia", 1])), events.freezeSignature("js", frames(["Ardia", 1])));
});

test("sharing off: nothing is sent, but the local record still gets the job that was running", async () => {
  freezes.startFreezeWatch();
  const end = jobs.beginActivity("sync", Date.now() - 2900);
  end();
  await reportFreeze(record({ watchEpoch: 0 }));
  assert.deepEqual(await sentFreezes(), []);
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0][1], "sync");
});

test("a freeze from an earlier sharing period isn't sent in a later one", async () => {
  client.setSharing(true, "settings");
  const stale = record();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  await reportFreeze(stale);
  await reportFreeze(record({ epoch: stale.epoch }));
  await reportFreeze(record({ watchEpoch: stale.watchEpoch }));
  assert.deepEqual(await sentFreezes(), [], "an earlier period's stamp or watch epoch: dropped");
  await reportFreeze(record());
  assert.equal((await sentFreezes()).length, 1, "this period's stamp and watch epoch: sent");
});

test("app_freeze carries buckets, counts, enums, the signature and scrubbed frames and images only", async () => {
  client.setSharing(true, "settings");
  const done = jobs.beginActivity("sessionSave", Date.now() - 3100);
  await reportFreeze(record());
  done();
  const [sent] = await sentFreezes();
  assert.ok(sent);
  assert.equal(sent.freeze_thread, "js");
  assert.equal(sent.freeze_duration, "2_5s");
  assert.equal(sent.freeze_ms, 2400);
  assert.equal(sent.input_wait_ms, 900);
  assert.equal(sent.gc_ms, 2100);
  assert.equal(sent.gc_count, 7);
  assert.equal(sent.activity, "sessionSave");
  assert.equal(sent.thermal, "serious");
  assert.match(sent.signature, /^sig_[0-9a-f]{8}$/);
  assert.ok(["sidebar", "top"].includes(sent.layout));
  assert.equal(typeof sent.sync_on, "boolean");
  const text = JSON.stringify(sent);
  assert.ok(!text.includes("/Users/"), "no paths");
  assert.ok(!text.includes("evil"), "only allowlisted images");
  assert.ok(!/interpretFunction|HadesGC/.test(text), "no symbol names");
  assert.deepEqual(sent.freeze_images, [{ name: "hermes", uuid: "11111111-2222-3333-4444-555555555555" }]);
  assert.ok(sent.freeze_frames.every((f) => f.lang === "native" && /^(hermes|Ardia|system) \+ 0x[0-9a-f]+$/.test(f.function)));
});

test("app_freeze names the macOS shared cache its system frames are offsets into, and only that", async () => {
  client.setSharing(true, "settings");
  const cache = "ABCDEF01-2345-6789-ABCD-EF0123456789";
  await reportFreeze(record({ images: [{ name: "hermes", uuid: "11111111-2222-3333-4444-555555555555" }, { name: "system", uuid: cache }] }));
  await reportFreeze(record({ samples: [{ state: 1, frames: frames(["Ardia", 0x5500]) }], images: [{ name: "system", uuid: cache }] }));
  await reportFreeze(record({ samples: [{ state: 1, frames: frames(["Ardia", 0x6600], ["system", 0x10]) }], images: [{ name: "system", uuid: "not-a-cache" }] }));
  const [withSystem, withoutSystem, malformed] = await sentFreezes();
  assert.equal(withSystem.freeze_system_cache, cache.toLowerCase());
  assert.deepEqual(withSystem.freeze_images, [{ name: "hermes", uuid: "11111111-2222-3333-4444-555555555555" }]);
  assert.equal(withoutSystem.freeze_system_cache, null);
  assert.equal(malformed.freeze_system_cache, null);
});

test("a signature whose hash is all digits survives the property scrub, stays distinct and keeps its one send a day", async () => {
  const { cleanProperties } = await import("./sanitize.ts");
  client.setSharing(true, "settings");
  const offsets = [];
  for (let offset = 1; offsets.length < 2; offset++) if (/^\d+$/.test(events.freezeSignature("js", frames(["Ardia", offset])).replace(/^sig_/, ""))) offsets.push(offset);
  const signatures = offsets.map((offset) => events.freezeSignature("js", frames(["Ardia", offset])));
  assert.deepEqual(signatures.map((signature) => cleanProperties({ signature }).signature), signatures);
  for (const offset of offsets) await reportFreeze(record({ samples: [{ state: 1, frames: frames(["Ardia", offset]) }] }));
  const sent = (await sentFreezes()).map((p) => p.signature);
  assert.deepEqual(sent, signatures);
  assert.notEqual(sent[0], sent[1]);
  stub.docs.delete("freeze-sends.json");
  const day = Date.UTC(2026, 10, 20);
  assert.equal(sends.claimDailySend(signatures[0], day), true);
  assert.equal(sends.claimDailySend(signatures[0], day + 60_000), false, "same signature, same day");
  assert.equal(sends.claimDailySend(signatures[1], day + 120_000), true);
  assert.deepEqual(sends.sendsOn(day).signatures, signatures, "the ledger keeps the prefixed form");
});

test("a signature names the build: the same offsets in images with other UUIDs hash apart, an identical record hashes the same", async () => {
  const top = frames(["hermes", 0x10], ["Ardia", 0x20]);
  const build = (hermes, ardia) => [{ name: "hermes", uuid: hermes }, { name: "Ardia", uuid: ardia }];
  const a = events.freezeSignature("js", top, build("11111111-2222-3333-4444-555555555555", "aaaaaaaa-2222-3333-4444-555555555555"));
  assert.match(a, /^sig_[0-9a-f]{8}$/);
  assert.equal(events.freezeSignature("js", top, build("11111111-2222-3333-4444-555555555555", "aaaaaaaa-2222-3333-4444-555555555555")), a);
  assert.notEqual(events.freezeSignature("js", top, build("11111111-2222-3333-4444-555555555555", "bbbbbbbb-2222-3333-4444-555555555555")), a);
  assert.notEqual(events.freezeSignature("js", top, build("99999999-2222-3333-4444-555555555555", "aaaaaaaa-2222-3333-4444-555555555555")), a);
  assert.equal(events.freezeSignature("js", top, [...build("11111111-2222-3333-4444-555555555555", "aaaaaaaa-2222-3333-4444-555555555555"), { name: "Chromium Framework", uuid: "cccccccc-2222-3333-4444-555555555555" }]), a, "images without a top frame don't count");
  client.setSharing(true, "settings");
  const updated = { name: "hermes", uuid: "66666666-2222-3333-4444-555555555555" };
  await reportFreeze(record());
  events.resetFreezeEventsForTests();
  await reportFreeze(record({ images: [updated] }));
  const sent = (await sentFreezes()).map((p) => p.signature);
  assert.equal(sent.length, 2, "the same place after an update is sent again the same day");
  assert.notEqual(sent[0], sent[1]);
});

test("at most 5 a session, and one of each signature", async () => {
  client.setSharing(true, "settings");
  await reportFreeze(record());
  await reportFreeze(record());
  assert.equal((await sentFreezes()).length, 1, "same signature twice: sent once");
  for (let i = 1; i <= 6; i++) await reportFreeze(record({ samples: [{ state: 1, frames: frames(["Ardia", 0x1000 * i]) }] }));
  assert.equal((await sentFreezes()).length, events.MAX_FREEZES_PER_SESSION);
});

test("the daily ledger: 20 a UTC day, one per signature a day, kept apart from the local ring, and a new day starts fresh", () => {
  stub.docs.delete("freeze-sends.json");
  const day = Date.parse("2026-11-17T12:00:00Z");
  assert.equal(sends.claimDailySend("aaaa0001", day), true);
  assert.equal(sends.claimDailySend("aaaa0001", day + 3_600_000), false, "same signature, same day");
  for (let i = 2; i <= 20; i++) assert.equal(sends.claimDailySend(`aaaa${String(i).padStart(4, "0")}`, day), true);
  assert.equal(sends.claimDailySend("bbbb0001", day), false, "21st of the day");
  assert.deepEqual([sends.sendsOn(day).sent, sends.sendsOn(day).signatures.length], [20, 20]);
  assert.equal(sends.claimDailySend("aaaa0001", day + 86_400_000), true, "the next UTC day starts fresh");
  assert.equal(JSON.parse(stub.docs.get("freeze-sends.json")).version, 1);
  stub.docs.set("freeze-sends.json", '{"version":1,"day":"2026-11-18","sent":"lots","signatures":[]}');
  assert.equal(sends.sendsOn(day + 86_400_000).sent, 0, "a malformed document reads as nothing sent");
});

const slot = (text) => (text + " ".repeat(4096)).slice(0, 4095) + "\n";

test("the local record parses back, and Copy Diagnostics and Copy Last Freeze describe it", () => {
  const now = Date.now();
  const file =
    slot(`freeze 7 main recovered\nstarted_ms ${now - 60_000}\nduration_ms 6043\ninput_wait_ms 0\ngc_ms unknown\nactivity none\nthermal 0\nsample 1 state 1\n  system +0x1a\n  Chromium Framework +0x2b3c\n  Ardia +0x44\nimage Chromium Framework 11111111-2222-3333-4444-555555555555\nend\n`) +
    slot(`freeze 8 js frozen\nstarted_ms ${now - 5_000}\nduration_ms 2000\ninput_wait_ms 0\ngc_ms 1900\nactivity sync\nthermal 1\nsample 1 state 1\n  hermes +0x1ae2a0\nend\n`) +
    slot("garbage slot");
  const parsed = records.parseFreezeRecords(file);
  assert.deepEqual(parsed.map((r) => [r.seq, r.thread, r.recovered, r.durationMs, r.activity]), [
    [7, "main", true, 6043, "none"],
    [8, "js", false, 2000, "sync"],
  ]);
  assert.equal(records.topOwnFrame(parsed[0]), "Chromium Framework +0x2b3c");
  assert.equal(records.freezeSummaryLine(parsed, now), "Freezes: 2 today, longest 6.0 s; last 2.0 s on the js thread (did not recover), cause sync");
  assert.ok(records.lastFreezeText(parsed).includes("freeze 8 js frozen"));
  assert.equal(records.freezeSummaryLine([], now), "Freezes: none recorded");
  assert.deepEqual(records.parseFreezeRecords("freeze 1 main recovered\nno end marker"), []);
});

test("the job a freeze overlapped most is its activity", () => {
  const now = Date.now();
  jobs.beginActivity("sync", now - 10)();
  const save = jobs.beginActivity("sessionSave", now - 9000);
  assert.equal(jobs.activityDuring(now - 9000, now + 1000), "sessionSave");
  save();
  assert.equal(jobs.activityDuring(now - 60_000, now - 50_000), "none");
  assert.equal(jobs.during("import", () => 41) + 1, 42);
});

test("a main-thread freeze is charged only to a job that holds the main thread; the JS job it ran beside is js_activity", async () => {
  client.setSharing(true, "settings");
  const save = jobs.beginActivity("sessionSave", Date.now() - 2000);
  await reportFreeze(record({ thread: "main", samples: [{ state: 1, frames: frames(["Ardia", 0x5100], ["system", 0x1]) }] }));
  const carry = jobs.beginActivity("siteDataCarry", Date.now() - 3200);
  await reportFreeze(record({ thread: "main", samples: [{ state: 1, frames: frames(["Ardia", 0x5200], ["system", 0x1]) }] }));
  await reportFreeze(record({ thread: "js", samples: [{ state: 1, frames: frames(["hermes", 0x5300], ["system", 0x1]) }] }));
  carry();
  save();
  const [beside, held, js] = await sentFreezes();
  assert.deepEqual([beside.freeze_thread, beside.activity, beside.js_activity], ["main", "none", "sessionSave"]);
  assert.deepEqual([held.freeze_thread, held.activity, held.js_activity], ["main", "siteDataCarry", "sessionSave"]);
  assert.deepEqual([js.freeze_thread, js.activity, js.js_activity], ["js", "siteDataCarry", null]);
  assert.equal(jobs.holdsMainThread("sessionSave"), false);
  assert.equal(jobs.holdsMainThread("siteDataCarry"), true);
});

test("more than 20 freezes in one day across restarts: 20 sent at most, and a signature sent today isn't sent again after the local ring wraps", async () => {
  client.setSharing(true, "settings");
  stub.docs.delete("freeze-sends.json");
  const ring = [];
  const writeRing = (rec, frames) => {
    ring[(rec.id - 1) % 20] = slot(`freeze ${rec.id} js recovered\nstarted_ms ${rec.startedAt}\nduration_ms 2400\ninput_wait_ms 0\ngc_ms 0\nactivity none\nthermal 0\nsample 1 state 1\n${frames.map((f) => `  ${f.image} +0x${f.offset.toString(16)}`).join("\n")}\nend\n`);
    stub.docs.set("freezes.txt", ring.map((s) => s ?? slot("")).join(""));
  };
  const freezeAt = async (id, frames) => {
    const rec = record({ id, startedAt: Date.now() - 3000, samples: [{ state: 1, frames }] });
    writeRing(rec, frames);
    await reportFreeze(rec);
  };
  for (let i = 1; i <= 30; i++) {
    if (i % 5 === 1) events.resetFreezeEventsForTests();
    await freezeAt(1000 + i, frames(["Ardia", 0x10000 * i]));
  }
  events.resetFreezeEventsForTests();
  await freezeAt(1031, frames(["Ardia", 0x10000 * 1]));
  assert.equal((await sentFreezes()).length, 20);
});
