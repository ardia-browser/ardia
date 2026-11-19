import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const body = (source, signature) => {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} is missing`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`${signature} never closes`);
};

const CAPTURE = "../ios/ArdiaWindowCapture.mm";

test("a window that is being captured answers NO to Chrome's isOccluded, and any other window answers as it did", () => {
  assert.ok(existsSync(new URL(CAPTURE, import.meta.url)), "ArdiaWindowCapture.mm holds the shared windows");
  const source = read(CAPTURE);
  assert.match(source, /NSSelectorFromString\(@"isOccluded"\)/);
  assert.match(source, /class_getInstanceMethod\(NSWindow\.class, isOccluded\)/);
  assert.match(source, /method_getImplementation/, "a window nobody shares still asks the original isOccluded");
  assert.match(source, /dispatch_once/, "the swizzle is installed once");
  assert.match(source, /\^BOOL\(NSWindow \*\w+\)/, "the replacement takes the window it is asked about");
});

test("holding a window posts the occlusion notification, so Chrome re-checks at once, and never fakes occlusionState", () => {
  const source = read(CAPTURE);
  assert.match(source, /postNotificationName:NSWindowDidChangeOcclusionStateNotification/);
  assert.doesNotMatch(source, /ActOcclusion/, "ActOcclusion would corrupt ArdiaWindowFullScreen's occlusion bookkeeping");
  assert.doesNotMatch(source, /setImplementation:[^;]*occlusionState/);
});

test("the picker's approval of a window or screen source is kept for the tab, after the engine allows the capture", () => {
  const source = read("../ios/ArdiaWebView+PageMessages.mm");
  const resolve = body(source, "- (void)resolveDisplayMedia:");
  const allow = resolve.indexOf("allowDesktopCapture");
  const kept = resolve.indexOf("ardia_window::ApproveCapture(_tab, sourceId)");
  assert.notEqual(allow, -1);
  assert.notEqual(kept, -1, "resolveDisplayMedia hands the approved source to the tab's hold");
  assert.ok(kept > allow, "a source the engine refused is never kept");
  const capture = read(CAPTURE);
  assert.match(capture, /window:/, "the window id is read from the approved window: source");
  assert.match(capture, /screen:/, "a whole-screen share holds every Ardia window");
});

test("the hold starts when the engine reports the share running and lets go when it ends", () => {
  const site = read("../ios/ArdiaWebView+Site.mm");
  const changed = body(site, "- (void)tab:(ArdiaCoreTab *)tab didChangeMediaAccess:");
  assert.match(changed, /ardia_window::SetCaptureLive\(tab, screen\)/, "the engine's screen flag is the start and the end of a share");
  assert.match(changed, /@"screen"/);
});

test("the hold belongs to the tab, so it follows the page when its view moves to another window", () => {
  const capture = read(CAPTURE);
  assert.match(capture, /weakToStrongObjectsMapTable/, "holds are keyed by the tab, and a tab that is gone takes its hold with it");
  assert.doesNotMatch(capture, /valueWithNonretainedObject/, "no key outlives its owner");

  const view = read("../ios/ArdiaWebView.mm");
  assert.doesNotMatch(body(view, "- (void)dealloc"), /ardia_window::\w*Capture/, "a view going away after a move must not release the live tab's hold");
  assert.doesNotMatch(read("../ios/ArdiaWebViewInternal.h"), /captureSource/, "the source is not per-view state that a move leaves behind");

  const tab = read("../ios/ArdiaWebView+Tab.mm");
  const closing = body(tab, "- (void)tabWillClose:");
  const ended = closing.indexOf("ardia_window::SetCaptureLive(tab, NO)");
  assert.notEqual(ended, -1, "closing the tab lets its windows go");
  assert.ok(ended < closing.indexOf("tab != _tab"), "a tab closing under a view that already let it go still ends its hold");
});

test("a window shared while another share is already running is held too, though the engine's flag did not change", () => {
  const capture = read(CAPTURE);
  const approve = body(capture, "void ApproveCapture(");
  assert.match(approve, /if \(hold\.live && /, "an approval during a live share takes effect at once");
  assert.match(approve, /addObject/, "windows are added to the tab's hold, not swapped for the new one");
  assert.match(approve, /removeAllObjects/, "an approval whose share never started is replaced, not carried");
  const live = body(capture, "void SetCaptureLive(");
  assert.match(live, /if \(!hold\.live\) return/, "a camera or microphone change keeps an approval waiting for its share");
});

test("the hold is declared next to the other window helpers and built with the app", () => {
  const header = read("../ios/ArdiaChromeWindowInternal.h");
  assert.match(header, /ApproveCapture\(ArdiaCoreTab \*tab, NSString \*sourceId\)/);
  assert.match(header, /SetCaptureLive\(ArdiaCoreTab \*tab, BOOL live\)/);
});
