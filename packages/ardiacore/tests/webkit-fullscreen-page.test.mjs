import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSwiftTests } from "./swift-testing.mjs";

const read = (name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

test("a WebKit page in full screen stays shown when its tab is hidden, and comes back into the tab it moved to", (t) => {
  runSwiftTests(t, "fullscreen-page-test", ["../ios/WebKitFullscreenPage.swift", "../ios/WebKitAutoPictureInPicture.swift", "./webkit-fullscreen-page.test.swift"]);
});

test("a WebKit tab hides, hands over and takes its page through the full-screen rules", () => {
  const tab = read("../ios/WebKitTab.swift");
  const lifecycle = read("../ios/WebKitTab+Lifecycle.swift");
  const fullscreenPage = read("../ios/WebKitTab+FullscreenPage.swift");
  const updateHidden = tab.match(/func updateHidden\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(updateHidden, "WebKitTab.updateHidden exists");
  assert.match(updateHidden[1], /WebKitFullscreenPage\.hidesPage\(view, in: self, visible: visible\)/);
  assert.doesNotMatch(updateHidden[1], /webView\?\.isHidden = !visible/);
  const relinquish = tab.match(/func relinquish\(\) -> WebKitWebView\? \{([\s\S]*?)\n  \}/)[1];
  const close = tab.match(/func close\(\) \{([\s\S]*?)\n  \}/)[1];
  const attach = tab.match(/func attach\(_ view: WebKitWebView\) \{([\s\S]*?)\n  \}/)[1];
  for (const [name, body] of [["relinquish", relinquish], ["close", close]]) {
    assert.match(body, /letGo\(view\)/, name);
    assert.doesNotMatch(body, /view\.removeFromSuperview\(\)/, name);
  }
  assert.match(attach, /place\(view\)/);
  assert.doesNotMatch(attach, /addSubview\(view\)/);
  assert.match(fullscreenPage, /override func didAddSubview\(_ subview: NSView\) \{\n\s+super\.didAddSubview\(subview\)\n\s+if subview === webView \{ updateHidden\(\) \}/);
  assert.match(lifecycle, /self\?\.fullscreenPageMoved\(v\.fullscreenState\)\n\s+self\?\.fullscreenChanged\(v\.fullscreenState\)/);
  assert.match(fullscreenPage, /view\.fullscreenPlaceholders = WebKitFullscreenPage\.takePlaceholders\(from: self\)/);
  assert.match(fullscreenPage, /WebKitFullscreenPage\.give\(placeholders, to: self\)/);
  for (const name of ["fullscreenMovedWithTab", "fullscreenKeptShown", "fullscreenPageReclaimed"]) assert.match(fullscreenPage, new RegExp(`countFullscreenPage\\("${name}", stamp:`));
});

test("a tab that adopts a page publishes the page's current full-screen state, in or out, without counting an entry", () => {
  const tab = read("../ios/WebKitTab.swift");
  const everything = tab.match(/private func emitEverything\(\) \{([\s\S]*?)\n  \}/)[1];
  assert.match(everything, /publishAdoptedFullscreen\(\)/);
  assert.equal(tab.match(/emitEverything\(\)$/gm)?.length, 2, "both adoption paths (handed over or parked, and offered) publish it");
  const fullscreenPage = read("../ios/WebKitTab+FullscreenPage.swift");
  const publish = fullscreenPage.match(/func publishAdoptedFullscreen\(\) \{([\s\S]*?)\n  \}/)[1];
  assert.match(publish, /let on = WebKitFullscreenPage\.isOn\(view\.fullscreenState\)\n\s+pageMedia\.fullscreen = on\n\s+watchFullscreenSight\(on\)\n\s+emit\("fullscreen", \["fullscreen": on\]\)/);
  assert.doesNotMatch(publish, /webKit\.counted|countFullscreenPage/);
});

test("a page held in full screen counts as seen, so hiding its tab opens no automatic Picture in Picture", () => {
  const sight = read("../ios/WebKitTab+AutoPictureInPicture.swift");
  assert.match(sight, /return WebKitFullscreenPage\.seen\(visible: visible, heldInFullscreen: pageHeldInFullscreen, windowSeen: ArdiaChromeWindowHost\.userSees\(window\), fullscreenWindowSeen: fullscreenWindowSeen\)/);
  const held = read("../ios/WebKitTab+FullscreenPage.swift");
  assert.match(held, /return window\.occlusionState\.contains\(\.visible\)/);
  assert.match(held, /forName: NSWindow\.didChangeOcclusionStateNotification/);
  assert.match(held, /watchFullscreenSight\(WebKitFullscreenPage\.isOn\(state\)\)/);
  assert.match(held, /watchFullscreenSight\(on\)/);
  assert.match(read("../ios/WebKitTab.swift"), /if closed \{ stopWatchingSight\(\); watchFullscreenSight\(false\) \}/);
  const discard = read("../ios/WebKitTab.swift").match(/func dropViewForDiscard\(\) -> WebKitWebView\? \{([\s\S]*?)\n  \}/)[1];
  assert.ok(discard.indexOf("watchFullscreenSight(false)") >= 0 && discard.indexOf("watchFullscreenSight(false)") < discard.indexOf("webView = nil"), "a discarded page stops the full-screen sight watch before the view is dropped");
  assert.match(read("../ios/WebKitTab+FullscreenPage.swift"), /updateHidden\(\)\n\s+updateSight\(\)/);
});

test("WebKit's placeholder registration follows the placeholder from window to window", () => {
  const tab = read("../ios/WebKitTab.swift");
  assert.match(read("../ios/WebKitTab+FullscreenPage.swift"), /override func viewWillMove\(toWindow newWindow: NSWindow\?\) \{\n\s+placeholdersWillLeave\(window\)/);
  assert.match(tab, /override func viewDidMoveToWindow\(\) \{\n\s+super\.viewDidMoveToWindow\(\)\n\s+placeholdersDidArrive\(in: window\)/);
  const page = read("../ios/WebKitFullscreenPage.swift");
  assert.match(page, /"registerScrollViewSeparatorTrackingAdapter:"/);
  assert.match(page, /"unregisterScrollViewSeparatorTrackingAdapter:"/);
  assert.match(page, /window\.responds\(to: registerAdapter\)/);
  assert.match(page, /typealias RegisterAdapter = @convention\(c\) \(AnyObject, Selector, AnyObject\) -> ObjCBool/);
  assert.match(page, /typealias UnregisterAdapter = @convention\(c\) \(AnyObject, Selector, AnyObject\) -> Void/);
  assert.doesNotMatch(page, /\.perform\(/);
});

test("a deferred reclaim keeps the page, the exit and the consent period it was scheduled with", () => {
  const fullscreenPage = read("../ios/WebKitTab+FullscreenPage.swift");
  const moved = fullscreenPage.match(/func fullscreenPageMoved\([^)]*\) \{([\s\S]*?)\n  \}/)[1];
  const ticketAt = moved.indexOf("WebKitFullscreenReclaim(generation: exit, epoch: ArdiaEvents.consentEpoch, page: webView)");
  assert.ok(ticketAt >= 0 && ticketAt < moved.indexOf("asyncAfter"), "the ticket is taken before the reclaim is deferred");
  const reclaim = fullscreenPage.match(/private func reclaimPage\([^)]*\) \{([\s\S]*?)\n  \}/)[1];
  assert.match(reclaim, /ticket\.belongs\(to: life\.fullscreenExits\.generation, page: view\)/);
  assert.match(reclaim, /guard ticket\.counts\(under: ArdiaEvents\.consentEpoch\) else \{ return \}/);
  assert.match(reclaim, /stamp: ArdiaConsentStamp\(epoch: ticket\.epoch\)/);
  assert.doesNotMatch(reclaim, /ArdiaConsentStamp\.begin/);
});
