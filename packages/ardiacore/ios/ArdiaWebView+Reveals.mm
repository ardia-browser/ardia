#import "ArdiaWebViewInternal.h"
#import "ArdiaTabParking.h"
#import "ArdiaFieldTiming.h"
#import "ArdiaTabPresses.h"
#import "ArdiaChromeWindowInternal.h"

#include <atomic>

using namespace ardia_web_view;

namespace {

constexpr CFTimeInterval kRevealBackstopSeconds = 5;
constexpr NSEventModifierFlags kClickModifiers =
    NSEventModifierFlagCommand | NSEventModifierFlagOption | NSEventModifierFlagShift | NSEventModifierFlagControl;

std::atomic<bool> gNativeTabSwitch{false};

NSString *const kTabSwitchTag = @"tab-switch:";
NSString *const kTabSelectedTag = @"tab-selected:";
NSString *const kSmallWindow = @"ardia.window.small";

BOOL IsRowControl(NSView *view) {
  if ([view isKindOfClass:NSControl.class] || [view isKindOfClass:NSText.class]) return YES;
  NSAccessibilityRole role = view.accessibilityRole;
  return [role isEqualToString:NSAccessibilityButtonRole] || [role isEqualToString:NSAccessibilityTextFieldRole] ||
         [role isEqualToString:NSAccessibilityTextAreaRole] || [role isEqualToString:NSAccessibilityCheckBoxRole] ||
         [role isEqualToString:NSAccessibilityPopUpButtonRole] || [role isEqualToString:NSAccessibilityMenuButtonRole];
}

BOOL TypingOutsidePages(NSWindow *window) {
  NSResponder *responder = window.firstResponder;
  if (![responder isKindOfClass:NSText.class]) return NO;
  for (NSView *view = (NSView *)responder; view; view = view.superview)
    if ([view isKindOfClass:ArdiaWebView.class]) return NO;
  return YES;
}

BOOL OlderPress(NSUInteger press, NSUInteger than) {
  return press && press < than;
}

NSString *TabSwitchKeyOf(NSView *view) {
  NSString *tag = ReactTagOf(view);
  if (![tag hasPrefix:kTabSwitchTag] && ![tag hasPrefix:kTabSelectedTag]) return nil;
  return [tag substringFromIndex:[tag rangeOfString:@":"].location + 1].length ? tag : nil;
}

NSString *PressMarkKey(NSUInteger press) {
  return [NSString stringWithFormat:@"press:%lu", (unsigned long)press];
}

NSString *PressedTabTag(NSEvent *event) {
  NSWindow *window = event.window;
  NSView *content = window.contentView;
  NSView *hit = HitInWindow(event);
  if (!hit || !(window.isKeyWindow || [hit acceptsFirstMouse:event])) return nil;
  for (NSView *view = hit; view && view != content; view = view.superview) {
    if (NSString *key = TabSwitchKeyOf(view)) return key;
    if (IsRowControl(view)) return nil;
  }
  return nil;
}

void OnMain(void (^block)(void)) {
  if (NSThread.isMainThread) block();
  else dispatch_async(dispatch_get_main_queue(), block);
}

void EndRevealsWhenTheWindowIsLeft() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    void (^everywhere)(NSNotification *) = ^(NSNotification *) {
      OnMain(^{
        [ArdiaWebView dropNativeRevealsInWindow:nil];
      });
    };
    void (^inItsWindow)(NSNotification *) = ^(NSNotification *note) {
      NSWindow *window = [note.object isKindOfClass:NSWindow.class] ? note.object : nil;
      if (!window || ([note.name isEqualToString:ArdiaWindowSeenDidChange] && [ArdiaWindowController userSees:window])) return;
      OnMain(^{
        [ArdiaWebView dropNativeRevealsInWindow:window];
      });
    };
    [center addObserverForName:NSApplicationDidResignActiveNotification object:nil queue:nil usingBlock:everywhere];
    [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceActiveSpaceDidChangeNotification object:nil queue:nil usingBlock:everywhere];
    for (NSNotificationName name in @[ NSWindowWillEnterFullScreenNotification, NSWindowWillExitFullScreenNotification, ArdiaWindowSeenDidChange ])
      [center addObserverForName:name object:nil queue:nil usingBlock:inItsWindow];
  });
}
}

