import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runSwiftTests } from "./swift-testing.mjs";

const source = (name) => readFileSync(new URL(`../ios/${name}`, import.meta.url), "utf8");
const body = (text, start) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `${start} is there`);
  const open = text.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return text.slice(from, i + 1);
  }
  assert.fail(`${start} ends`);
};

test("the history gate and the shared notification policy decide as the privacy fixes need", (t) => {
  runSwiftTests(t, "privacy-gates-test", ["../ios/WebKitPrivacyGates.swift", "./webkit-privacy-gates.test.swift"]);
});

test("clearing or deleting a profile's history ends every earlier view's and saved state's history, wherever it is", () => {
  const lifecycle = source("WebKitTab+Lifecycle.swift");
  const cleared = body(lifecycle, "static func cleared(profile: String)");
  assert.ok(cleared.indexOf("gate.advance(profile)") >= 0 && cleared.indexOf("gate.advance(profile)") < cleared.indexOf("endHistory"), "a clear starts a new generation before the folder goes");
  assert.ok(!cleared.includes("scheduleSave"), "a clear never saves the old back lists again");
  const forget = body(lifecycle, "static func forget(profile: String)");
  assert.ok(forget.indexOf("gate.forget(profile)") >= 0 && forget.indexOf("gate.forget(profile)") < forget.indexOf("endHistory"));
  const save = body(lifecycle, "static func saveNow(_ tab: WebKitTab)");
  assert.ok(save.includes("gate.isCurrent(page.generation, profile: tab.profile)"), "a discarded page saves only state from the current generation");
  assert.ok(save.includes("gate.isCurrent(view: view, profile: tab.profile)"), "a view saves only if it was made after the last clear");
  assert.ok(body(lifecycle, "static func take(profile: String, key: String, url: String)").includes("gate.keepsHistory(profile)"));
  assert.ok(body(lifecycle, "private func restoreState(").includes("WebKitTabHistory.isCurrent(generation, profile: self.profile)"), "a restore read before a clear isn't applied after it");
  assert.ok(body(lifecycle, "func wakeDiscarded(").includes("WebKitTabHistory.isCurrent(found.generation"), "waking a discarded tab drops pre-clear state");
  assert.ok(body(lifecycle, "func makeView()").includes("WebKitTabHistory.stamp(view"));
  assert.ok(body(source("WebKitTab.swift"), "func attach(_ view: WebKitWebView)").includes("WebKitTabHistory.stamp(view"));
  assert.ok(source("WebKitTab+DevTools.swift").includes("WebKitTabHistory.stamp(child"), "View Source's view is stamped when it's made, before it loads");
  assert.ok(cleared.includes('endHistory(profile, "cleared", in: directory)') && forget.includes('endHistory(profile, "forgotten", in: directory)'));
  const end = body(lifecycle, "private static func endHistory(");
  assert.ok(end.includes("files.sync") && end.indexOf("UUID()") < end.indexOf("removeAll"), "the marker carries a new epoch, written before the removal, and both finish before the clear returns");
  assert.ok(body(lifecycle, "static func take(profile: String, key: String, url: String)").includes("!survivedClear(saved, profile: profile)"), "a file that outlived a clear is never restored, whatever the clock says");
  assert.ok(body(lifecycle, "private static func survivedClear(").includes('saved["epoch"] as? String != current'));
  assert.ok(body(lifecycle, "static func saveNow(_ tab: WebKitTab)").includes('body["epoch"] = current'), "a save records the epoch it belongs to");
});

test("WebKit's process-wide notification policy follows every profile's decision, and a malformed cookie key list is refused", () => {
  const notifications = source("WebKitNotifications.swift");
  const note = body(notifications, "func note(_ allowed: Bool?, profile: String, origin: String)");
  assert.ok(!note.includes("Self.announce(allowed"), "one profile's answer is never written for every profile");
  assert.ok(notifications.includes("WebKitNotificationPolicy.shared(granted, origin: origin, profiles: profiles)"));
  assert.ok(note.includes("granted[base]?[origin] = nil"), "resetting to Ask drops the old answer");
  assert.ok(note.includes("forgottenProfiles"), "a deleted profile's late answer isn't recorded");
  assert.ok(body(notifications, "func forgetProfile(_ profile: String)").includes("announceShared"), "forgetting a profile recomputes what WebKit is told");
  assert.ok(body(notifications, "func attachWorkers(to store: WKWebsiteDataStore, profile: String)").includes("announceShared"), "a profile that starts using WebKit recomputes what WebKit is told");
  const sites = source("SitesModule.swift");
  assert.ok(body(sites, 'reset: { args, reply in').includes("notifications.refresh"), "Reset to Ask refreshes WebKit's answer");
  assert.ok(body(sites, 'setSetting: { args, reply in').includes("notifications.refresh"));
  assert.match(source("WebKitModule.swift"), /args\.values\["keys"\] == nil \? nil : Set\(try args\.strings\("keys"\)\)/);
});
