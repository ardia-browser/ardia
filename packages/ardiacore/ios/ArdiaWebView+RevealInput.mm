#import "ArdiaWebViewInternal.h"
#import "ArdiaFieldTiming.h"
#import "ArdiaRevealLedger.h"

#import <QuartzCore/QuartzCore.h>

using namespace ardia_web_view;
using namespace ardia_reveal_ledger;

namespace {

NSString *const kPageIdentityTag = @"page-identity";
constexpr CFTimeInterval kLeavingBackstopSeconds = 0.5;
constexpr NSEventMask kButtonDowns = NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown | NSEventMaskOtherMouseDown;
constexpr NSEventMask kButtonUps = NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp | NSEventMaskOtherMouseUp;
constexpr NSEventMask kButtonDrags = NSEventMaskLeftMouseDragged | NSEventMaskRightMouseDragged | NSEventMaskOtherMouseDragged;
constexpr NSEventMask kKeys = NSEventMaskKeyDown | NSEventMaskKeyUp | NSEventMaskFlagsChanged;
constexpr NSEventMask kPointer = NSEventMaskMouseMoved | NSEventMaskScrollWheel | NSEventMaskMagnify | NSEventMaskSmartMagnify | NSEventMaskSwipe | NSEventMaskRotate;

NSUInteger gOnScreenAhead = 0;
BOOL (^gAppWideKeys)(NSEvent *);
KeyLedger gKeys;
__weak NSResponder *gKeyHolder;
PressLedger gPresses;

NSMapTable<NSWindow *, NSMapTable<NSView *, NSNumber *> *> *IdentityHidden() {
  static NSMapTable *hidden = [NSMapTable weakToStrongObjectsMapTable];
  return hidden;
}

void CollectPageIdentity(NSView *root, NSHashTable<NSView *> *found) {
  for (NSView *view in root.subviews) {
    if ([ReactTagOf(view) isEqualToString:kPageIdentityTag]) [found addObject:view];
    else CollectPageIdentity(view, found);
  }
}

}

namespace ardia_web_view {

const NSEventMask kRevealInputMask = kButtonDowns | kButtonUps | kButtonDrags | kKeys | kPointer;

NSString *ReactTagOf(NSView *view) {
  for (NSString *name in @[ @"nativeID", @"nativeId" ]) {
    if (![view respondsToSelector:NSSelectorFromString(name)]) continue;
    id tag = [view valueForKey:name];
    if ([tag isKindOfClass:NSString.class]) return tag;
  }
  return nil;
}

}

@implementation ArdiaWebView (RevealInput)

static BOOL InTabPage(id responder) {
  for (NSView *view = [responder isKindOfClass:NSView.class] ? responder : nil; view; view = view.superview)
    if ([view isKindOfClass:ArdiaWebView.class]) return !((ArdiaWebView *)view)->_standalone;
  return NO;
}

+ (ArdiaWebView *)onScreenAheadIn:(NSWindow *)window {
  if (!gOnScreenAhead || !window) return nil;
  for (ArdiaWebView *other in LiveViews().allObjects)
    if (other.window == window && other->_reveal.onScreen) return other;
  return nil;
}

+ (BOOL)revealGapIn:(NSWindow *)window {
  return [ArdiaWebView onScreenAheadIn:window] != nil;
}

+ (BOOL)anyRevealGap {
  return gOnScreenAhead > 0;
}

+ (BOOL)refusesInputAheadOfSwitch:(id)target {
  if (!gOnScreenAhead) return NO;
  id holder = target;
  for (int depth = 0; holder && ![holder isKindOfClass:NSView.class] && depth < 256; depth++)
    holder = [holder respondsToSelector:@selector(accessibilityParent)] ? [holder accessibilityParent] : nil;
  NSView *view = [holder isKindOfClass:NSView.class] ? holder : nil;
  return InTabPage(view) && [ArdiaWebView revealGapIn:view.window];
}

+ (void)setAppWideKeys:(BOOL (^)(NSEvent *))perform {
  gAppWideKeys = [perform copy];
}

