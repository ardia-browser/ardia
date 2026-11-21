import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const focusHandoff = readFileSync(new URL("../ios/FocusHandoff.swift", import.meta.url), "utf8");

test("the key epoch moves in step with didBecomeKey, before the next key is tagged", () => {
  const observer = focusHandoff.match(/addObserver\(forName: NSWindow\.didBecomeKeyNotification[^{]*\{/)?.[0];
  assert.ok(observer, "FocusHandoff does not observe didBecomeKey");
  assert.ok(observer.includes("queue: nil"), `${observer} defers the epoch bump to a later turn of the main queue`);
});

test("an edit key's tag and its check read the same KeyEpochs", () => {
  assert.ok(focusHandoff.includes("keyEpochs.becameKey(window.windowNumber)"), "didBecomeKey does not feed KeyEpochs");
  assert.ok(focusHandoff.includes("self.editKeys.setObject([window.windowNumber, self.keyEpochs.epoch(of: window.windowNumber)] as NSArray, forKey: event)"), "the tag must read KeyEpochs");
  assert.ok(focusHandoff.includes("let current = [window.windowNumber, keyEpochs.epoch(of: window.windowNumber)]"), "the check must read KeyEpochs");
  assert.doesNotMatch(focusHandoff, /\bepochs\[/, "nothing reads a second epoch table");
});

test("every edit key a page hands back is counted as accepted or refused, the first after a handback apart", () => {
  const check = focusHandoff.slice(focusHandoff.indexOf("func refusesUnhandledKey"), focusHandoff.indexOf("func takeEditKeyAcks"));
  assert.ok(check.includes("let afterHandback = keyEpochs.takeHandback(of: window.windowNumber)"));
  assert.ok(check.indexOf('countEditKeyAck(afterHandback ? "afterHandbackAccepted" : "accepted")') < check.indexOf("acknowledged = event"), "an accepted key is counted before it goes on");
  assert.ok(check.indexOf('countEditKeyAck(afterHandback ? "afterHandbackRefused" : "refused")') < check.indexOf("refuse(.staleEpoch"), "a refused key is counted where it beeps");
});
