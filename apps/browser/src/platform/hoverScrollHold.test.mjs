import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const patch = readFileSync(new URL("../../../../patches/react-native-macos@0.81.9.patch", import.meta.url), "utf8");

function fileSection(path) {
  const start = patch.indexOf(`diff --git a/${path} b/${path}`);
  if (start === -1) return "";
  const next = patch.indexOf("\ndiff --git ", start + 1);
  return patch.slice(start, next === -1 ? patch.length : next);
}

const lines = fileSection("React/Views/RCTView.m").split("\n");
const added = lines
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1))
  .join("\n");
const patched = lines
  .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" "))
  .map((line) => line.slice(1))
  .join("\n");

const method = (signature) => {
  const start = patched.indexOf(signature);
  assert.notEqual(start, -1, `RCTView.m no longer has ${signature}`);
  return patched.slice(start, patched.indexOf("\n}\n", start) + 3);
};

function holdRule() {
  const start = added.indexOf("typedef struct {\n  double scrolledAt;");
  assert.notEqual(start, -1, "RCTView.m has no ArdiaHoverHold state");
  const holds = added.indexOf("static bool ArdiaHoverHolds(", start);
  return added.slice(start, added.indexOf("\n}\n", holds) + 3);
}

const SETTLE = Number(added.match(/static const CFTimeInterval ArdiaHoverScrollSettle = ([0-9.]+);/)?.[1]);
const STEP = 0.016;

