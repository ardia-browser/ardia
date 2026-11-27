import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const probe = read("../ios/ArdiaPaintProbe.mm");
const between = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

test("a later key or seen check leaves a pending blank record and its 2 s follow-up alone", () => {
  const schedule = between(probe, "void SchedulePaintCheck", "\n}\n");
  assert.doesNotMatch(schedule, /SendHeldPaintRecord/);
  const check = between(probe, "void CheckPainting", "\n}\n");
  assert.ok(check.indexOf("SendHeldPaintRecord(watch, nil);") < check.indexOf("watch->_held = record;"), "only a new record flushes the one before it");
  assert.match(check, /const unsigned long due = watch->_followUp\.Hold\(\);/);
  assert.match(check, /current->_followUp\.Take\(due\)\) CheckStillUnpainted\(checked\)/);
  assert.doesNotMatch(check, /_generation == generation\) CheckStillUnpainted/);
  assert.match(between(probe, "void SendHeldPaintRecord", "\n}\n"), /watch->_followUp\.Drop\(\);/);
});

test("a clean 2 s follow-up closes the episode, so the window's next blank check opens a new one", () => {
  const still = between(probe, "void CheckStillUnpainted", "\n}\n");
  const settle = still.indexOf("watch->_episode.Settle(still);");
  assert.ok(settle >= 0 && settle < still.indexOf("SendHeldPaintRecord(watch, @{"), "the episode is settled from the follow-up's own tally");
});

test("a lent page counts as showing only when it is drawn over the holder's own page or that page isn't shown", () => {
  const reasons = between(probe, "- (unsigned)paintProbeReasons {", "\n}\n");
  assert.match(reasons, /state\.standInShowing = ardia_paint_probe::StandInShows\(layer\);/);
  assert.match(reasons, /layer\.abovePage = ardia_paint_probe::DrawnAbove\(/);
  assert.doesNotMatch(reasons, /standInShowing = lent && lent\.superview == self && !lent\.hidden/);
});

test("hidden or fully transparent branches never count as a shown WebKit or Chromium tab", () => {
  const collect = between(probe, "void CollectShownTabs", "\n}\n");
  assert.match(collect, /if \(ardia_paint_probe::Invisible\(child\.hidden, child\.alphaValue, child\.layer \? child\.layer\.opacity : 1\)\) continue;/);
});

test("holding another view's page and lending this view's own page keep separate start times", () => {
  const standIn = read("../ios/ArdiaWebView+StandIn.mm");
  const header = read("../ios/ArdiaWebViewInternal.h");
  assert.match(header, /CFTimeInterval heldSince\{\};\n\s+CFTimeInterval lentSince\{\};/);
  assert.doesNotMatch(header + standIn + probe, /lentAt/);
  const clear = between(standIn, "- (void)clearStandIn", "\n}\n");
  assert.match(clear, /_standIn\.heldSince = 0;/);
  assert.doesNotMatch(clear, /_standIn\.lentSince = 0;\n\s+_standIn\.generation/);
  assert.match(clear, /lender->_standIn\.lentTo = nil;\n\s+lender->_standIn\.lentSince = 0;/);
  const held = between(probe, "- (unsigned)paintProbeHeldMs {", "\n}\n");
  assert.match(held, /holding \? _standIn\.heldSince : 0, lending \? _standIn\.lentSince : 0/);
});
