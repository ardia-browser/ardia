import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const IOS = new URL("../ios/", import.meta.url);
const read = (name) => readFileSync(new URL(name, IOS), "utf8");
const COUNTED = ["centeredResize", "windowTitleRead", "windowDragLoop", "engineNotificationPresented", "notificationSettings"];

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

test("a notification Chrome posted is counted with the stamp taken as it arrives, and the event holds nothing of the notification", () => {
  const hub = read("NotificationHub.swift");
  const present = hub.slice(hub.indexOf("willPresent notification"), hub.indexOf("didReceive response"));
  assert.ok(present.indexOf("ArdiaConsentStamp.begin()") > 0 && present.indexOf("ArdiaConsentStamp.begin()") < present.indexOf("DispatchQueue.main.async"), "the stamp is taken before the hop to the main thread");
  const sends = present.split("\n").filter((line) => line.includes("ShellEvents.send"));
  assert.equal(sends.length, 1);
  assert.match(sends[0], /stamp\.onto\(\["type": "engineNotificationPresented", "handedToEngine": handedToEngine\]\)/, "only whether Chrome's delegate was handed it is sent");
  assert.doesNotMatch(sends[0], /title|body|identifier|notificationId|userInfo|origin/);
});

test("the notification settings are read once per launch, sent as enum names with a consent stamp, and a send that found no listener is tried again", () => {
  const hub = read("NotificationHub.swift");
  const report = hub.slice(hub.indexOf("func reportSettingsOnce()"), hub.indexOf("func post("));
  assert.match(report, /guard !settingsReported else \{ return \}/);
  assert.match(report, /let stamp = ArdiaConsentStamp\.begin\(\)\s*guard !stamp\.epoch\.isEmpty else \{ return \}/);
  assert.match(report, /settingsReported = ShellEvents\.send\(\.app, stamp\.onto\(\["type": "notificationSettings", "authorization": authorization, "alertSetting": alert, "alertStyle": style\]\)\)/);
  assert.match(report, /Self\.name\(of: settings\.authorizationStatus\)/);
  assert.match(report, /Self\.name\(of: settings\.alertSetting\)/);
  assert.match(report, /Self\.name\(of: settings\.alertStyle\)/);
  assert.match(read("ShellEvents.swift"), /case \.app: NotificationHub\.shared\.reportSettingsOnce\(\)/);
  assert.match(read("FocusModule.swift"), /DispatchQueue\.main\.async \{ NotificationHub\.shared\.reportSettingsOnce\(\) \}/);
});