namespace ardia_web_view {

NSView *PaneUnder(NSView *view, NSView *ancestor) {
  for (NSView *v = view; v; v = v.superview)
    if (v.superview == ancestor) return v;
  return nil;
}

NSView *HitInWindow(NSEvent *event) {
  NSView *content = event.window.contentView;
  NSView *outer = content.superview;
  return content && outer ? [content hitTest:[outer convertPoint:event.locationInWindow fromView:nil]] : nil;
}

NSView *SharedAncestor(NSView *a, NSView *b) {
  NSHashTable<NSView *> *chain = [NSHashTable weakObjectsHashTable];
  for (NSView *v = a.superview; v; v = v.superview) [chain addObject:v];
  for (NSView *v = b.superview; v; v = v.superview)
    if ([chain containsObject:v]) return v;
  return nil;
}
}

@implementation ArdiaWebView (Reveals)

static BOOL HoldsItsWindow(ArdiaWebView *page) {
  NSWindow *window = page.window;
  ArdiaCoreWindow *coreWindow = [ArdiaWindowController forNSWindow:window].coreWindow;
  if (page->_reports.exclusiveFrames.count || window.attachedSheet || (coreWindow && [ArdiaWindowFullScreen ofWindow:coreWindow create:NO].pageFullScreen)) return YES;
  const NSRect onScreen = [window convertRectToScreen:[page convertRect:page.bounds toView:nil]];
  for (NSWindow *child in window.childWindows)
    if (child.visible && NSIntersectsRect(child.frame, onScreen)) return YES;
  return NO;
}

static ArdiaWebView *ViewForKey(NSString *key) {
  for (ArdiaWebView *view in LiveViews().allObjects)
    if (view->_tab && [view->_transferKey isEqualToString:key]) return view;
  return nil;
}

+ (void)revealTab:(NSString *)transferKey press:(NSUInteger)press {
  if (!transferKey.length) return;
  NSString *key = [transferKey copy];
  ArdiaTabSwitchNote(key, press);
  OnMain(^{
    ArdiaWebView *view = ViewForKey(key);
    if (!view.window) return;
    ArdiaWebView *pressedLater = [ArdiaWebView nativeRevealInWindow:view.window except:view];
    if (pressedLater && OlderPress(press, pressedLater->_reveal.press)) return;
    [ArdiaWebView dropRevealsInWindow:view.window except:view];
    [view revealAhead];
  });
}

+ (void)setNativeTabSwitch:(BOOL)enabled {
  gNativeTabSwitch.store(enabled, std::memory_order_relaxed);
}

+ (NSUInteger)claimTabPress:(NSString *)transferKey stamp:(double)stamp {
  return ArdiaTabPressClaim(transferKey, stamp);
}

+ (void)setTabsInSplits:(NSArray<NSString *> *)transferKeys {
  ArdiaTabSplitsSet(transferKeys);
  OnMain(^{
    for (ArdiaWebView *view in LiveViews().allObjects)
      if (view.window && (view->_visible || view->_reveal.native) && ArdiaTabInSplit(view->_transferKey)) [ArdiaWebView dropNativeRevealsInWindow:view.window];
  });
}

+ (void)setJavaScriptThread:(void (^)(void (^)(void)))run {
  ArdiaTabPressesSetJavaScriptThread(run);
  [ArdiaWebView endRevealsAheadOfSwitch];
}

+ (void)endRevealsAheadOfSwitch {
  OnMain(^{
    [ArdiaWebView dropNativeRevealsInWindow:nil];
  });
}

+ (void)takeBackPressesUnheardUpTo:(NSUInteger)press {
  void (^afterTheTouchReachedJavaScript)(void (^)(void)) = ^(void (^then)(void)) {
    dispatch_async(dispatch_get_main_queue(), ^{
      ArdiaTabPressesOnJavaScriptThread(then);
    });
  };
  afterTheTouchReachedJavaScript(^{
    afterTheTouchReachedJavaScript(^{
      for (NSNumber *unheard in ArdiaTabPressesTakeUnheard(press)) [ArdiaWebView dropTabPress:unheard.unsignedIntegerValue];
    });
  });
}

