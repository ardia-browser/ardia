import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const read = (name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

const log = read("../ios/ArdiaPiPGestureLog.mm");
const logHeader = read("../ios/ArdiaPiPGestureLog.h");
const pip = read("../ios/ArdiaPictureInPicture.mm");
const swipe = read("../ios/ArdiaPiPController+Swipe.mm");
const routing = read("../ios/ArdiaPiPZoom+Routing.mm");
const zoom = read("../ios/ArdiaPiPZoom.mm");
const webView = read("../ios/ArdiaWebView+PictureInPicture.mm");
const host = read("../ios/ArdiaHost.mm");
const internal = read("../ios/ArdiaPictureInPictureInternal.h");
const domain = read("../src/engineDomain.ts");
const commands = read("../../../apps/browser/src/state/commands/appCommands.ts");

const body = (source, signature) => {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} exists`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${signature} has no end`);
};

const GATES = /traced:|TracingPictureInPicture|testInstance|ardia_host::Background\(\)/;

const gatedAround = (source, at) => {
  const before = source.slice(Math.max(0, source.lastIndexOf("\n", at - 1) - 400), at);
  const opened = before.lastIndexOf("{");
  const line = source.slice(source.lastIndexOf("\n", at - 1) + 1, at);
  return GATES.test(line) || (opened >= 0 && GATES.test(before.slice(before.lastIndexOf("\n", opened - 1), opened)));
};

