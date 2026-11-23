import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const move = readFileSync(new URL("../ios/WindowMove.swift", import.meta.url), "utf8");

test("on macOS 27.2+ a window drag asks macOS first and only falls back to Ardia's own loop", () => {
  const swizzle = move.slice(move.indexOf("let block: @convention(block) (NSWindow, NSEvent) -> Void"), move.indexOf("method_setImplementation(method, imp_implementationWithBlock(block))"));
  const asks = swizzle.indexOf("WindowMove.asksWindowServer(window, from: event)");
  const follows = swizzle.indexOf("WindowMove.follow(window, from: event)");
  assert.ok(asks > 0 && asks < follows, "the press asks the window server before Ardia moves the window itself");
  assert.match(swizzle, /if WindowMove\.askingWindowServer \{ return original\(window, selector, event\) \}/);
});

test("every press the app dispatches is recorded, so a completion knows whether its press is still the latest", () => {
  assert.match(move, /NSEvent\.addLocalMonitorForEvents\(matching: \.leftMouseDown\) \{ event in\s*notePress\(event\)\s*return event\s*\}/);
  assert.match(move, /latestPressAt = max\(latestPressAt \?\? event\.timestamp, event\.timestamp\)/);
  const swizzle = move.slice(move.indexOf("let block: @convention(block) (NSWindow, NSEvent) -> Void"), move.indexOf("method_setImplementation(method, imp_implementationWithBlock(block))"));
  assert.match(swizzle, /WindowMove\.notePress\(event\)/);
  assert.match(move, /_ = WindowMove\.pressWatch/);
});

test("a completion is bound to its own press: a newer press, dispatched or still queued, makes it stale and it counts as neither", () => {
  const asking = move.slice(move.indexOf("static func asksWindowServer"), move.indexOf("static func follow"));
  assert.match(move, /NSSelectorFromString\("performWindowDragWithEvent:completionHandler:"\)/);
  assert.match(asking, /let pressedAt = event\.timestamp/);
  assert.match(asking, /let outcome = WindowDragTakeover\.outcome\(pressedAt: pressedAt, latestPressAt: latestPressAt, queuedPressAt: nil, held: NSEvent\.pressedMouseButtons & 1 != 0\)/);
  assert.match(asking, /switch outcome \{/);
  assert.match(asking, /case \.stale:\s*return/);
  assert.match(asking, /case \.native:\s*ShellEvents\.send\(\.app, stamp\.onto\(\["type": "windowDragNative"\]\)\)/);
  assert.match(
    asking,
    /DispatchQueue\.main\.async \{\s*guard let window,\s*WindowDragTakeover\.outcome\(pressedAt: pressedAt, latestPressAt: latestPressAt, queuedPressAt: queuedPressAt\(\), held: true\) == \.takeOver\s*else \{ return \}/,
  );
  assert.match(move, /NSApp\.nextEvent\(matching: \.leftMouseDown, until: \.distantPast, inMode: \.eventTracking, dequeue: false\)\?\.timestamp/);
  assert.ok(!/lastHardwareDown|secondsSinceLastEventType/.test(move), "no wall-clock guess at which press is current");
  assert.ok(!/completed/.test(asking), "the handler's completed flag is true even for a drag macOS never began, so nothing reads it");
  assert.ok(!asking.includes("announceDrag"), "a press handed to macOS announces nothing: AppKit's willMove covers a real move, and a click must not stop Little Ardia's landing fit");
});

test("Ardia's loop consumes only events of its own press: an older event ends it, as a new press does", () => {
  const follow = move.slice(move.indexOf("static func follow"), move.indexOf("private static let gestureEvents"));
  assert.match(follow, /if !WindowDragTakeover\.belongs\(eventAt: next\.timestamp, pressedAt: event\.timestamp\) \|\| next\.type != \.leftMouseDragged \|\| next\.windowNumber != window\.windowNumber \{\s*NSApp\.postEvent\(next, atStart: true\)\s*return true\s*\}/);
});

test("a takeover anchors on the window's origin from the press, taken before macOS is asked to drag", () => {
  const asking = move.slice(move.indexOf("static func asksWindowServer"), move.indexOf("static func follow"));
  const origin = asking.indexOf("let pressOrigin = window.frame.origin");
  assert.ok(origin > 0 && origin < asking.indexOf("dragWithCompletion(window, dragWithCompletionSelector, event)"), "the origin is read before the native drag can move the window");
  assert.match(asking, /follow\(window, from: event, stamp: stamp, anchoredAt: pressOrigin, countsTakeover: true\)/);
  const follow = move.slice(move.indexOf("static func follow"), move.indexOf("private static let gestureEvents"));
  assert.match(follow, /let origin = anchoredAt \?\? window\.frame\.origin/);
  assert.match(move, /WindowDragTakeover\.anchoredOrigin\(origin: origin, press: start, pointer: pointer\)/);
});

test("a takeover is counted as soon as Ardia's loop admits the window, not before and not when the drag ends", () => {
  const asking = move.slice(move.indexOf("static func asksWindowServer"), move.indexOf("static func follow"));
  assert.match(asking, /_ = follow\(window, from: event, stamp: stamp, anchoredAt: pressOrigin, countsTakeover: true\)/);
  assert.ok(!asking.includes('"windowDragTakeover"'), "asksWindowServer never counts a takeover itself");
  const follow = move.slice(move.indexOf("static func follow"), move.indexOf("private static let gestureEvents"));
  const guardEnd = follow.indexOf("else { return false }");
  const sent = follow.indexOf('if countsTakeover { ShellEvents.send(.app, stamp.onto(["type": "windowDragTakeover"])) }');
  assert.ok(guardEnd > 0 && sent > guardEnd && sent < follow.indexOf("while window.isVisible"), "counted after the guard admits the window and before the loop runs");
});

test("a press the window server owns in the title bar announces nothing, so a click there keeps Little Ardia's landing fit", () => {
  assert.match(move, /if WindowMove\.windowServerMoves\(window, from: event\) \{ return \}/);
});

test("a drag Ardia moves counts once, on its first real placement", () => {
  const follow = move.slice(move.indexOf("static func follow"), move.indexOf("private static let gestureEvents"));
  assert.match(follow, /if !announced \{\s*announced = true\s*announceDrag\(of: window\)\s*ShellEvents\.send\(\.app, stamp\.onto\(\["type": "windowDragLoop"\]\)\)/);
  assert.equal(follow.match(/windowDragLoop/g).length, 1);
});
