import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const watch = readFileSync(new URL("../ios/ArdiaFreezeWatch.mm", import.meta.url), "utf8");

const body = (header, closer = "\n}\n") => {
  const start = watch.indexOf(header);
  assert.ok(start >= 0, `${header} is in ArdiaFreezeWatch.mm`);
  const end = watch.indexOf(closer, start);
  return watch.slice(start, end < 0 ? watch.length : end);
};

test("a loop that wakes with sharing off reads no GC time, but still times the stretch for the local record", () => {
  const activity = body("void LoopActivity(");
  const wake = activity.slice(activity.indexOf("if (activity == kCFRunLoopAfterWaiting) {"), activity.indexOf("return;\n  }\n  ", activity.indexOf("kCFRunLoopAfterWaiting")));
  assert.match(wake, /const uint64_t epoch = gEpoch\.load\(/);
  assert.match(wake, /const GcReading gc = epoch && js && watch\.depth == 1 \? ReadGc\(watch\.runtime\) : GcReading\(\);/, "GC time is read only with a consent epoch");
  assert.match(wake, /watch\.stretch\.start\.store\(now,/, "the watchdog and the local record, kept whether or not sharing is on, need every stretch timed");
  assert.match(wake, /watch\.epochAtStart = epoch;/, "the stretch carries its epoch so tallies and app_freeze drop it when sharing was off");
});

test("a stall is tallied only under the epoch it started in", () => {
  const record = body("void RecordStall(");
  assert.match(record, /if \(epoch && epoch == gEpoch\.load\(\)\)/);
});

test("the first input during a JS busy span is kept however many inputs follow it", () => {
  const note = body("void ArdiaFreezeNoteInput(");
  assert.match(note, /gJsFirstInputMs\.compare_exchange_strong\(noInputYet, eventMs,/, "only the first input of the span is stored");
  const activity = body("void LoopActivity(");
  assert.match(activity, /if \(js\) gJsFirstInputMs\.store\(-1,/, "a new span forgets the last span's first input");
  assert.match(activity, /gJsFirstInputMs\.exchange\(-1,/, "a span that ends takes its first input");
  assert.match(activity, /FirstInputWaitMs\(TicksToMs\(start\), endMs, earliestInputMs\)/);
  assert.ok(activity.indexOf("gJsFirstInputMs.exchange(-1,") < activity.indexOf("if (!start) return;"), "the first input is taken even when the span had no start");
  const first = body("double FirstInputWaitMs(");
  assert.match(first, /double first = earliestMs >= startMs && earliestMs <= endMs \? earliestMs : -1;/, "the kept first input counts when it falls in the span");
});