test("the log is a bounded in-memory ring with a clock, joined for the reader, never written to disk or a trace", () => {
  assert.match(logHeader, /void NoteGesture\(NSString \*format, \.\.\.\) NS_FORMAT_FUNCTION\(1, 2\);/);
  assert.match(logHeader, /NSString \*GestureLog\(\);/);
  assert.match(log, /constexpr NSUInteger kGestureLogLength = 60;/);
  const note = body(log, "void NoteGesture(NSString *format, ...)");
  assert.match(note, /HH:mm:ss\.SSS/);
  assert.match(note, /if \(lines\.count > kGestureLogLength\) \[lines removeObjectAtIndex:0\];/);
  assert.doesNotMatch(log, GATES);
  assert.doesNotMatch(log, /writeTo|NSFileManager|NSLog|NSUserDefaults|URLSession|emit:/);
  assert.match(body(log, "NSString *GestureLog()"), /componentsJoinedByString:@"\\n"/);
  assert.match(internal, /#import "ArdiaPiPGestureLog\.h"/);
});

test("every Picture in Picture gesture path notes itself outside any trace or test-instance gate", () => {
  const notes = [
    [pip, "press window=%ld clicks=%ld appActive=%d key=%d"],
    [pip, '@"edge resize"'],
    [pip, '@"passed: "'],
    [pip, "release window=%ld travel=%.0f click=%d skip=%+.0f handle=%d"],
    [pip, "other-app pinch monitor off appActive=%d zoomOn=%d zoomable=%d"],
    [pip, 'other-app pinch monitor %@", gOtherAppPinchMonitor ? @"on"'],
    [pip, "activate with only PiP asked (%@) window=%ld"],
    [pip, "activation outcome (%@) becameActive=%d activeNow=%d"],
    [pip, "activation refused: bring forward"],
    [pip, "active only for PiP ended: %@"],
    [pip, "activate app: %@ fromOtherApp=%d"],
    [pip, "Back to Tab from Chrome's button window=%ld"],
    [pip, "video window=%ld size="],
    [pip, "document window=%ld size="],
    [swipe, 'swipe %@ window=%ld appActive=%d'],
    [swipe, "swipe %@ window=%ld steps=%ld travel="],
    [swipe, "swipe momentum window=%ld"],
    [swipe, "swipe settled window=%ld outcome=%@ how=%@"],
    [routing, "pinch began fromOtherApp=%d appActive=%d eventWindow=%ld monitor=%d"],
    [routing, "pinch %@ fromOtherApp=%d window=%ld steps=%ld magnification="],
    [routing, "command-scroll zoom began window=%ld"],
    [routing, "command-scroll zoom ended window=%ld steps=%ld"],
    [routing, "command-wheel zoom window=%ld"],
    [zoom, "edge resize ended window=%ld size="],
    [webView, 'pip %@ kind=%@ by=%@ auto=%d appActive=%d'],
  ];
  for (const [source, text] of notes) {
    const at = source.indexOf(text);
    assert.ok(at >= 0, `the log notes ${text}`);
    assert.ok(!gatedAround(source, at), `${text} is written outside any gate`);
  }
});

test("the press note runs on every press of a PiP window, before the activation it leads to", () => {
  const drag = body(pip, "void InstallDragMonitor()");
  const edge = drag.indexOf('NotePress(window, event, @"edge resize");');
  assert.ok(edge >= 0 && edge < drag.indexOf("ActivateWithOnlyPictureInPicture(pressed, NO);"));
  const grab = drag.indexOf("if (pressed) NotePress(window, event, passes ?");
  assert.ok(grab >= 0 && grab < drag.indexOf("if (!grabbed) return event;") && grab < drag.indexOf("ActivateWithOnlyPictureInPicture(grabbed, NO);"));
  assert.match(drag, /ArdiaPiPController \*grabbed = passes \? nil : pressed;/);
  for (const why of ["control held", "double click", "resize edge", "Chrome control"]) assert.ok(body(pip, "NSString *WhyPressPasses(").includes(`@"${why}"`));
});

test("activation notes cover the ask, the test-instance refusal, the bring-forward refusal, the outcome and each end", () => {
  const activation = body(pip, "void ActivateWithOnlyPictureInPicture(");
  assert.ok(activation.indexOf("activate with only PiP asked") < activation.indexOf("gActivations++"));
  assert.match(activation, /if \(ardia_host::Background\(\)\) \{\s*NoteGesture\(@"activation refused: test instance"\);/);
  assert.match(activation, /EndActiveOnlyForPictureInPicture\(@"still inactive after the wait"\);\s*NoteGesture\(@"activation outcome/);
  const watch = body(pip, "static void WatchActiveOnlyForPictureInPicture()");
  assert.match(watch, /EndActiveOnlyForPictureInPicture\(@"resigned active"\)/);
  assert.match(watch, /EndActiveOnlyForPictureInPicture\(@"another window became key"\)/);
  assert.ok(body(pip, "BOOL ActivateApp(NSString *why)").indexOf("NoteGesture(") < body(pip, "BOOL ActivateApp(NSString *why)").indexOf("if (ardia_host::Background())"));
  const back = body(pip, "BOOL TabRequestedActivation(");
  assert.ok(back.indexOf("NoteGesture(") < back.indexOf("if (window.hasShadow) continue;"));
});

test("swipes note their start, the ones not taken and why, the end with step count and travel, momentum and the settle", () => {
  const handle = body(swipe, "+ (BOOL)handleSwipe:(NSEvent *)event");
  for (const why of ["throw off", "not precise", "command held"]) assert.ok(handle.includes(`@"${why}"`));
  assert.ok(handle.indexOf("NoteGesture(@\"swipe %@ window=%ld appActive=%d\"") < handle.indexOf("if (passes) return NO;"));
  assert.match(handle, /gSwipeSteps\+\+;/);
  assert.match(handle, /swipe momentum window=%ld/);
  assert.ok(body(swipe, "- (void)swipeSettledAt:").includes("swipe settled"));
});

test("pinches are logged at their beginning and end only, local and from other apps, with where they went", () => {
  const handle = body(routing, "+ (BOOL)handle:(NSEvent *)event fromOtherApp:(BOOL)fromOtherApp {");
  assert.match(handle, /if \(pinch\) \[self logPinch:event handled:handled routedTo:gSeenPinches != seenBefore \? gSeenRoutedTo : 0 fromOtherApp:fromOtherApp\];/);
  assert.match(handle, /else if \(handled\) \[self logScrollZoom:event\];/);
  const logPinch = body(routing, "+ (void)logPinch:");
  assert.match(logPinch, /@"held"/);
  assert.match(logPinch, /@"passed"/);
  assert.match(logPinch, /@"zoom off"/);
  assert.match(logPinch, /FollowsPinchesFromOtherApps\(\)/);
  assert.equal((logPinch.match(/NoteGesture\(/g) ?? []).length, 5, "begin, end, an unfinished pinch, and a pinch seen or ended without its start; never a step");
  assert.match(logPinch, /if \(!\(phase & \(NSEventPhaseEnded \| NSEventPhaseCancelled\)\)\) return;/);
  assert.match(body(pip, "void FollowPinchesFromOtherApps()"), /NoteGesture\(@"other-app pinch monitor off/);
  assert.match(body(pip, "void PinchFromOtherApp(NSEvent *event)"), /\[ArdiaPiPZoom handleFromOtherApp:event\]/);
});

test("the log reaches Copy Diagnostics through the engine info, the typed domain and a Picture in Picture gestures block", () => {
  assert.match(host, /#import "ArdiaPiPGestureLog\.h"/);
  assert.match(body(host, "+ (NSDictionary<NSString *, id> *)engineInfo"), /@"pictureInPictureGestures" : ardia_pip::GestureLog\(\),/);
  assert.match(domain, /pictureInPictureGestures\?: string;/);
  assert.match(commands, /engine\?\.pictureInPictureGestures \? \[`Picture in Picture gestures:\\n {2}\$\{engine\.pictureInPictureGestures\.replace\(\/\\n\/g, "\\n {2}"\)\}`\] : \[\]/);
});

test("a pinch whose start went elsewhere is still logged from its first step that arrives, and an end without a start says so", () => {
  const logPinch = body(routing, "+ (void)logPinch:(NSEvent *)event");
  const unopened = logPinch.slice(logPinch.indexOf("if (!gLoggedPinchOpen) {"), logPinch.indexOf("gLoggedPinchSteps++;"));
  assert.match(unopened, /NoteGesture\(@"pinch seen without its start phase=%lu/);
  assert.match(unopened, /NoteGesture\(@"pinch %@ without a start/);
  assert.match(unopened, /gLoggedPinchOpen = YES;/);
  assert.doesNotMatch(logPinch, /if \(!gLoggedPinchOpen\) return;/);
});
