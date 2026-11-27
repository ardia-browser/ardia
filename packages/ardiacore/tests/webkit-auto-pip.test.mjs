import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runSwiftTests } from "./swift-testing.mjs";
import { runInNewContext } from "node:vm";
import { webKitPageScript } from "./webkit-page-source.mjs";
import { HOSTILE_STRINGS, HOSTILE_VALUES } from "../../../scripts/security/hostile-inputs.mjs";

const path = (name) => fileURLToPath(new URL(name, import.meta.url));
const sources = [
  "../ios/WebKitTab.swift",
  "../ios/WebKitTab+AutoPictureInPicture.swift",
  "../ios/WebKitTab+PageTab.swift",
  "../ios/WebKitWebView.swift",
  "../ios/WebKitAutoPictureInPicture.swift",
  "../ios/WebKitTab+Lifecycle.swift",
  "../ios/ArdiaChromeWindowHost.h",
  "../ios/ArdiaChromeWindowHost.mm",
  "./webkit-auto-pip.test.swift",
];
const read = (name) => (existsSync(path(name)) ? readFileSync(path(name), "utf8") : "");
const tab = read("../ios/WebKitTab.swift");
const sight = read("../ios/WebKitTab+AutoPictureInPicture.swift");
const lifecycle = read("../ios/WebKitTab+Lifecycle.swift");
const pageTab = read("../ios/WebKitTab+PageTab.swift");
const webView = read("../ios/WebKitWebView.swift");
const windowHostHeader = read("../ios/ArdiaChromeWindowHost.h");
const windowHost = read("../ios/ArdiaChromeWindowHost.mm");

function pageWithVideos(videos, shown = {}, parent = null) {
  const noop = () => {};
  const document = {
    readyState: "complete",
    addEventListener: noop,
    removeEventListener: noop,
    querySelectorAll: (selector) => (selector === "video" ? videos.slice() : []),
    dispatchEvent: () => true,
    pictureInPictureElement: null,
    body: null,
    documentElement: {},
    ...shown,
  };
  const window = { document, addEventListener: noop, location: { protocol: "https:", origin: "https://example.test" }, navigator: {}, performance: { now: () => 0 }, setTimeout: noop, requestAnimationFrame: noop, EventTarget: class { addEventListener() {} } };
  window.window = window;
  window.parent = parent ?? window;
  window.top = parent ? (parent.top ?? parent) : window;
  runInNewContext(webKitPageScript.replace("\\#(WebKitMediaFaults.sitesJSON)", "[]"), window);
  return window.__ardia;
}

function video(name, { paused, ended = false, width = 640, height = 360 }) {
  const v = { name, paused, ended, clientWidth: width, clientHeight: height, webkitPresentationMode: "inline", entered: false };
  v.webkitSupportsPresentationMode = (mode) => mode === "picture-in-picture";
  v.webkitSetPresentationMode = (mode) => {
    v.webkitPresentationMode = mode;
    v.entered = mode === "picture-in-picture";
  };
  return v;
}

test("every source the checks read exists", () => {
  const missing = sources.filter((name) => !existsSync(path(name)));
  assert.deepEqual(missing, []);
});

test("WebKit tabs keep the autoPictureInPicture flag instead of a stub that reads false", () => {
  assert.doesNotMatch(pageTab, /var autoPictureInPicture\b[^\n]*get \{ false \}/);
  assert.match(tab, /^ {2}var autoPictureInPicture = false \{ didSet \{ autoPictureInPictureInputsChanged\(\) \} \}$/m);
});

