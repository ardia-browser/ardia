import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const IOS = new URL("../ios/", import.meta.url);
const read = (name) => readFileSync(new URL(name, IOS), "utf8");
const COUNTED = ["centeredResize", "windowTitleRead", "windowDragLoop"];

test("every app event JS telemetry counts is sent through a consent stamp", () => {
  for (const name of readdirSync(IOS).filter((n) => n.endsWith(".swift"))) {
    for (const line of read(name).split("\n")) {
      const event = COUNTED.find((e) => line.includes(`"type": "${e}"`) && line.includes("ShellEvents.send"));
      if (event) assert.match(line, /\.onto\(\["type": /, `${name}: ${event} is sent without a consent stamp: ${line.trim()}`);
    }
  }
});

test("an Option resize is stamped when its live resize starts, and the count sends that stamp", () => {
  const resize = read("CenteredResize.swift");
  assert.match(resize, /willStartLiveResizeNotification[^}]*CenteredResize\.stamp = ArdiaConsentStamp\.begin\(\)/s);
  assert.match(resize, /ShellEvents\.send\(\.app, \(stamp \?\? ArdiaConsentStamp\.begin\(\)\)\.onto\(\["type": "centeredResize"\]\)\)/);
});

test("a window drag is stamped as the press begins, before the loop runs, and every drag event carries that stamp", () => {
  const move = read("WindowMove.swift");
  const begin = move.indexOf("let stamp = ArdiaConsentStamp.begin()");
  assert.ok(begin > 0 && begin < move.indexOf("let start = screenPoint(event)"), "the drag is reported with the epoch from its press");
  for (const type of ["windowDragLoop", "windowDragNative", "windowDragTakeover"]) {
    assert.ok(move.includes(`ShellEvents.send(.app, stamp.onto(["type": "${type}"]))`), `${type} is sent with the press's stamp`);
  }
  assert.ok(!/ArdiaConsentStamp\.begin\(\)\.onto\(\["type": "windowDrag/.test(move), "no drag event takes a fresh stamp mid-drag");
});

test("a refused paste carries a consent stamp: the gate's epoch for input held in a hand-off, taken before any hop to the main thread", () => {
  const refusal = read("PasteRefusal.swift");
  assert.match(refusal, /static func report\(_ reason: Refusal, _ details: \[String: Any\] = \[:\], stamp: ArdiaConsentStamp = ArdiaConsentStamp\.begin\(\)\)/);
  assert.match(refusal, /DispatchQueue\.main\.async \{ report\(reason, details, stamp: stamp\) \}/);
  assert.match(refusal, /ShellEvents\.send\(\.app, stamp\.onto\(body\)\)/);
  const handoff = read("FocusHandoff.swift");
  assert.match(handoff, /return refuse\(\.focusLost, held\[index\.\.\.\]\.map\(\\\.input\), since: epoch\)/);
  assert.match(handoff, /refuse\(reason, gone\.map\(\\\.input\), since: gate\.epoch\)/);
  assert.match(handoff, /PasteRefusal\.report\(reason, \["dropped": inputs\.count\], stamp: epoch\.map\(ArdiaConsentStamp\.init\(epoch:\)\) \?\? ArdiaConsentStamp\.begin\(\)\)/);
});

test("a refused edit key and a late acknowledgement report the consent epoch the key arrived in, never the one current at the refusal", () => {
  const handoff = read("FocusHandoff.swift");
  assert.match(handoff, /private let editKeyConsent = NSMapTable<NSEvent, NSString>\(keyOptions: \.weakMemory, valueOptions: \.strongMemory\)/);
  const tagged = handoff.indexOf("self.editKeys.setObject(");
  const stamped = handoff.indexOf("self.editKeyConsent.setObject(ArdiaConsentStamp.begin().epoch as NSString, forKey: event)");
  assert.ok(tagged > 0 && stamped > tagged && stamped - tagged < 300, "the epoch is recorded where the key is tagged on arrival");
  assert.match(handoff, /refuse\(\.lateAcknowledgement, \[\.action\(action\)\], since: consentAtArrival\(of: event\)\)/);
  assert.match(handoff, /refuse\(\.staleEpoch, \[\.key\(event, up: nil\)\], since: consentAtArrival\(of: event\)\)/);
  assert.match(handoff, /private func consentAtArrival\(of event: NSEvent\) -> String \{\s*editKeyConsent\.object\(forKey: event\) as String\? \?\? ""\s*\}/);
});