+ (BOOL)revealForPress:(NSEvent *)event {
  if (!gNativeTabSwitch.load(std::memory_order_relaxed) || event.type != NSEventTypeLeftMouseDown) return NO;
  NSWindow *window = event.window;
  NSString *tag = window ? PressedTabTag(event) : nil;
  NSString *key = !tag ? nil : [tag substringFromIndex:[tag rangeOfString:@":"].location + 1];
  if (!key.length) return NO;
  const NSUInteger press = ArdiaTabPressBegan(key, event.timestamp * 1000);
  [ArdiaWebView takeBackPressesUnheardUpTo:press];
  if (event.clickCount > 1 || (event.modifierFlags & kClickModifiers)) return NO;
  ArdiaWebView *view = ViewForKey(key);
  if (!view || view.window != window) return NO;
  if (view->_visible) {
    [ArdiaWebView dropNativeRevealsInWindow:window];
    return NO;
  }
  if (view->_reveal.native) view->_reveal.press = press;
  if ([window.identifier isEqualToString:kSmallWindow] || TypingOutsidePages(window) || ArdiaTabInSplit(key)) return NO;
  ArdiaWebView *shown = [tag hasPrefix:kTabSwitchTag] && view.revealsFirst ? [view revealableOver:YES] : nil;
  if (!shown || HoldsItsWindow(shown)) return NO;
  EndRevealsWhenTheWindowIsLeft();
  const BOOL overAnother = [ArdiaWebView replaceRevealsInWindow:window with:view];
  if (!view->_reveal.active) return NO;
  view->_reveal.native = YES;
  view->_reveal.press = press;
  ArdiaFieldMark(PressMarkKey(press), @"nativePress", ArdiaFieldEventTime(event));
  [view noteOnScreenAhead:overAnother];
  return YES;
}


+ (ArdiaWebView *)nativeRevealInWindow:(NSWindow *)window except:(ArdiaWebView *)skip {
  for (ArdiaWebView *other in LiveViews().allObjects)
    if (other != skip && other.window == window && other->_reveal.active && other->_reveal.native) return other;
  return nil;
}

- (BOOL)stayOver:(ArdiaWebView *)shown {
  NSView *shared = SharedAncestor(self, shown);
  NSView *pane = PaneUnder(self, shared);
  NSView *shownPane = PaneUnder(shown, shared);
  if (!shared || !pane || !shownPane.layer || pane == shownPane) return NO;
  if (!NSEqualRects([self convertRect:self.bounds toView:nil], [shown convertRect:shown.bounds toView:nil])) return NO;
  if (NSView *lowered = _reveal.loweredPane) lowered.layer.zPosition = _reveal.loweredPaneZ;
  _reveal.loweredPane = shownPane;
  _reveal.loweredPaneZ = shownPane.layer.zPosition;
  shownPane.layer.zPosition = _reveal.loweredPaneZ - 1;
  if (_reveal.onScreen) [self hidePageIdentityAfterMount];
  return YES;
}

+ (void)dropNativeRevealsInWindow:(NSWindow *)window {
  for (ArdiaWebView *other in LiveViews().allObjects)
    if ((!window || other.window == window) && other->_reveal.native) [other dropReveal];
}

+ (void)dropTabReveals:(NSString *)transferKey press:(NSUInteger)press to:(NSString *)incomingKey {
  if (!transferKey.length) return;
  NSString *key = [transferKey copy];
  ArdiaTabSwitchNote(incomingKey, press);
  OnMain(^{
    ArdiaWebView *view = ViewForKey(key);
    if (view.window) [ArdiaWebView dropRevealsInWindow:view.window pressedBy:press];
  });
}

+ (void)dropTabPress:(NSUInteger)press {
  if (!press) return;
  ArdiaTabSwitchesForget(press);
  OnMain(^{
    for (ArdiaWebView *view in LiveViews().allObjects)
      if (view->_reveal.active && view->_reveal.native && view->_reveal.press == press) [view dropReveal];
  });
}

+ (void)dropRevealsInWindow:(NSWindow *)window pressedBy:(NSUInteger)press {
  for (ArdiaWebView *other in LiveViews().allObjects) {
    if (other.window != window) continue;
    [other dropFront];
    if (!(other->_reveal.native && OlderPress(press, other->_reveal.press))) [other dropReveal];
  }
}

+ (void)dropRevealsInWindow:(NSWindow *)window except:(ArdiaWebView *)keep {
  for (ArdiaWebView *other in LiveViews().allObjects) {
    if (other.window != window) continue;
    [other dropFront];
    if (other != keep) [other dropReveal];
  }
}