test("WebKit tabs follow the user's sight of their window the way Chromium views do", () => {
  assert.match(sight, /return WebKitFullscreenPage\.seen\(visible: visible, heldInFullscreen: pageHeldInFullscreen, windowSeen: ArdiaChromeWindowHost\.userSees\(window\), fullscreenWindowSeen: fullscreenWindowSeen\)/);
  assert.match(sight, /forName: (?:NSNotification\.Name\.)?ArdiaWindowSeenDidChange, object: window/);
  assert.match(sight, /return !playingFrames\.isEmpty \|\| view\.cameraCaptureState == \.active \|\| view\.microphoneCaptureState == \.active/);
  assert.match(sight, /playing: playsMedia\)/);
  const movedStart = tab.indexOf("override func viewDidMoveToWindow() {");
  assert.ok(movedStart >= 0, "viewDidMoveToWindow not found");
  const moved = tab.slice(movedStart, tab.indexOf("\n  }\n", movedStart));
  assert.match(moved, /^ {4}super\.viewDidMoveToWindow\(\)$/m);
  assert.match(moved, /^ {4}if window != nil \{ followInterfaceScale\(\) \}$/m);
  assert.match(moved, /^ {4}watchSight\(\)$/m);
  assert.match(tab, /^ {2}var visible = true \{ didSet \{[^\n]*\bupdateSight\(\)[^\n]*\} \}$/m);
  assert.match(tab, /^ {2}var visible = true \{ didSet \{[^\n]*\bnoteShownChanged\(\)[^\n]*\} \}$/m);
});

test("WebKit tabs report why automatic picture in picture held back, as Chromium views do", () => {
  assert.match(sight, /let kept = seen && ArdiaChromeWindowHost\.userSeesOnlyThroughWindowServer\(window\)/);
  assert.match(sight, /emit\("autoPictureInPictureKept", ArdiaConsentStamp\.begin\(\)\.onto\(\["appSwitch": false\]\)\)/);
  assert.match(sight, /note\.userInfo\?\[Self\.leftAppKey\] as\? Bool\) == true \{ self\?\.noteStayedOnAppSwitch\(\) \}/);
  assert.match(sight, /emit\("autoPictureInPictureKept", ArdiaConsentStamp\.begin\(\)\.onto\(\["appSwitch": true\]\)\)/);
  assert.match(sight, /ArdiaChromeWindowHost\.playsForAutoPictureInPictureHandler = \{ window in/);
  assert.match(windowHostHeader, /\+ \(BOOL\)userSeesOnlyThroughWindowServer:\(nullable NSWindow \*\)window NS_SWIFT_NAME\(userSeesOnlyThroughWindowServer\(_:\)\);/);
  assert.match(read("../ios/ArdiaWebView+PictureInPicture.mm"), /BOOL \(\^webKitPlays\)\(NSWindow \*\) = ArdiaChromeWindowHost\.playsForAutoPictureInPictureHandler;\n\s+return webKitPlays && webKitPlays\(window\);/);
});

test("leaving opens picture in picture and returning closes it through the page's own player call", () => {
  assert.match(sight, /case \.open:[\s\S]*?setPictureInPicture\(true, automatic: true, overFullScreen: autoPictureInPictureRule\.opensOverFullScreen\)/);
  assert.match(sight, /case \.close: setPictureInPicture\(false\) \{ _ in \}/);
  assert.match(sight, /autoPictureInPictureRule\.sight\(seen, userIn: !ArdiaChromeWindowHost\.userInAnotherApp\(\), inline: !pageHeldInFullscreen, enabled: autoPictureInPicture, playing: playsMedia\)/);
});