+ (BOOL)skipsEventMonitors:(NSEvent *)event {
  const NSEventType type = event.type;
  return (type == NSEventTypeKeyDown || type == NSEventTypeKeyUp) && SkipsEventMonitors(type == NSEventTypeKeyDown, type == NSEventTypeKeyUp, event.keyCode, event.modifierFlags);
}

+ (BOOL)swallowsKeyAheadOfSwitch:(NSEvent *)event {
  const unsigned code = event.keyCode;
  const BOOL modifier = event.type == NSEventTypeFlagsChanged;
  const BOOL down = modifier ? ModifierIsDown(code, event.modifierFlags) : event.type == NSEventTypeKeyDown;
  const BOOL repeat = !modifier && down && event.isARepeat;
  NSWindow *window = gOnScreenAhead || gKeys.HeldOver(code) ? event.window : nil;
  NSResponder *keyboard = window.firstResponder;
  const BOOL ahead = gOnScreenAhead && window && [ArdiaWebView revealGapIn:window] && InTabPage(keyboard);
  if (ahead && repeat) gKeyHolder = keyboard;
  const BOOL swallows = gKeys.Swallows(code, down, repeat, ahead, keyboard && keyboard == gKeyHolder);
  if (ahead && down && !repeat && !modifier && gAppWideKeys) gAppWideKeys(event);
  return swallows;
}

+ (BOOL)swallowsAheadOfSwitch:(NSEvent *)event {
  const NSEventMask type = NSEventMaskFromType(event.type);
  if (type & kKeys) return [ArdiaWebView swallowsKeyAheadOfSwitch:event];
  const BOOL button = (type & (kButtonDowns | kButtonUps | kButtonDrags)) != 0;
  if (!gOnScreenAhead && (!button || gPresses.Idle())) return NO;
  const BOOL lands = !(type & (kButtonUps | kButtonDrags));
  const BOOL activatesApp = (type & kButtonDowns) && !NSApp.isActive;
  const BOOL overCoveredPage = lands && !activatesApp && gOnScreenAhead && [ArdiaWebView revealGapIn:event.window] && InTabPage(HitInWindow(event));
  if (!button) return overCoveredPage;
  const Press press = type & kButtonDowns ? Press::kDown : type & kButtonUps ? Press::kUp : Press::kDrag;
  return gPresses.Swallows((unsigned)event.buttonNumber, press, event.windowNumber, overCoveredPage);
}

- (void)noteOnScreenAhead:(BOOL)overAnother {
  if (!_reveal.native) return;
  const BOOL painted = !_frameHold.awaiting && self.alphaValue >= 1;
  if (!_reveal.onScreen && (painted || overAnother)) {
    _reveal.onScreen = YES;
    _reveal.onScreenIn = self.window;
    gOnScreenAhead++;
    [self hidePageIdentity];
    [ArdiaWebView revealGapChangedIn:self.window];
  }
  if (!painted || _reveal.painted) return;
  _reveal.painted = YES;
  ArdiaFieldMarkNow([NSString stringWithFormat:@"press:%lu", (unsigned long)_reveal.press], @"nativeReveal");
  ArdiaFieldMarkAtCommit(_transferKey, @"view");
}

+ (void)focusPagesAskedAheadOfSwitch {
  for (ArdiaWebView *view in LiveViews().allObjects) {
    NSWindow *window = view.window;
    if ([ArdiaWebView revealGapIn:window]) continue;
    if (view->_visible && view->_focus.onActivate) [view schedulePainting];
    const ArdiaFocusAsk ask = view->_focus.askedAheadOfSwitch;
    if (!ask.asked) continue;
    view->_focus.askedAheadOfSwitch = {};
    if (!view->_tab || ask.tab != view->_tab) continue;
    NSResponder *responder = window.firstResponder;
    const BOOL unfocused = !responder || responder == window;
    if (!unfocused && (ask.onlyIfUnfocused || !InTabPage(responder))) continue;
    if (view->_visible) [view focusPage];
    else [ArdiaWebView focusVisiblePageIn:window];
  }
}