function run(steps) {
  const dir = mkdtempSync(join(tmpdir(), "hover-hold-"));
  const body = steps
    .map(([kind, ...args]) => {
      if (kind === "scroll") return `  hold.scrolledAt = ${args[0]};`;
      if (kind === "decided") return `  ArdiaHoverHoldDecided(&hold, ${args[0]}, ${args[1]});`;
      return `  printf("%d", ArdiaHoverHolds(&hold, ${args[0]}, ${SETTLE}, ${args[1]}, ${args[2]}, ${args[3] ?? true}) ? 1 : 0);`;
    })
    .join("\n");
  const source = `#include <stdbool.h>\n#include <stdio.h>\n${holdRule()}\nint main(void) {\n  ArdiaHoverHold hold = {0};\n${body}\n  return 0;\n}\n`;
  try {
    writeFileSync(join(dir, "rule.c"), source);
    try {
      execFileSync("cc", ["-o", join(dir, "rule"), join(dir, "rule.c")], { stdio: "pipe" });
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    return execFileSync(join(dir, "rule")).toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a still pointer over a list that just scrolled waits, and nothing waits once the scroll pauses or outside the list", (t) => {
  const out = run([
    ["scroll", 10],
    ["decided", 100, 100],
    ["scroll", 10 + STEP],
    ["holds", 10 + STEP + 0.005, 100, 100],
    ["holds", 10 + STEP + 0.005, 100.4, 100],
    ["holds", 10 + STEP + SETTLE + 0.001, 100, 100],
    ["holds", 10 + STEP + 0.005, 100, 100, false],
  ]);
  if (out === null) return t.skip("no C compiler");
  assert.equal(out, "1100");
});

test("a scroll step that lands between a pointer move and its enter can't swallow the move", (t) => {
  const out = run([
    ["scroll", 10],
    ["decided", 100, 100],
    ["scroll", 10 + STEP],
    ["scroll", 10 + 2 * STEP],
    ["holds", 10 + 2 * STEP + 0.001, 130, 100],
  ]);
  if (out === null) return t.skip("no C compiler");
  assert.equal(out, "0", "the enter after the step is measured from where hover was last decided, not from the step");
});

test("slow motion adds up across scroll steps until it lets hover through", (t) => {
  const steps = [["scroll", 10], ["decided", 100, 100]];
  for (let i = 1; i <= 4; i++) steps.push(["scroll", 10 + i * STEP], ["holds", 10 + i * STEP + 0.001, 100 + 0.4 * i, 100]);
  const out = run(steps);
  if (out === null) return t.skip("no C compiler");
  assert.equal(out, "1100", "0.4 pt a step is held twice, then the 1.2 pt it has added up to updates hover");
});

test("hover settles after at most 60 ms of quiet", () => {
  assert.ok(SETTLE > 0 && SETTLE <= 0.06, `settle is ${SETTLE} s`);
});

test("only a scroll's first step sets the anchor hover is measured from, and a step that leaves the list where it was arms nothing", () => {
  const scrolled = method("+ (void)ardia_scrolled:(NSView *)moved");
  assert.match(scrolled, /if \(starts\) \{[^\n]*\n(?:    \/\/[^\n]*\n)?    \[self ardia_hoverDecidedAt:ArdiaHoverPointerSample\];\n  \}/, "the first step anchors on where hover last saw the pointer, and runs no hover check");
  assert.doesNotMatch(scrolled, /ardia_checkHover|anchorX|anchorY/);
  const equal = scrolled.indexOf("NSEqualPoints(");
  assert.ok(equal !== -1 && equal < scrolled.indexOf("ArdiaHoverHoldState.scrolledAt = now"), "the unchanged-origin check must return before the hold is armed");
});

test("only a full hover check and a scroll's first step move the anchor, so every event of one pointer move is measured from the same place", () => {
  assert.match(method("+ (void)ardia_checkHover"), /ardia_hoverDecidedAt:screen/);
  const decides = [...patched.matchAll(/ardia_hoverDecidedAt:/g)].length;
  assert.equal(decides, 3, "ardia_hoverDecidedAt is defined once and called only from ardia_checkHover and a scroll's first step");
  assert.doesNotMatch(method("- (BOOL)ardia_holdHoverForScroll"), /ardia_hoverDecidedAt/);
});

test("a long hold is counted in the consent period it began in, taken under one lock, and never while sharing is off", () => {
  const locked = (text) => {
    const start = text.indexOf("@synchronized(ArdiaHoverHoldLock()) {");
    assert.notEqual(start, -1, "no synchronized block");
    let depth = 0;
    for (let i = text.indexOf("{", start); i < text.length; i++) {
      if (text[i] === "{") depth++;
      if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
    }
    return "";
  };
  const note = locked(method("+ (void)ardia_noteHoverHeld"));
  assert.match(note, /ArdiaHoverHeldSince = CACurrentMediaTime\(\);/, "the hold's start is set under the lock");
  assert.match(note, /ArdiaHoverHeldEpoch = ArdiaHoverConsentEpoch;/, "the hold's epoch is set under the same lock");
  const end = locked(method("+ (void)ardia_endHoverHold"));
  assert.match(end, /epoch = ArdiaHoverHeldEpoch;/);
  assert.match(end, /ArdiaHoverHeldSince = 0;/);
  const take = locked(method("+ (NSDictionary<NSString *, NSDictionary<NSString *, NSNumber *> *> *)ardia_takeHoverCounts"));
  assert.match(take, /\[ArdiaHoverCounts copy\]/, "the counts are copied under the lock");
  assert.match(take, /ArdiaHoverCounts = nil;/, "and reset under it");
  assert.match(method("+ (void)ardia_endHoverHold"), /ardia_countHover:@"holds" epoch:epoch/);
  assert.match(method("+ (void)ardia_countHover:(NSString *)kind epoch:(NSString *)epoch"), /if \(epoch\.length == 0\) \{\n    return;/);
});

test("AppKit tracking stays on the view's bounds, and a waiting enter never rebuilds a tracking area", () => {
  assert.doesNotMatch(added, /NSTrackingInVisibleRect/, "a view's visibleRect runs past its bounds when it doesn't clip (macOS 14+), so a visible-rect area entered views far from the pointer");
  assert.doesNotMatch(added, /NSTrackingMouseMoved/);
  assert.doesNotMatch(method("- (void)ardia_waitForEnter"), /ardia_rearmTrackingArea/);
});

const installed = new URL("../../../../node_modules/react-native-macos/React/Views/RCTView.m", import.meta.url);

const REPLAYED = [
  "+ (void)ardia_scrolled:(NSView *)moved",
  "+ (NSPoint)ardia_pointerOnScreen",
  "+ (BOOL)ardia_holdsHoverInScrolled:(BOOL)inScrolled",
  "+ (void)ardia_hoverDecidedAt:(NSPoint)screen",
  "+ (CFTimeInterval)ardia_movingUntil:(NSView *)view",
  "+ (BOOL)ardia_insideMovingList:(NSView *)view",
  "+ (BOOL)ardia_buttonsPressed",
  "+ (NSArray<RCTView *> *)ardia_byDepth:(NSArray<RCTView *> *)views deepestFirst:(BOOL)deepestFirst",
  "+ (void)ardia_setConsentEpoch:(NSString *)epoch",
  "+ (void)ardia_noteHoverHeld",
  "+ (void)ardia_endHoverHold",
  "+ (NSString *)ardia_consentEpoch",
  "+ (void)ardia_countHover:(NSString *)kind epoch:(NSString *)epoch",
  "+ (NSDictionary<NSString *, NSDictionary<NSString *, NSNumber *> *> *)ardia_takeHoverCounts",
  "+ (void)ardia_checkHover",
  "- (void)ardia_setMouseOver:(BOOL)over atScreenPoint:(NSPoint)screen",
  "- (void)updateTrackingAreas",
  "- (BOOL)ardia_holdHoverForScroll",
  "- (NSTrackingAreaOptions)ardia_trackingOptions",
  "- (void)ardia_rearmTrackingArea",
  "- (void)ardia_rideScrollIfInside",
  "- (void)ardia_waitForEnter",
  "- (void)ardia_stopWaiting",
  "+ (void)ardia_endMoveWatchIfIdle",
  "+ (void)ardia_retryWaitingEnters",
  "- (void)ardia_enterAt:(NSPoint)screen",
  "- (void)ardia_windowChanged",
  "- (void)mouseEntered:(NSEvent *)event",
  "- (void)mouseExited:(NSEvent *)event",
];

const prelude = (settle, realClock) => String.raw`#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
static CFTimeInterval now = 10;
static NSPoint pointer;
static NSUInteger buttons;
${realClock ? "" : "#define CACurrentMediaTime replayTime\nstatic CFTimeInterval replayTime(void) { return now; }"}
static id moveHandler;
static int monitors;
@interface ReplayEvent : NSEvent
+ (id)addLocalMonitorForEventsMatchingMask:(NSEventMask)mask handler:(id)handler;
@end
@implementation ReplayEvent
+ (NSPoint)mouseLocation { return pointer; }
+ (NSUInteger)pressedMouseButtons { return buttons; }
+ (NSEventModifierFlags)modifierFlags { return 0; }
+ (id)addLocalMonitorForEventsMatchingMask:(NSEventMask)mask handler:(id)handler { if (mask == NSEventMaskMouseMoved) { moveHandler = handler; monitors++; } return @"watch"; }
+ (void)removeMonitor:(id)monitor { moveHandler = nil; monitors--; }
@end
#define NSEvent ReplayEvent
typedef void (^RCTDirectEventBlock)(NSDictionary *);
@interface RCTView : NSView {
@public
  BOOL _hasMouseOver;
  BOOL _ardiaEnterWaiting;
  BOOL _ardiaClipCounted;
  __weak NSWindow *_ardiaHoverWindow;
  NSString *_ardiaEnterEpoch;
  NSTrackingArea *_trackingArea;
}
@property (copy) RCTDirectEventBlock onMouseEnter;
@property (copy) RCTDirectEventBlock onMouseLeave;
@property (assign) BOOL inside;
@property (assign) BOOL detached;
@property (nonatomic, weak) NSWindow *placedWindow;
@end
@interface ReplayWindow : NSObject
@end
@implementation ReplayWindow
- (NSPoint)convertPointFromScreen:(NSPoint)point { return point; }
- (NSPoint)convertPointToScreen:(NSPoint)point { return point; }
- (BOOL)isVisible { return NO; }
- (NSMethodSignature *)methodSignatureForSelector:(SEL)selector { return [NSMethodSignature signatureWithObjCTypes:"@@:"]; }
- (void)forwardInvocation:(NSInvocation *)invocation { id nothing = nil; [invocation setReturnValue:&nothing]; }
@end
static NSWindow *replayWindow, *frontWindow;
static NSHashTable *ArdiaHoverViews;
static NSHashTable *ArdiaClippingViews;
static __weak NSView *ArdiaHoverScrolled;
static BOOL ArdiaHoverRidesScroll, ArdiaHoverHeld, ArdiaHoverDirty, ArdiaClipDirty, ArdiaHoverInstalled;
static CFTimeInterval ArdiaHoverWakeAt;
static const CFTimeInterval ArdiaHoverScrollSettle = ${settle};
`;

const STUBS = String.raw`
@implementation RCTView
- (NSWindow *)window { return self.detached ? nil : (self.placedWindow ?: replayWindow); }
+ (NSWindow *)ardia_windowUnderPointer:(NSPoint)screen { return frontWindow ?: replayWindow; }
+ (BOOL)ardia_pointer:(NSPoint)screen isInside:(RCTView *)view { return view.window != nil && view.inside; }
- (void)ardia_clipSubviewsHiding:(BOOL)hiding {}
- (NSDictionary *)locationInfoFromDraggingLocation:(NSPoint)location { return nil; }
- (NSDictionary *)locationInfoFromEvent:(NSEvent *)event { return nil; }
- (void)sendMouseEventWithBlock:(RCTDirectEventBlock)block locationInfo:(NSDictionary *)info modifierFlags:(NSEventModifierFlags)flags additionalData:(NSDictionary *)data
{
  if (block) block(info);
}
`;

const FAKE_WAKE = "+ (void)ardia_markHoverDirty {}\n";
const NO_TRACKING = "- (void)addTrackingArea:(NSTrackingArea *)area {}\n- (void)removeTrackingArea:(NSTrackingArea *)area {}\n";

const SEQUENCES = String.raw`
static RCTView *make(NSView *list, int *enters, int *leaves) {
  NSWindow *window = replayWindow;
  replayWindow = nil;
  RCTView *view = [[RCTView alloc] initWithFrame:NSMakeRect(0, 0, 50, 50)];
  [list addSubview:view];
  replayWindow = window;
  view.onMouseEnter = ^(NSDictionary *i) { (*enters)++; };
  view.onMouseLeave = ^(NSDictionary *i) { (*leaves)++; };
  [view updateTrackingAreas];
  [ArdiaHoverViews addObject:view];
  return view;
}
static void scroll(NSView *list, int x) { list.boundsOrigin = NSMakePoint(x, 0); [RCTView ardia_scrolled:list]; [RCTView ardia_checkHover]; }
int main(void) {
  @autoreleasepool {
    ArdiaHoverViews = [NSHashTable weakObjectsHashTable];
    replayWindow = (NSWindow *)[ReplayWindow new];
    NSView *list = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 200, 200)];
    int enters = 0, leaves = 0;
    RCTView *row = make(list, &enters, &leaves);
    pointer = NSMakePoint(100, 100);
    [RCTView ardia_checkHover];
    row.inside = YES;
    scroll(list, 1);
    [row mouseEntered:nil];
    printf("stillfirst %d %d\n", enters, row->_ardiaEnterWaiting);
    now += 1;
    [RCTView ardia_checkHover];
    row.inside = NO;
    [RCTView ardia_checkHover];
    enters = leaves = 0;

    pointer.x += 4;
    row.inside = YES;
    scroll(list, 2);
    [row mouseEntered:nil];
    printf("moveinflight %d %d\n", enters, row->_ardiaEnterWaiting);
    now += 1;
    [RCTView ardia_checkHover];
    row.inside = NO;
    [RCTView ardia_checkHover];

    [RCTView ardia_setConsentEpoch:@"active"];
    [RCTView ardia_takeHoverCounts];
    scroll(list, 3);
    row.inside = YES;
    [row mouseEntered:nil];
    now += 0.016;
    row.inside = NO;
    [row mouseExited:nil];
    int pending = row->_ardiaEnterWaiting;
    for (int i = 4; i < 35; ++i) { now += 0.016; scroll(list, i); }
    now += 1;
    [RCTView ardia_checkHover];
    printf("waitcanceled %d %d %ld\n", pending, monitors, (long)[[RCTView ardia_takeHoverCounts][@"active"][@"holds"] integerValue]);

    NSWindow *window = (NSWindow *)[ReplayWindow new];
    row.placedWindow = window;
    row.inside = YES;
    [row mouseEntered:nil];
    leaves = 0;
    row.detached = YES;
    [row ardia_windowChanged];
    window = nil;
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, false);
    printf("windowclosed %d %d %d\n", row->_ardiaHoverWindow == nil, row->_hasMouseOver, leaves);
    row.detached = NO;
    row.placedWindow = nil;
    row.inside = NO;
    now += 1;
    [RCTView ardia_checkHover];

    __weak RCTView *weakRow;
    @autoreleasepool {
      int deadEnters = 0, deadLeaves = 0;
      RCTView *dead = make(list, &deadEnters, &deadLeaves);
      weakRow = dead;
      now += 1;
      scroll(list, 102);
      dead.inside = YES;
      [dead mouseEntered:nil];
      printf("releasedwaiter %d ", monitors);
      dead.detached = YES;
      [dead ardia_windowChanged];
      [dead removeFromSuperview];
    }
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, false);
    printf("%d %d\n", weakRow == nil, monitors);
  }
  return 0;
}
`;

const TWO_LISTS = String.raw`
int main(void) {
  @autoreleasepool {
    ArdiaHoverViews = [NSHashTable weakObjectsHashTable];
    NSView *listA = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 200, 200)];
    NSView *listB = [[NSView alloc] initWithFrame:NSMakeRect(300, 0, 200, 200)];
    RCTView *card = [[RCTView alloc] initWithFrame:NSMakeRect(0, 0, 50, 50)];
    [listA addSubview:card];
    replayWindow = (NSWindow *)[ReplayWindow new];
    [ArdiaHoverViews addObject:card];
    __block CFTimeInterval entered = 0;
    card.onMouseEnter = ^(NSDictionary *i) { entered = CACurrentMediaTime(); };
    card.onMouseLeave = ^(NSDictionary *i) {};
    [card updateTrackingAreas];
    pointer = NSMakePoint(100, 100);
    [RCTView ardia_checkHover];
    [RCTView ardia_scrolled:listA];
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.012, false);
    listA.boundsOrigin = NSMakePoint(1, 0);
    CFTimeInterval lastA = CACurrentMediaTime();
    card.inside = YES;
    [RCTView ardia_scrolled:listA];
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.040, false);
    [RCTView ardia_scrolled:listB];
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.2, false);
    printf("twolistwake %.1f\n", entered == 0 ? -1.0 : (entered - lastA) * 1000);
  }
  return 0;
}
`;

const SCENARIOS = String.raw`
static NSView *clip, *clipB;
static RCTView *row, *rowB, *tool;
static int rowIn, rowOut, rowBIn, toolIn;
static void step(NSView *list, int x) { now += 0.016; list.boundsOrigin = NSMakePoint(x, 0); [RCTView ardia_scrolled:list]; [RCTView ardia_checkHover]; }
static void quiet(void) { now += 1; [RCTView ardia_checkHover]; }
static void move(CGFloat dx) { pointer.x += dx; if (moveHandler) ((id (^)(id))moveHandler)(nil); }
int main(void) {
  @autoreleasepool {
    ArdiaHoverViews = [NSHashTable weakObjectsHashTable];
    NSView *root = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)];
    clip = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 200, 200)];
    clipB = [[NSView alloc] initWithFrame:NSMakeRect(300, 0, 200, 200)];
    row = [[RCTView alloc] initWithFrame:NSMakeRect(0, 0, 50, 50)];
    rowB = [[RCTView alloc] initWithFrame:NSMakeRect(0, 0, 50, 50)];
    tool = [[RCTView alloc] initWithFrame:NSMakeRect(250, 0, 50, 50)];
    [root addSubview:clip]; [root addSubview:clipB]; [clip addSubview:row]; [clipB addSubview:rowB]; [root addSubview:tool];
    replayWindow = (NSWindow *)[ReplayWindow new];
    NSWindow *second = (NSWindow *)[ReplayWindow new];
    for (RCTView *view in @[ row, rowB, tool ]) [ArdiaHoverViews addObject:view];
    row.onMouseEnter = ^(NSDictionary *i) { rowIn++; };
    row.onMouseLeave = ^(NSDictionary *i) { rowOut++; };
    rowB.onMouseEnter = ^(NSDictionary *i) { rowBIn++; };
    rowB.onMouseLeave = ^(NSDictionary *i) {};
    tool.onMouseEnter = ^(NSDictionary *i) { toolIn++; };
    tool.onMouseLeave = ^(NSDictionary *i) {};
    for (RCTView *view in @[ row, rowB, tool ]) [view updateTrackingAreas];
    pointer = NSMakePoint(100, 100);
    [RCTView ardia_checkHover];

    step(clip, 1);
    row.inside = YES;
    step(clip, 2);
    int firstStep = rowIn;
    for (int x = 3; x < 6; x++) step(clip, x);
    int coasting = rowIn;
    now += ArdiaHoverScrollSettle + 0.001;
    [RCTView ardia_checkHover];
    printf("firststep %d %d %d\n", firstStep, coasting, rowIn);

    row.inside = NO;
    quiet();
    rowIn = rowOut = 0;
    step(clip, 10);
    move(5);
    row.inside = YES;
    [row mouseEntered:nil];
    int entered = rowIn;
    row.inside = NO;
    step(clip, 11);
    printf("coastleave %d %d %d\n", entered, rowOut, row->_hasMouseOver);
    step(clip, 12);
    [row mouseExited:nil];
    quiet();
    printf("coastleavelater %d\n", rowOut);

    quiet();
    row.inside = YES;
    [RCTView ardia_checkHover];
    int outBefore = rowOut;
    row.inside = NO;
    step(clip, 15);
    printf("firstleave %d %d\n", rowOut - outBefore, row->_hasMouseOver);

    quiet();
    step(clip, 20);
    int toolBefore = toolIn;
    tool.inside = YES;
    [RCTView ardia_checkHover];
    printf("outside %d\n", toolIn - toolBefore);
    tool.inside = NO;

    quiet();
    step(clip, 30);
    row.inside = YES;
    [row mouseEntered:nil];
    step(clipB, 1);
    int beforeAQuiet = row->_hasMouseOver;
    now += ArdiaHoverScrollSettle + 0.001;
    [RCTView ardia_checkHover];
    printf("twolists %d %d\n", beforeAQuiet, row->_hasMouseOver);

    row.inside = NO;
    quiet();
    rowIn = 0;
    step(clip, 40);
    row.inside = YES;
    [row mouseEntered:nil];
    int waiting = row->_ardiaEnterWaiting;
    frontWindow = second;
    move(2);
    int coveredEnter = rowIn;
    frontWindow = nil;
    buttons = 1;
    move(2);
    int pressedEnter = rowIn;
    buttons = 0;
    move(2);
    printf("covered %d %d %d %d\n", waiting, coveredEnter, pressedEnter, rowIn);

    row.inside = NO;
    quiet();
    step(clip, 50);
    row.inside = YES;
    [row mouseEntered:nil];
    int watching = monitors;
    [row mouseExited:nil];
    printf("monitor %d %d\n", watching, monitors);

    quiet();
    rowIn = rowOut = 0;
    row.inside = YES;
    [RCTView ardia_checkHover];
    row.detached = YES;
    [row ardia_windowChanged];
    row.detached = NO;
    row.placedWindow = second;
    [row ardia_windowChanged];
    int leftOnMove = rowOut;
    [row mouseEntered:nil];
    [row mouseEntered:nil];
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, false);
    printf("windowmove %d %d %d %d\n", leftOnMove, rowIn, rowOut, row->_hasMouseOver);
    row.placedWindow = nil;
    row.inside = NO;
    quiet();

    [RCTView ardia_setConsentEpoch:@""];
    [RCTView ardia_takeHoverCounts];
    step(clip, 140);
    row.inside = NO;
    [row mouseEntered:nil];
    [RCTView ardia_setConsentEpoch:@"active"];
    now += 1;
    move(3);
    int clippedAfterSharingOn = [[RCTView ardia_takeHoverCounts][@"active"][@"clipped"] intValue];
    [row mouseExited:nil];
    quiet();
    row.inside = NO;
    [row mouseEntered:nil];
    int clippedWhileSharing = [[RCTView ardia_takeHoverCounts][@"active"][@"clipped"] intValue];
    [row mouseExited:nil];
    printf("enterepoch %d %d\n", clippedAfterSharingOn, clippedWhileSharing);
    quiet();

    [RCTView ardia_takeHoverCounts];
    for (int x = 60; x < 90; x++) step(clipB, x);
    quiet();
    int unhandled = [[RCTView ardia_takeHoverCounts][@"active"][@"holds"] intValue];
    step(clip, 100);
    row.inside = YES;
    [row mouseEntered:nil];
    for (int x = 101; x < 130; x++) step(clip, x);
    quiet();
    int waited = [[RCTView ardia_takeHoverCounts][@"active"][@"holds"] intValue];
    [RCTView ardia_setConsentEpoch:@""];
    [RCTView ardia_noteHoverHeld];
    now += 0.5;
    [RCTView ardia_endHoverHold];
    [RCTView ardia_countHover:@"clipped" epoch:[RCTView ardia_consentEpoch]];
    printf("telemetry %d %d %lu\n", unhandled, waited, (unsigned long)[RCTView ardia_takeHoverCounts].count);
  }
  return 0;
}
`;

const TIMED = String.raw`
int main(void) {
  @autoreleasepool {
    ArdiaHoverViews = [NSHashTable weakObjectsHashTable];
    NSView *list = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 200, 200)];
    RCTView *card = [[RCTView alloc] initWithFrame:NSMakeRect(0, 0, 50, 50)];
    [list addSubview:card];
    replayWindow = (NSWindow *)[ReplayWindow new];
    [ArdiaHoverViews addObject:card];
    __block CFTimeInterval entered = 0;
    card.onMouseEnter = ^(NSDictionary *i) { entered = CACurrentMediaTime(); };
    card.onMouseLeave = ^(NSDictionary *i) {};
    [card updateTrackingAreas];
    pointer = NSMakePoint(100, 100);
    [RCTView ardia_checkHover];
    CFTimeInterval last = 0;
    int early = 0;
    for (int i = 1; i <= 40; i++) {
      card.inside = i >= 2;
      list.boundsOrigin = NSMakePoint(i, 0);
      last = CACurrentMediaTime();
      [RCTView ardia_scrolled:list];
      CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.016, false);
      if (entered != 0) early++;
    }
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.3, false);
    printf("settled %d %.1f\n", early, entered == 0 ? -1.0 : (entered - last) * 1000);
  }
  return 0;
}
`;

function program(realClock, cases = realClock ? TIMED : SCENARIOS) {
  const source = readFileSync(installed, "utf8");
  const settle = source.match(/static const CFTimeInterval ArdiaHoverScrollSettle = ([0-9.]+);/)[1];
  const region = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  const body = (signature) => {
    const start = source.indexOf(`${signature}\n{`);
    assert.notEqual(start, -1, `RCTView.m has no ${signature}`);
    return source.slice(start, source.indexOf("\n}\n", start) + 3);
  };
  const wake = realClock ? body("+ (void)ardia_markHoverDirty") : FAKE_WAKE;
  const tracking = cases === SEQUENCES ? NO_TRACKING : "";
  return prelude(settle, realClock) + region("typedef struct {\n  double scrolledAt;", "// [Ardia: removeClippedSubviews hides") + STUBS + tracking + wake + REPLAYED.map(body).join("\n") + "\n@end\n" + cases;
}

const runs = new Map();
function replayRun(t, realClock = false, cases = realClock ? TIMED : SCENARIOS) {
  if (process.platform !== "darwin") return t.skip("AppKit replay runs on macOS"), null;
  if (runs.has(cases)) return runs.get(cases);
  const dir = mkdtempSync(join(tmpdir(), "hover-replay-"));
  try {
    writeFileSync(join(dir, "replay.m"), program(realClock, cases));
    execFileSync("clang", ["-fobjc-arc", "-w", "-framework", "AppKit", "-framework", "QuartzCore", "-o", join(dir, "replay"), join(dir, "replay.m")], { stdio: "pipe" });
    let out;
    try {
      out = execFileSync(join(dir, "replay"), { stdio: "pipe" }).toString();
    } catch (error) {
      throw new Error(`the replay stopped: ${error.stdout}${error.stderr}`);
    }
    const result = Object.fromEntries(out.trim().split("\n").map((line) => { const [name, ...values] = line.split(" "); return [name, values.map(Number)]; }));
    runs.set(cases, result);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a card that scrolls under a still pointer on the first step waits for the list to go quiet, then is entered on the first check after", (t) => {
  const r = replayRun(t);
  if (!r) return;
  assert.deepEqual(r.firststep, [0, 0, 1]);
});

test("a row entered while a list coasts is left on the very step that scrolls it away", (t) => {
  const r = replayRun(t);
  if (!r) return;
  assert.deepEqual(r.coastleave, [1, 1, 0]);
  assert.equal(r.coastleavelater[0], 1, "no second leave once the list goes quiet or AppKit's own exit arrives");
});

test("a hovered row that a scroll's first step carries away from a still pointer is left on that step", (t) => {
  const r = replayRun(t);
  if (!r) return;
  assert.deepEqual(r.firstleave, [1, 0]);
});

test("hover outside the scrolling list is decided on the next check, never held by the scroll", (t) => {
  const r = replayRun(t);
  if (!r) return;
  assert.equal(r.outside[0], 1);
});

test("one list's scroll neither ends nor extends another list's hold", (t) => {
  const r = replayRun(t);
  if (!r) return;
  assert.deepEqual(r.twolists, [0, 1], "list A's row waits while list B scrolls, and is entered on the first check after A goes quiet");
});

test("a waiting enter lands only when its window is in front under the pointer and no button is down", (t) => {
  const r = replayRun(t);
  if (!r) return;
  assert.deepEqual(r.covered, [1, 0, 0, 1]);
});

test("the mouse-move watch goes the moment the last waiting view stops waiting", (t) => {
  const r = replayRun(t);
  if (!r) return;
  assert.deepEqual(r.monitor, [1, 0]);
});

test("a hovered view moved to another window is left there first and entered once", (t) => {
  const r = replayRun(t);
  if (!r) return;
  assert.deepEqual(r.windowmove, [1, 1, 1, 1]);
});

test("a clipped enter is counted in the consent period its enter began in", (t) => {
  const r = replayRun(t);
  if (!r) return;
  assert.deepEqual(r.enterepoch, [0, 1], "an enter that began while sharing was off is never counted after sharing turns on");
});

test("a hold is timed only while a hover change waits, and nothing is counted while sharing is off", (t) => {
  const r = replayRun(t);
  if (!r) return;
  assert.deepEqual(r.telemetry, [0, 1, 0]);
});

test("with the real clock and the queued wake-up, a card under a still pointer is entered within the settle time plus 20 ms after the list stops, never while it moves", (t) => {
  const r = replayRun(t, true);
  if (!r) return;
  const [early, ms] = r.settled;
  assert.equal(early, 0);
  assert.ok(ms >= SETTLE * 1000 && ms <= SETTLE * 1000 + 20, `entered ${ms} ms after the last step`);
});

test("a still pointer waits from the very first scroll step, but a real move already on its way before that step still enters at once", (t) => {
  const r = replayRun(t, false, SEQUENCES);
  if (!r) return;
  assert.deepEqual(r.stillfirst, [0, 1]);
  assert.deepEqual(r.moveinflight, [1, 0]);
});

test("a held enter cancelled by its exit ends the hold, even while the list keeps scrolling", (t) => {
  const r = replayRun(t, false, SEQUENCES);
  if (!r) return;
  assert.deepEqual(r.waitcanceled, [0, 0, 0]);
});

test("a hovered view whose window closes before the queued check still gets its leave", (t) => {
  const r = replayRun(t, false, SEQUENCES);
  if (!r) return;
  assert.deepEqual(r.windowclosed, [1, 0, 1]);
});

test("the mouse-move watch goes when its last waiting view is released before the queued check", (t) => {
  const r = replayRun(t, false, SEQUENCES);
  if (!r) return;
  assert.deepEqual(r.releasedwaiter, [1, 1, 0]);
});

test("with the real clock, a step in list B never delays list A's card past A's own settle time plus 20 ms", (t) => {
  const r = replayRun(t, true, TWO_LISTS);
  if (!r) return;
  const [ms] = r.twolistwake;
  assert.ok(ms >= SETTLE * 1000 && ms <= SETTLE * 1000 + 20, `entered ${ms} ms after list A stopped`);
});
