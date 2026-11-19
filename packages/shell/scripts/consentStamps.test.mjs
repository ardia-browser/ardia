import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const IOS = new URL("../ios/", import.meta.url);
const read = (name) => readFileSync(new URL(name, IOS), "utf8");
const COUNTED = ["centeredResize", "windowTitleRead", "windowDragLoop", "fileDropRefused"];

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

test("a window drag loop is stamped as it begins, before the loop runs", () => {
  const move = read("WindowMove.swift");
  const begin = move.indexOf('ShellEvents.send(.app, ArdiaConsentStamp.begin().onto(["type": "windowDragLoop"]))');
  assert.ok(begin > 0 && begin < move.indexOf("let start = screenPoint(event)"), "the drag loop is reported with the epoch from its start");
});

test("a file drag a drop area refuses is reported with its area kind only, and only when the drag holds files", () => {
  const drop = read("FileDropView.swift");
  const refused = drop.indexOf("if !DroppedLinks.fileURLs(sender.draggingPasteboard).isEmpty {");
  const sent = drop.indexOf('ShellEvents.send(.app, ArdiaConsentStamp.begin().onto(["type": "fileDropRefused", "phase": "refused", "area": accepts]))');
  assert.ok(refused > 0 && sent > refused && sent - refused < 200, "the report is gated on the drag holding file URLs");
  assert.ok(drop.lastIndexOf("guard count > 0 else {", sent) > 0 && drop.indexOf("return []", sent) > sent, "it is reported where the drag is refused, which still returns no operation");
  const reports = drop.split("\n").filter((line) => line.includes("fileDropRefused"));
  assert.equal(reports.length, 1);
  assert.match(reports[0], /\.onto\(\["type": "fileDropRefused", "phase": "refused", "area": accepts\]\)\)$/, "the body is the kind of area and nothing about the files");
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