test("the page's picture in picture reports reach the rule", () => {
  assert.match(tab, /case "pip":\n\s+notePictureInPicture\(dict, frame: frame\)\n/);
  assert.match(sight, /guard let \(active, reported\) = autoPictureInPictureRule\.report\(data, from: frame\) else \{ return \}\n\s+if reported\.closeAgain \{ setPictureInPicture\(false\) \{ _ in \} \}\n\s+if reported\.heldNow \{/);
  assert.match(sight, /\} else if wasHeld && !autoPictureInPictureRule\.heldUntilBack \{\n\s+autoPictureInPictureInputsChanged\(\)/);
});

test("the sight observer is dropped when the window changes or the tab closes or gives its view away", () => {
  assert.match(tab, /private\(set\) var closed = false \{ didSet \{ if closed \{ stopWatchingSight\(\); watchFullscreenSight\(false\) \} \} \}/);
  assert.match(sight, /func watchSight\(\) \{\n\s+stopWatchingSight\(\)/);
  const relinquish = tab.slice(tab.indexOf("func relinquish() -> WebKitWebView? {"), tab.indexOf("\n  }\n", tab.indexOf("func relinquish() -> WebKitWebView? {")));
  assert.match(relinquish, /closed = true/);
});

test("the rule travels with the page view, so a tab that takes the view over still closes the picture in picture its predecessor opened", () => {
  assert.match(webView, /^ {2}var autoPictureInPictureRule = WebKitAutoPictureInPicture\(\)$/m);
  assert.doesNotMatch(tab, /var autoPictureInPictureRule = WebKitAutoPictureInPicture\(\)/);
  assert.match(
    sight,
    /var autoPictureInPictureRule: WebKitAutoPictureInPicture \{\n\s+get \{ webView\?\.autoPictureInPictureRule \?\? WebKitAutoPictureInPicture\(\) \}\n\s+set \{ webView\?\.autoPictureInPictureRule = newValue \}\n\s+\}/,
  );
  const attach = tab.slice(tab.indexOf("func attach(_ view: WebKitWebView) {"), tab.indexOf("private func observe("));
  assert.match(attach, /webView = view\n[\s\S]*\n {4}pushFieldProvider\(\)\n {4}updateSight\(\)\n {2}\}/);
});

test("ArdiaCore's public window host gives Swift the same sight rule as Chromium views", () => {
  assert.match(windowHostHeader, /\+ \(BOOL\)userSeesWindow:\(nullable NSWindow \*\)window NS_SWIFT_NAME\(userSees\(_:\)\);/);
  assert.match(windowHostHeader, /extern NSNotificationName const ArdiaWindowSeenDidChange;/);
  assert.match(windowHost, /\+ \(BOOL\)userSeesWindow:\(NSWindow \*\)window \{\n\s+return \[ArdiaWindowController userSees:window\];/);
});

test("the leave and return rule opens once per leave and closes on return (Swift Testing)", (t) => {
  runSwiftTests(t, "auto-pip-test", ["../ios/WebKitAutoPictureInPicture.swift", "./webkit-auto-pip.test.swift"]);
});

test("automatic picture in picture leaves a paused video where it is", () => {
  const paused = video("paused", { paused: true });
  const ardia = pageWithVideos([paused]);
  assert.equal(ardia.pictureInPicture(true, true), "nothingPlaying");
  assert.equal(paused.entered, false);
  assert.equal(pageWithVideos([]).pictureInPicture(true, true), "nothingPlaying");
});

test("a playing video the page can't pop out is a failure, not nothing playing", () => {
  const stuck = { ...video("stuck", { paused: false }), webkitSupportsPresentationMode: undefined, webkitSetPresentationMode: undefined };
  assert.equal(pageWithVideos([stuck]).pictureInPicture(true, true), false);
  assert.equal(pageWithVideos([video("paused", { paused: true })]).pictureInPicture(true), true);
  assert.equal(pageWithVideos([]).pictureInPicture(true), false);
});

test("automatic picture in picture takes the playing video, not the largest", () => {
  const big = video("big", { paused: true, width: 1280, height: 720 });
  const small = video("small", { paused: false });
  const done = video("done", { paused: false, ended: true, width: 1920, height: 1080 });
  const ardia = pageWithVideos([big, done, small]);
  assert.equal(ardia.pictureInPicture(true, true), true);
  assert.deepEqual([big.entered, done.entered, small.entered], [false, false, true]);
});

test("a picture in picture the user asks for still takes the largest video when none plays", () => {
  const small = video("small", { paused: true });
  const big = video("big", { paused: true, width: 1280, height: 720 });
  const ardia = pageWithVideos([small, big]);
  assert.equal(ardia.pictureInPicture(true), true);
  assert.deepEqual([small.entered, big.entered], [false, true]);
});

test("the tab asks the page for an automatic picture in picture and a manual request stays manual", () => {
  assert.match(tab, /func setPictureInPicture\(_ on: Bool, automatic: Bool = false, overFullScreen: Bool = false, completion: @escaping \(PictureInPictureAnswer\) -> Void\)/);
  assert.match(tab, /completion\(value as\? String == "nothingPlaying" \? \.nothingPlaying : \(value as\? NSNumber\)\?\.boolValue == true \? \.opened : \.failed\)/);
  assert.match(tab, /window\.__ardia\.pictureInPicture\(\\\(on \? "true" : "false"\), \\\(automatic \? "true" : "false"\), \\\(overFullScreen \? "true" : "false"\)\)/);
  assert.match(pageTab, /setPictureInPicture\(true\) \{ completion\(\$0 == \.opened\) \}/);
});

test("a page in its own full screen holds automatic picture in picture, from the moment WebKit starts the move until it ends", () => {
  assert.match(sight, /case \.heldForFullScreen: ArdiaEvents\.emit\("webKit\.counted", data: ArdiaConsentStamp\.begin\(\)\.onto\(\["name": "autoPictureInPictureFullscreenHold"\]\)\)/);
});

test("the page itself refuses an automatic picture in picture while something on it is full screen, and a manual one still opens", () => {
  for (const key of ["fullscreenElement", "webkitFullscreenElement"]) {
    const held = video("held", { paused: false });
    assert.equal(pageWithVideos([held], { [key]: held }).pictureInPicture(true, true), false);
    assert.equal(held.entered, false);
    const asked = video("asked", { paused: false });
    assert.equal(pageWithVideos([asked], { [key]: asked }).pictureInPicture(true), true);
    assert.equal(asked.entered, true);
  }
});

test("a video in a frame stays put when a page above it is full screen, and a frame above it that can't be read doesn't stop it", () => {
  for (const key of ["fullscreenElement", "webkitFullscreenElement"]) {
    const framed = video("framed", { paused: false });
    const top = { document: { [key]: { tagName: "IFRAME" } } };
    top.top = top;
    top.parent = top;
    const middle = { document: {}, top };
    middle.parent = top;
    assert.equal(pageWithVideos([framed], {}, middle).pictureInPicture(true, true), false);
    assert.equal(framed.entered, false);
  }
  const free = video("free", { paused: false });
  const sealed = {};
  Object.defineProperty(sealed, "document", { get() { throw new Error("cross-origin"); } });
  sealed.top = sealed;
  sealed.parent = sealed;
  assert.equal(pageWithVideos([free], {}, sealed).pictureInPicture(true, true), true);
  assert.equal(free.entered, true);
});

test("every sight decision reads the view's own full-screen state, so an adopted view never keeps a stale hold", () => {
  assert.match(sight, /func updateSight\(\) \{\n\s+guard !closed, let window else \{ return \}\n\s+followPageFullScreen\(\)\n/);
  assert.match(sight, /private func followPageFullScreen\(\) \{\n\s+autoPictureInPictureRule\.pageFullScreen\(WebKitFullscreenPage\.isOn\(webView\?\.fullscreenState \?\? \.notInFullscreen\), tab: browserId\)\n\s+\}/);
  assert.match(lifecycle, /private func fullscreenChanged\(_ state: WKWebView\.FullscreenState\) \{\n {4}updateSight\(\)\n/);
});

test("a pop out that slipped ahead of full screen is closed and counted once as held", () => {
  assert.match(sight, /case \.close: setPictureInPicture\(false\) \{ _ in \}/);
  assert.match(sight, /case \.closeHeldForFullScreen:\n\s+setPictureInPicture\(false\) \{ _ in \}\n\s+ArdiaEvents\.emit\("webKit\.counted", data: ArdiaConsentStamp\.begin\(\)\.onto\(\["name": "autoPictureInPictureFullscreenHold"\]\)\)/);
});

test("the tab tells the rule whether its automatic open request actually opened", () => {
  assert.match(sight, /case \.open:\n\s+let stamp = ArdiaConsentStamp\.begin\(\)\n\s+let request = autoPictureInPictureRule\.openRequests\n\s+let view = webView/);
  assert.match(sight, /setPictureInPicture\(true, automatic: true, overFullScreen: autoPictureInPictureRule\.opensOverFullScreen\) \{ \[weak self, weak view\] answer in\n\s+guard let self, let view, !self\.closed, self\.webView === view else \{ return \}\n\s+view\.autoPictureInPictureRule\.answered\(request, opened: answer == \.opened\)/);
  assert.match(sight, /if answer == \.nothingPlaying \{ self\.emit\("autoPictureInPictureKept", stamp\.onto\(\["reason": "nothingPlaying"\]\)\) \}/);
});

test("a video in its own native full screen holds an automatic picture in picture, here or in a page above, and a manual one still opens", () => {
  for (const shown of [{ webkitPresentationMode: "fullscreen" }, { webkitDisplayingFullscreen: true }]) {
    const playing = video("playing", { paused: false });
    const native = Object.assign(video("native", { paused: false }), shown);
    assert.equal(pageWithVideos([playing, native]).pictureInPicture(true, true), false);
    assert.equal(playing.entered || native.entered, false);
    const framed = video("framed", { paused: false });
    const top = { document: { querySelectorAll: () => [Object.assign(video("top", { paused: false }), shown)] } };
    top.top = top;
    top.parent = top;
    assert.equal(pageWithVideos([framed], {}, top).pictureInPicture(true, true), false);
    assert.equal(framed.entered, false);
    const asked = video("asked", { paused: false });
    assert.equal(pageWithVideos([asked, Object.assign(video("other", { paused: true }), shown)]).pictureInPicture(true), true);
    assert.equal(asked.entered, true);
  }
});

test("a pop out the page reports open after full screen cancelled it is closed again", () => {
  assert.match(sight, /if reported\.closeAgain \{ setPictureInPicture\(false\) \{ _ in \} \}/);
});

test("leaving a full-screen Space the page was seen in asks the page to pop out over its full screen, and the page does", () => {
  for (const shown of [{ fullscreenElement: {} }, { webkitFullscreenElement: {} }]) {
    const held = video("held", { paused: false });
    assert.equal(pageWithVideos([held], shown).pictureInPicture(true, true, false), false, "a move into full screen still holds");
    assert.equal(held.entered, false);
    const left = video("left", { paused: false });
    assert.equal(pageWithVideos([left], shown).pictureInPicture(true, true, true), true);
    assert.equal(left.entered, true);
  }
  for (const shown of [{ webkitPresentationMode: "fullscreen" }, { webkitDisplayingFullscreen: true }]) {
    const native = Object.assign(video("native", { paused: false }), shown);
    assert.equal(pageWithVideos([native]).pictureInPicture(true, true, true), true);
    assert.equal(native.entered, true);
  }
});

test("WebKit leaving full screen starts the exit hold, as only entering and in full screen count as on", () => {
  assert.match(read("../ios/WebKitFullscreenPage.swift"), /static func isOn\(_ state: WKWebView\.FullscreenState\) -> Bool \{\n\s+state == \.enteringFullscreen \|\| state == \.inFullscreen\n\s+\}/);
});

test("the tab tells the rule whether its sight is the inline tab or WebKit's full-screen window", () => {
  assert.match(sight, /autoPictureInPictureRule\.sight\(seen, userIn: !ArdiaChromeWindowHost\.userInAnotherApp\(\), inline: !pageHeldInFullscreen, enabled: autoPictureInPicture, playing: playsMedia\)/);
});

function pageReportingPictureInPicture() {
  const listeners = {};
  const reports = [];
  const noop = () => {};
  class HTMLVideoElement {}
  const document = {
    readyState: "complete",
    addEventListener: (type, listener) => (listeners[type] ??= []).push(listener),
    removeEventListener: noop,
    querySelectorAll: () => [],
    dispatchEvent: () => true,
    pictureInPictureElement: null,
    body: null,
    documentElement: {},
  };
  const windowListeners = {};
  const window = {
    document,
    HTMLVideoElement,
    addEventListener: (type, listener) => (windowListeners[type] ??= []).push(listener),
    location: { protocol: "https:", origin: "https://example.test" },
    navigator: {},
    performance: { now: () => 0 },
    setTimeout: noop,
    requestAnimationFrame: noop,
    EventTarget: class { addEventListener() {} },
    webkit: { messageHandlers: { ardia: { postMessage: (m) => m.kind === "pip" && reports.push(m.data.unloaded ? "unloaded" : m.data.active) } } },
  };
  window.window = window;
  window.parent = window;
  window.top = window;
  runInNewContext(webKitPageScript.replace("\\#(WebKitMediaFaults.sitesJSON)", "[]"), window);
  const videoElement = () => Object.assign(new HTMLVideoElement(), { webkitPresentationMode: "inline" });
  const fire = (type, target) => (listeners[type] ?? []).forEach((listener) => listener({ type, target }));
  const present = (target, mode) => ((target.webkitPresentationMode = mode), fire("webkitpresentationmodechanged", target));
  const leave = (persisted = false) => (windowListeners.pagehide ?? []).forEach((listener) => listener({ persisted }));
  return { reports, videoElement, fire, present, leave };
}

test("a second video going full screen while the first stays in picture in picture doesn't report the picture in picture closed", () => {
  const page = pageReportingPictureInPicture();
  const popped = page.videoElement();
  const other = page.videoElement();
  page.present(popped, "picture-in-picture");
  page.fire("enterpictureinpicture", popped);
  page.present(other, "fullscreen");
  page.present(other, "inline");
  page.fire("leavepictureinpicture", other);
  assert.deepEqual(page.reports, [true], "only the video that popped out speaks for the picture in picture");
  page.present(popped, "inline");
  page.fire("leavepictureinpicture", popped);
  assert.deepEqual(page.reports, [true, false], "it closes once, when that video comes back");
});

test("picture in picture moving from one video to another stays open", () => {
  const page = pageReportingPictureInPicture();
  const first = page.videoElement();
  const second = page.videoElement();
  page.present(first, "picture-in-picture");
  page.present(second, "picture-in-picture");
  page.present(first, "inline");
  assert.deepEqual(page.reports, [true, true]);
  page.present(second, "inline");
  assert.deepEqual(page.reports, [true, true, false]);
});

test("a frame leaving with its video still popped out reports an unload, not a close the person made, so the tab never keeps a stale frame", () => {
  for (const persisted of [false, true]) {
    const page = pageReportingPictureInPicture();
    const popped = page.videoElement();
    page.present(popped, "picture-in-picture");
    page.leave(persisted);
    assert.deepEqual(page.reports, [true, "unloaded"]);
    page.leave(persisted);
    assert.deepEqual(page.reports, [true, "unloaded"], "a frame with nothing popped out says nothing");
  }
});

test("the pip report takes only real booleans, rejects anything else whole, and its frame ids stay bounded, whatever a page sends (shared hostile inputs)", (t) => {
  const encode = (text) => Buffer.from(text, "utf8").toString("base64");
  const kind = (value) => (value === true ? "true" : value === false ? "false" : value === undefined ? "missing" : "invalid");
  const values = HOSTILE_VALUES.flatMap(({ value }) => {
    let json;
    try {
      json = JSON.stringify({ v: value }, (_, item) => (typeof item === "string" ? item.toWellFormed() : item));
    } catch {
      return [];
    }
    return json === undefined ? [] : [`("${encode(json)}", "${kind(value)}")`];
  });
  const frames = HOSTILE_STRINGS.map(({ value }) => `"${encode(String(value))}"`);
  const dir = mkdtempSync(join(tmpdir(), "ardia-pip-hostile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "pip-hostile.test.swift");
  writeFileSync(
    source,
    `import Foundation
import Testing

struct PictureInPictureReportHostileInputs {
  let values: [(String, String)] = [${values.join(", ")}]

  func decoded(_ encoded: String) throws -> Any? {
    let object = try JSONSerialization.jsonObject(with: Data(base64Encoded: encoded)!, options: [.fragmentsAllowed]) as! [String: Any]
    return object["v"]
  }

  func awayWithOnePoppedOut() -> WebKitAutoPictureInPicture {
    var rule = WebKitAutoPictureInPicture()
    _ = rule.sight(false, userIn: false, enabled: true, playing: true)
    _ = rule.pictureInPicture(in: "frame", active: true)
    rule.reported(active: true)
    return rule
  }

  @Test func \`booleans are read only from a real true or false\`() throws {
    for (encoded, kind) in values {
      let read = WebKitAutoPictureInPicture.boolean(try decoded(encoded))
      #expect(read == (kind == "true" ? true : kind == "false" ? false : nil))
    }
    #expect(WebKitAutoPictureInPicture.boolean(NSNumber(value: 1)) == nil)
  }

  @Test func \`a payload whose active isn't a real boolean changes nothing\`() throws {
    for (encoded, kind) in values where kind != "true" && kind != "false" {
      var rule = awayWithOnePoppedOut()
      var data: [String: Any] = [:]
      if let value = try decoded(encoded) { data["active"] = value }
      #expect(rule.report(data, from: "frame") == nil)
      #expect(rule.pictureInPictureFrameCount == 1)
      #expect(!rule.heldUntilBack)
      #expect(rule.reportedActive)
    }
    var rule = awayWithOnePoppedOut()
    #expect(rule.report(nil, from: "frame") == nil)
    #expect(rule.pictureInPictureFrameCount == 1)
  }

  @Test func \`a close whose unloaded isn't a real boolean changes nothing, and a missing one is a close the person made\`() throws {
    for (encoded, kind) in values {
      var rule = awayWithOnePoppedOut()
      var data: [String: Any] = ["active": false]
      if let value = try decoded(encoded) { data["unloaded"] = value }
      let result = rule.report(data, from: "frame")
      switch kind {
      case "true":
        #expect(result?.active == false && result?.reported.heldNow == false)
        #expect(!rule.heldUntilBack)
      case "false", "missing":
        #expect(result?.active == false && result?.reported.heldNow == true)
        #expect(rule.heldUntilBack)
      default:
        #expect(result == nil)
        #expect(rule.pictureInPictureFrameCount == 1)
        #expect(!rule.heldUntilBack)
        #expect(rule.reportedActive)
      }
    }
  }

  @Test func \`hostile frame ids never grow the frame set past its limit or close another frame's picture in picture\`() {
    var rule = WebKitAutoPictureInPicture()
    #expect(rule.pictureInPicture(in: "real", active: true) == true)
    let frames: [String] = [${frames.join(", ")}]
    for encoded in frames {
      let frame = String(decoding: Data(base64Encoded: encoded)!, as: UTF8.self)
      _ = rule.pictureInPicture(in: frame, active: true)
      #expect(rule.pictureInPicture(in: frame + "-other", active: false) == nil)
    }
    #expect(rule.pictureInPictureFrameCount <= WebKitAutoPictureInPicture.pictureInPictureFrameLimit)
  }
}
`,
  );
  runSwiftTests(t, "pip-hostile-test", ["../ios/WebKitAutoPictureInPicture.swift", source]);
});

test("a dead content process forgets its picture in picture frames without holding the tab", () => {
  assert.match(tab, /resetNowPlaying\(\)\n\s+pictureInPicturePageGone\(\)\n\s+processTerminated\(\)/);
  assert.match(sight, /func pictureInPicturePageGone\(\) \{\n\s+if autoPictureInPictureRule\.pageGone\(\) \{ emit\("pictureInPicture", \["kind": "video", "active": false\]\) \}/);
});

test("the page tab's own Picture in Picture close is marked as asked for, and a failed close is cleared", () => {
  assert.match(pageTab, /func exitPictureInPicture\(\) \{\n\s+autoPictureInPictureRule\.noteRequestedClose\(\)\n\s+let view = webView\n\s+setPictureInPicture\(false\) \{ \[weak self, weak view\] answer in\n\s+guard let self, let view, self\.webView === view, answer == \.failed else \{ return \}\n\s+view\.autoPictureInPictureRule\.requestedCloseFailed\(\)/);
});