+ (BOOL)replaceRevealsInWindow:(NSWindow *)window with:(ArdiaWebView *)pressed {
  NSMutableArray<ArdiaWebView *> *ended = [NSMutableArray array], *endedNative = [NSMutableArray array];
  BOOL wasOnScreen = NO;
  for (ArdiaWebView *other in LiveViews().allObjects) {
    if (other.window != window) continue;
    [other dropFront];
    if (other == pressed || !other->_reveal.active) continue;
    [other->_reveal.native ? endedNative : ended addObject:other];
    wasOnScreen = wasOnScreen || other->_reveal.onScreen;
    [other endReveal];
  }
  [pressed revealAhead];
  for (ArdiaWebView *other in ended) [other paintAfterReveal:NO];
  for (ArdiaWebView *other in endedNative) [other paintAfterReveal:YES];
  return wasOnScreen;
}

+ (void)revealOffered:(NSString *)adoptId over:(NSString *)transferKey press:(NSUInteger)press {
  if (!adoptId.length || !transferKey.length) return;
  NSString *offer = [adoptId copy], *key = [transferKey copy];
  OnMain(^{
    ArdiaWebView *view = ViewForKey(key);
    if (!view.window) return;
    [ArdiaWebView dropRevealsInWindow:view.window pressedBy:press];
    ArdiaCoreTab *tab = [ArdiaTabRegistry offeredTab:offer];
    NSView *page = tab.view;
    if (TraceVisibility())
      NSLog(@"[ardiacore-vis] %@ front %@ offered=%d closed=%d superview=%@ adopted=%d", key, offer, tab != nil, tab.closed,
            page.superview.className, [ArdiaTabRegistry viewForTab:tab] != nil);
    if (!tab || tab.closed || !page || page.superview || [ArdiaTabRegistry viewForTab:tab]) return;
    [tab noteInShownSlot];
    [view frontPage:page profile:tab.profile];
  });
}

+ (BOOL)discardOffered:(NSString *)adoptId {
  if (![adoptId hasPrefix:@"ardiacore:"]) return NO;
  ArdiaCoreTab *tab = [ArdiaTabRegistry offeredTab:adoptId];
  if (!tab || tab.closed || [ArdiaTabRegistry viewForTab:tab] || [ArdiaTabParking linkMarkForTab:tab]) return NO;
  if (NSView *page = tab.view)
    for (ArdiaWebView *view in LiveViews().allObjects)
      if (view->_reveal.frontedPage == page) [view dropFront];
  if ([ArdiaTabRegistry takeOffered:adoptId] != tab) return NO;
  [tab close];
  return YES;
}

- (BOOL)onlyShownInWindow {
  NSWindow *window = self.window;
  if (!_visible || _warm || _reveal.active || _standalone || _life.closed() || !window || self.alphaValue < 1 || self.isHiddenOrHasHiddenAncestor) return NO;
  for (ArdiaWebView *other in LiveViews().allObjects)
    if (other != self && other.window == window && (other->_visible || other->_warm || other->_reveal.active)) return NO;
  return YES;
}

- (void)frontPage:(NSView *)page profile:(ArdiaCoreProfile *)profile {
  NSView *mine = _tab.view;
  if (_reveal.frontedPage || _devtoolsView || !mine || mine.superview != self || mine.hidden || _tab.profile != profile || ![self onlyShownInWindow]) return;
  page.frame = self.bounds;
  page.hidden = NO;
  [self addSubview:page positioned:NSWindowAbove relativeTo:mine];
  _reveal.frontedPage = page;
  if (TraceVisibility()) NSLog(@"[ardiacore-vis] %@ fronts a new tab's page", _transferKey);
  const NSUInteger generation = ++_reveal.frontGeneration;
  __weak ArdiaWebView *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kRevealBackstopSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    ArdiaWebView *view = weakSelf;
    if (view && view->_reveal.frontGeneration == generation) [view dropFront];
  });
}

- (void)dropFront {
  NSView *fronted = _reveal.frontedPage;
  _reveal.frontedPage = nil;
  _reveal.frontGeneration++;
  if (fronted.superview == self) [fronted removeFromSuperview];
}