- (void)askFocusAheadOfSwitch:(BOOL)onlyIfUnfocused {
  const BOOL always = _focus.askedAheadOfSwitch.asked && !_focus.askedAheadOfSwitch.onlyIfUnfocused;
  _focus.askedAheadOfSwitch = {};
  _focus.askedAheadOfSwitch.asked = YES;
  _focus.askedAheadOfSwitch.onlyIfUnfocused = onlyIfUnfocused && !always;
  _focus.askedAheadOfSwitch.tab = _tab;
}

- (BOOL)leavingScreenAhead {
  return !_visible && self.window && _frameHold.holding;
}

- (void)settleOnScreenAhead {
  if (!_reveal.onScreen || (_reveal.active && _reveal.native) || self.leavingScreenAhead) return;
  [self leaveScreenAhead];
}

- (void)leaveScreenAheadOnceGone {
  if (!_reveal.onScreen) return;
  if (_visible || !self.window) return [self leaveScreenAhead];
  __weak ArdiaWebView *weakSelf = self;
  const NSUInteger generation = _reveal.generation;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kLeavingBackstopSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    ArdiaWebView *view = weakSelf;
    if (view && view->_reveal.generation == generation && !view->_reveal.active) [view leaveScreenAhead];
  });
}

- (void)leaveScreenAhead {
  if (!_reveal.onScreen) return;
  _reveal.onScreen = NO;
  gOnScreenAhead--;
  NSWindow *window = _reveal.onScreenIn;
  _reveal.onScreenIn = nil;
  if (!window || [ArdiaWebView revealGapIn:window]) return;
  NSMapTable<NSView *, NSNumber *> *hidden = [IdentityHidden() objectForKey:window];
  [IdentityHidden() removeObjectForKey:window];
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  for (NSView *view in hidden.keyEnumerator.allObjects) view.alphaValue = [hidden objectForKey:view].doubleValue;
  [CATransaction commit];
  [ArdiaWebView revealGapChangedIn:window];
  dispatch_async(dispatch_get_main_queue(), ^{
    [ArdiaWebView focusPagesAskedAheadOfSwitch];
  });
}

- (void)acceptDropsIfShown {
  const BOOL accept = _visible && (_standalone || ![ArdiaWebView revealGapIn:self.window]);
  for (NSView *sub in self.subviews) AcceptDrops(sub, accept);
}

+ (void)revealGapChangedIn:(NSWindow *)window {
  for (ArdiaWebView *view in LiveViews().allObjects)
    if (view.window == window) [view acceptDropsIfShown];
  NSResponder *responder = window.firstResponder;
  if (InTabPage(responder)) responder.touchBar = nil;
}

- (void)hidePageIdentity {
  NSWindow *window = self.window;
  NSView *content = window.contentView;
  if (!content) return;
  NSMapTable<NSView *, NSNumber *> *hidden = [IdentityHidden() objectForKey:window] ?: [NSMapTable weakToStrongObjectsMapTable];
  NSHashTable<NSView *> *found = [NSHashTable weakObjectsHashTable];
  CollectPageIdentity(content, found);
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  for (NSView *view in found.allObjects) {
    if (![hidden objectForKey:view]) [hidden setObject:@(view.alphaValue) forKey:view];
    view.alphaValue = 0;
  }
  [CATransaction commit];
  [IdentityHidden() setObject:hidden forKey:window];
}

- (void)hidePageIdentityAfterMount {
  __weak ArdiaWebView *weakSelf = self;
  const NSUInteger generation = _reveal.generation;
  CFRunLoopObserverRef observer = CFRunLoopObserverCreateWithHandler(nil, kCFRunLoopBeforeWaiting | kCFRunLoopExit, false, 0, ^(CFRunLoopObserverRef, CFRunLoopActivity) {
    ArdiaWebView *view = weakSelf;
    if (view && view->_reveal.onScreen && view->_reveal.generation == generation) [view hidePageIdentity];
  });
  CFRunLoopAddObserver(CFRunLoopGetMain(), observer, kCFRunLoopCommonModes);
  CFRelease(observer);
}

@end