- (BOOL)revealsFirst {
  if (!_tab || _tab.closed || _tab.discarded || _reports.crashed || _life.closed() || _visible || _reveal.active || _warm || _standalone) return NO;
  if (ArdiaTabInSplit(_transferKey)) return NO;
  NSString *url = _tab.url;
  if (![url hasPrefix:@"https:"] && ![url hasPrefix:@"http:"] && ![url hasPrefix:@"file:"]) return NO;
  for (ArdiaWebView *other in LiveViews().allObjects)
    if (other != self && other.window == self.window && other->_visible) return other->_tab.profile == _tab.profile;
  return NO;
}

- (ArdiaWebView *)revealableOver:(BOOL)pastOtherReveals {
  NSWindow *window = self.window;
  NSView *page = _tab.view;
  if (_visible || _reveal.active || _warm || _standalone || _life.closed() || !window || !page || page.superview != self) return nil;
  ArdiaWebView *shown = nil;
  for (ArdiaWebView *other in LiveViews().allObjects) {
    if (other == self || other.window != window) continue;
    if ((other->_warm && !other.neighbourPageAsleep) || (other->_reveal.active && !pastOtherReveals)) return nil;
    if (!other->_visible) continue;
    if (shown) return nil;
    shown = other;
  }
  if (!shown || shown.alphaValue < 1 || (shown->_reveal.frontedPage && !pastOtherReveals)) return nil;
  const NSRect mine = [self convertRect:self.bounds toView:nil];
  if (NSIsEmptyRect(mine) || !NSEqualRects(mine, [shown convertRect:shown.bounds toView:nil])) return nil;
  NSView *shared = SharedAncestor(self, shown);
  NSView *pane = PaneUnder(self, shared);
  NSView *shownPane = PaneUnder(shown, shared);
  if (!shared || !pane || !shownPane || !shownPane.layer || pane == shownPane || pane.isHiddenOrHasHiddenAncestor || pane.alphaValue < 1) return nil;
  return shown;
}

- (void)revealAhead {
  ArdiaWebView *shown = [self revealableOver:NO];
  if (!shown) return;
  NSView *shared = SharedAncestor(self, shown);
  NSView *shownPane = PaneUnder(shown, shared);
  if (TraceVisibility()) NSLog(@"[ardiacore-vis] %@ revealed over %@", _transferKey, shown->_transferKey);
  [self exposePage];
  _reveal.active = YES;
  _reveal.loweredPane = shownPane;
  _reveal.loweredPaneZ = shownPane.layer.zPosition;
  shownPane.layer.zPosition = _reveal.loweredPaneZ - 1;
  [self applyPainting];
  const NSUInteger generation = ++_reveal.generation;
  __weak ArdiaWebView *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kRevealBackstopSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    ArdiaWebView *view = weakSelf;
    if (view && view->_reveal.generation == generation && view->_reveal.active) [view dropReveal];
  });
}

- (void)endReveal {
  if (!_reveal.active) return;
  _reveal.active = NO;
  _reveal.native = NO;
  _reveal.painted = NO;
  _reveal.press = 0;
  _reveal.generation++;
  if (NSView *pane = _reveal.loweredPane) pane.layer.zPosition = _reveal.loweredPaneZ;
  _reveal.loweredPane = nil;
  [self leaveScreenAheadOnceGone];
}

- (void)dropReveal {
  if (!_reveal.active) return;
  const BOOL native = _reveal.native;
  if (_reveal.painted) ArdiaFieldMarkNow(PressMarkKey(_reveal.press), @"nativeRevealDropped");
  ArdiaTabSwitchesForget(_reveal.press);
  [self endReveal];
  [self paintAfterReveal:native];
}

- (void)paintAfterReveal:(BOOL)native {
  if (!native || _visible) return [self schedulePainting];
  [self leaveScreen];
  if (_leave.active) {
    _leave.active = NO;
    _leave.generation++;
  }
  [self applyPainting];
}

- (void)settleRevealsInWindow {
  NSWindow *window = self.window;
  const NSUInteger press = ArdiaTabSwitchTake(_transferKey);
  ArdiaWebView *pressedLater = window && !_reveal.active ? [ArdiaWebView nativeRevealInWindow:window except:self] : nil;
  if (pressedLater && OlderPress(press, pressedLater->_reveal.press) && [pressedLater stayOver:self]) return;
  [self endReveal];
  if (window) [ArdiaWebView dropRevealsInWindow:window except:self];
}

@end
