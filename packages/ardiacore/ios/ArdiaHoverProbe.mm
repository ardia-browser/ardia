#import "ArdiaHoverProbeInternal.h"
#import "ArdiaInternal.h"
#import "ArdiaContentBlockerInternal.h"
#import "ArdiaWindowController.h"
#import "ArdiaEvents.h"

#import <objc/message.h>

namespace ardia_host {

namespace hover_probe {

NSString *ReasonName(HoverReason reason) {
  return @[ @"fine", @"halfActive", @"staleMenu", @"notKeyOrMain", @"coveredByView", @"responderLost", @"coveredByWindow" ][(NSUInteger)reason];
}

NSString *KindName(FocusWindowKind kind) {
  return @[ @"none", @"hidden", @"blockerPage", @"internal", @"ardiaPanel", @"popup", @"browser", @"other" ][(NSUInteger)kind];
}

NSString *CoverName(PageCover cover) {
  return @[ @"none", @"reactNative", @"chromium", @"other" ][(NSUInteger)cover];
}

NSString *HolderName(FocusHolder holder) {
  return @[ @"none", @"window", @"otherWindow", @"page", @"control" ][(NSUInteger)holder];
}

NSString *TriggerName(HoverTrigger trigger) {
  return @[ @"move", @"click", @"recheck" ][(NSUInteger)trigger];
}

bool gDevHalfActive = false;
bool gDevMenuActive = false;

Activation CurrentActivation() {
  Activation activation;
  activation.appActive = NSApp.isActive;
  if (gDevHalfActive) {
    activation.runningActive = activation.frontmost = true;
  } else if (Background()) {
    activation.runningActive = activation.frontmost = activation.appActive;
  } else {
    NSRunningApplication *me = NSRunningApplication.currentApplication;
    activation.runningActive = me.isActive;
    activation.frontmost = [NSWorkspace.sharedWorkspace.frontmostApplication isEqual:me];
  }
  return activation;
}

bool WindowFlag(NSWindow *window, NSString *name) {
  if (![window respondsToSelector:NSSelectorFromString(name)]) return false;
  return [[window valueForKey:name] boolValue];
}

bool PreventsKey(NSWindow *window) {
  return WindowFlag(window, @"preventKeyWindow");
}

bool MenuActive(NSWindow *window) {
  return gDevMenuActive || WindowFlag(window, @"hasViewsMenuActive");
}

bool IsBrowserWindow(NSWindow *window) {
  if (!window || ardia_content_blocker::IsHiddenPageWindow(window)) return false;
  ArdiaWindowController *controller = [ArdiaWindowController forNSWindow:window];
  return controller.root && !controller.standalone && !controller.stray && !controller.coreWindow.internal;
}

bool Invisible(NSWindow *window) {
  return !window.isVisible || window.alphaValue < 0.01 || window.isMiniaturized || !window.isOnActiveSpace;
}

FocusWindowKind KindOf(NSWindow *window, bool evenInvisible = false) {
  if (!window) return FocusWindowKind::none;
  if (ardia_content_blocker::IsHiddenPageWindow(window)) return FocusWindowKind::blockerPage;
  if (!evenInvisible && Invisible(window)) return FocusWindowKind::hidden;
  if (ArdiaWindowController *controller = [ArdiaWindowController forNSWindow:window]) {
    if (controller.standalone || controller.stray || controller.coreWindow.internal) return FocusWindowKind::internal;
    return controller.root ? FocusWindowKind::browser : FocusWindowKind::ardiaPanel;
  }
  if ([window isKindOfClass:NSPanel.class] || window.isSheet || window.parentWindow || window.level > NSNormalWindowLevel ||
      [window.className containsString:@"Menu"])
    return FocusWindowKind::popup;
  return FocusWindowKind::other;
}

bool Unseen(FocusWindowKind kind) {
  return kind == FocusWindowKind::none || kind == FocusWindowKind::hidden || kind == FocusWindowKind::blockerPage;
}

Class PageClass() {
  static Class page = NSClassFromString(@"RenderWidgetHostViewCocoa");
  return page;
}

NSView *PageAt(NSWindow *window, NSPoint point) {
  Class pageClass = PageClass();
  if (!pageClass) return nil;
  NSView *found = nil;
  NSMutableArray<NSView *> *stack = [NSMutableArray arrayWithObject:window.contentView.superview ?: [NSView new]];
  while (stack.count) {
    NSView *v = stack.lastObject;
    [stack removeLastObject];
    if (v.isHidden) continue;
    if ([v isKindOfClass:pageClass]) {
      if (NSPointInRect(point, [v convertRect:v.bounds toView:nil])) found = v;
      continue;
    }
    for (NSView *child in v.subviews.reverseObjectEnumerator) [stack addObject:child];
  }
  return found;
}

NSView *EnclosingPage(NSView *view) {
  for (NSView *v = view; v; v = v.superview)
    if ([v isKindOfClass:PageClass()]) return v;
  return nil;
}

bool PageIgnoresMove(NSView *page, NSWindow *window, NSPoint point) {
  SEL ignores = NSSelectorFromString(@"shouldIgnoreMouseEvent:");
  if (![page respondsToSelector:ignores]) return false;
  NSEvent *event = [NSEvent mouseEventWithType:NSEventTypeMouseMoved location:point modifierFlags:0
                                     timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
                                       context:nil eventNumber:0 clickCount:0 pressure:0];
  return ((BOOL(*)(id, SEL, NSEvent *))objc_msgSend)(page, ignores, event);
}

NSView *HitAt(NSWindow *window, NSPoint point) {
  NSView *content = window.contentView;
  return [content hitTest:[content.superview convertPoint:point fromView:nil]];
}

PageCover CoverOf(NSView *hit) {
  if (!hit) return PageCover::none;
  NSBundle *chromium = PageClass() ? [NSBundle bundleForClass:PageClass()] : nil;
  for (NSView *v = hit; v; v = v.superview) {
    NSBundle *bundle = [NSBundle bundleForClass:v.class];
    if (bundle == chromium) return PageCover::chromium;
    if (bundle == NSBundle.mainBundle) return PageCover::reactNative;
  }
  return PageCover::other;
}

bool SeeThrough(NSView *hit) {
  for (NSView *v = hit; v; v = v.superview)
    if (v.alphaValue < 0.01 || (v.layer && v.layer.opacity < 0.01)) return true;
  return false;
}

FocusHolder HolderOf(NSWindow *window) {
  NSResponder *responder = window.firstResponder;
  if (!responder) return FocusHolder::none;
  if (responder == window) return FocusHolder::window;
  if (![responder isKindOfClass:NSView.class]) return FocusHolder::control;
  NSView *view = (NSView *)responder;
  if (view.window != window) return FocusHolder::otherWindow;
  return EnclosingPage(view) ? FocusHolder::page : FocusHolder::control;
}

bool ResponderLost(FocusHolder holder, bool clickedPage) {
  if (holder == FocusHolder::none || holder == FocusHolder::otherWindow) return true;
  return clickedPage && holder == FocusHolder::window;
}

HoverReason PageReason(HoverCheck &check, NSWindow *window, NSPoint point, NSView *page, bool click) {
  const bool active = check.windowKey || check.windowMain;
  if ((check.activation.frontmost || check.activation.runningActive) && !check.activation.appActive) return HoverReason::halfActive;
  if (click && page && check.menuActive && !MenuShown(window)) return HoverReason::staleMenu;
  if (page && PageIgnoresMove(page, window, point)) {
    if (!active) return HoverReason::notKeyOrMain;
    NSView *hit = HitAt(window, point);
    if (EnclosingPage(hit)) return HoverReason::fine;
    check.cover = CoverOf(hit);
    check.coverClear = SeeThrough(hit);
    return HoverReason::coveredByView;
  }
  if (check.windowKey && ResponderLost(check.holder, click && page)) return HoverReason::responderLost;
  return HoverReason::fine;
}

HoverCheck Probe(NSWindow *window, NSPoint point, bool click) {
  HoverCheck check;
  check.activation = CurrentActivation();
  check.key = KindOf(NSApp.keyWindow);
  check.main = KindOf(NSApp.mainWindow);
  check.preventKey = PreventsKey(window);
  check.canKey = window.canBecomeKeyWindow;
  check.menuActive = MenuActive(window);
  check.windowKey = window.isKeyWindow;
  check.windowMain = window.isMainWindow;
  NSView *page = PageAt(window, point);
  check.overPage = page != nil;
  check.holder = HolderOf(window);
  check.reason = PageReason(check, window, point, page, click);
  return check;
}

bool IsProblem(const HoverCheck &check, HoverTrigger trigger) {
  switch (check.reason) {
    case HoverReason::fine: return false;
    case HoverReason::notKeyOrMain:
      if (trigger == HoverTrigger::click)
        return check.key != FocusWindowKind::popup && check.key != FocusWindowKind::ardiaPanel && check.key != FocusWindowKind::internal &&
               !NSApp.modalWindow;
      return Unseen(check.key) && Unseen(check.main);
    case HoverReason::coveredByView: return check.cover != PageCover::reactNative || check.coverClear;
    case HoverReason::halfActive:
    case HoverReason::staleMenu:
    case HoverReason::responderLost:
    case HoverReason::coveredByWindow: return true;
  }
}

HealRefusal PanelOrSheetRefusal() {
  if (NSApp.modalWindow) return HealRefusal::modalWindow;
  for (NSWindow *window in NSApp.windows) {
    if (window.attachedSheet) return HealRefusal::attachedSheet;
    if (window.isVisible && [window isKindOfClass:NSSavePanel.class]) return HealRefusal::savePanel;
  }
  return HealRefusal::none;
}

constexpr double kFullScreenMoveLongest = 5;

NSMapTable<NSWindow *, NSNumber *> *FullScreenMoves() {
  static NSMapTable<NSWindow *, NSNumber *> *moving = [NSMapTable weakToStrongObjectsMapTable];
  return moving;
}

bool FullScreenMoving() {
  for (NSNumber *since in FullScreenMoves().objectEnumerator)
    if (NSProcessInfo.processInfo.systemUptime - since.doubleValue < kFullScreenMoveLongest) return true;
  return false;
}

bool OtherArdiaWindowActive(NSWindow *window) {
  for (NSWindow *other in NSApp.windows) {
    if (other == window || !(other.isKeyWindow || other.isMainWindow)) continue;
    if (KindOf(other) != FocusWindowKind::hidden && KindOf(other) != FocusWindowKind::blockerPage && [ArdiaWindowController forNSWindow:other])
      return true;
  }
  return false;
}

HealRefusal GuardRefusal(NSWindow *window, const HoverCheck &check, MenuWindowInfo *menuWindow) {
  if (!window.isVisible) return HealRefusal::notVisible;
  if (!window.isOnActiveSpace) return HealRefusal::notOnActiveSpace;
  if (!check.activation.inFront()) return HealRefusal::notInFront;
  const HealRefusal panel = PanelOrSheetRefusal();
  if (panel != HealRefusal::none) return panel;
  if (check.menuActive) return HealRefusal::menuActive;
  if (MenuShown(window, menuWindow)) return HealRefusal::menuShown;
  if (FullScreenMoving()) return HealRefusal::fullScreenMoving;
  return HealRefusal::none;
}

bool SafeToHeal(NSWindow *window, const HoverCheck &check, HoverTrigger trigger, HealRefusal *refusedBy, MenuWindowInfo *menuWindow) {
  HealRefusal refusal = GuardRefusal(window, check, menuWindow);
  if (refusal == HealRefusal::none) {
    if (check.reason == HoverReason::halfActive) {
      if (trigger != HoverTrigger::click) refusal = HealRefusal::notClick;
      else if (check.key == FocusWindowKind::popup) refusal = HealRefusal::keyPopup;
    } else if (check.reason == HoverReason::responderLost) {
      if (trigger != HoverTrigger::click) refusal = HealRefusal::notClick;
      else if (!(check.overPage && check.windowKey)) refusal = HealRefusal::notEligible;
    } else if (!(check.reason == HoverReason::notKeyOrMain && check.activation.appActive && Unseen(check.key) && !OtherArdiaWindowActive(window))) {
      refusal = HealRefusal::notEligible;
    }
  }
  if (refusedBy) *refusedBy = refusal;
  return refusal == HealRefusal::none;
}

HoverEpisode gEpisode;
HoverReason gPendingReason = HoverReason::fine;
__weak NSWindow *gPendingWindow;
NSUInteger gEpisodeCount = 0;
NSString *gLastHoverVerdict;
double gLastMoveCheck = 0;
id gHoverMonitor;
bool gHoverWatchInBackground = false;
NSMutableArray<NSDictionary *> *gDevHoverEvents;
constexpr double kMoveCheckEvery = 2;
constexpr double kHealRecheckAfter = 0.3;
constexpr NSUInteger kDevHoverEventsKept = 16;

double Uptime() {
  return NSProcessInfo.processInfo.systemUptime;
}

NSString *DescribeCheck(const HoverCheck &check, HoverTrigger trigger) {
  static NSDateFormatter *clock = [] {
    NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
    formatter.dateFormat = @"HH:mm:ss";
    return formatter;
  }();
  NSMutableArray<NSString *> *facts = [NSMutableArray arrayWithObjects:ReasonName(check.reason), TriggerName(trigger),
                                                                       [@"key=" stringByAppendingString:KindName(check.key)],
                                                                       [@"main=" stringByAppendingString:KindName(check.main)], nil];
  const Activation &a = check.activation;
  [facts addObject:[NSString stringWithFormat:@"active=%d/%d/%d", a.appActive, a.runningActive, a.frontmost]];
  if (a.half()) [facts addObject:@"halfActive"];
  if (check.windowKey) [facts addObject:@"windowKey"];
  if (check.windowMain) [facts addObject:@"windowMain"];
  if (check.preventKey) [facts addObject:@"preventKey"];
  if (check.canKey) [facts addObject:@"canKey"];
  if (check.menuActive) [facts addObject:@"menuActive"];
  if (check.overPage) [facts addObject:@"overPage"];
  [facts addObject:[@"responder=" stringByAppendingString:HolderName(check.holder)]];
  if (check.cover != PageCover::none) [facts addObject:[@"cover=" stringByAppendingString:CoverName(check.cover)]];
  if (check.coverWindow != FocusWindowKind::none) [facts addObject:[@"coverWindow=" stringByAppendingString:KindName(check.coverWindow)]];
  if (check.coverClear) [facts addObject:@"coverClear"];
  return [NSString stringWithFormat:@"%@ at %@", [facts componentsJoinedByString:@" "], [clock stringFromDate:NSDate.date]];
}

void CloseEpisode(NSString *endedBy) {
  if (!gEpisode.open) return;
  const HoverCheck &first = gEpisode.first;
  NSDictionary *payload = @{
    @"reason" : ReasonName(first.reason),
    @"trigger" : TriggerName(gEpisode.trigger),
    @"keyWindow" : KindName(first.key),
    @"mainWindow" : KindName(first.main),
    @"preventKey" : @(first.preventKey),
    @"canKey" : @(first.canKey),
    @"windowMain" : @(first.windowMain),
    @"halfActive" : @(first.activation.half()),
    @"appActive" : @(first.activation.appActive),
    @"runningActive" : @(first.activation.runningActive),
    @"frontmost" : @(first.activation.frontmost),
    @"menuActive" : @(first.menuActive),
    @"overPage" : @(first.overPage),
    @"cover" : CoverName(first.cover),
    @"coverClear" : @(first.coverClear),
    @"responder" : HolderName(first.holder),
    @"coverWindow" : KindName(first.coverWindow),
    @"healed" : @(gEpisode.healed),
    @"healWorked" : gEpisode.healWorked < 0 ? NSNull.null : @(gEpisode.healWorked == 1),
    @"healRefused" : HealRefusalName(gEpisode.firstRefusal),
    @"healRefusedLast" : HealRefusalName(gEpisode.lastRefusal),
    @"healRefusedWindow" : MenuWindowName(gEpisode.refusedWindow),
    @"otherWindowClicks" : @(gEpisode.otherWindowClicks),
    @"endedBy" : endedBy,
    @"seconds" : @(lround(MAX(0, Uptime() - gEpisode.startedAt))),
    @"episode" : @(gEpisodeCount),
  };
  ArdiaConsentStamp *stamp = gEpisode.stamp;
  gEpisode = HoverEpisode{};
  gPendingReason = HoverReason::fine;
  NoteFocusChange([@"hover episode ended by " stringByAppendingString:endedBy], nil);
  if (!gDevHoverEvents) gDevHoverEvents = [NSMutableArray array];
  [gDevHoverEvents addObject:payload];
  if (gDevHoverEvents.count > kDevHoverEventsKept) [gDevHoverEvents removeObjectAtIndex:0];
  [ArdiaEvents emit:@"engine.hoverLost" data:[stamp onto:payload]];
}

bool Recovered(const HoverCheck &check, HoverReason healed) {
  if (healed == HoverReason::responderLost && check.holder != FocusHolder::page) return false;
  return check.reason == HoverReason::fine && !check.activation.half() && check.windowKey;
}

NSView *PageUnder(NSWindow *window, NSPoint point) {
  NSView *page = EnclosingPage(HitAt(window, point));
  return page && page.window == window && !page.isHiddenOrHasHiddenAncestor ? page : nil;
}

bool SystemSeesUsFrontmost() {
  NSRunningApplication *me = NSRunningApplication.currentApplication;
  return !Background() && me.isActive && [NSWorkspace.sharedWorkspace.frontmostApplication isEqual:me];
}

void ReplayMissedActivation() {
  if (NSApp.isActive || !SystemSeesUsFrontmost()) return;
  NSEvent *activated = [NSEvent otherEventWithType:NSEventTypeAppKitDefined location:NSZeroPoint modifierFlags:0 timestamp:Uptime()
                                      windowNumber:0 context:nil subtype:NSEventSubtypeApplicationActivated data1:0 data2:0];
  [NSApp sendEvent:activated];
}

void Heal(NSWindow *window, NSPoint point, HoverReason reason) {
  gEpisode.healed = true;
  NoteFocusChange([@"hover heal " stringByAppendingString:ReasonName(reason)], window);
  if (reason == HoverReason::responderLost) {
    if (NSView *page = PageUnder(window, point)) [window makeFirstResponder:page];
  } else {
    if (PreventsKey(window)) [window setValue:@NO forKey:@"preventKeyWindow"];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    if (reason == HoverReason::halfActive) ReplayMissedActivation();
    if (reason == HoverReason::halfActive && !NSApp.isActive) [NSApp activateIgnoringOtherApps:YES];
#pragma clang diagnostic pop
    [window makeKeyAndOrderFront:nil];
  }
  const NSUInteger serial = gEpisode.serial;
  __weak NSWindow *weakWindow = window;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kHealRecheckAfter * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    NSWindow *healedWindow = weakWindow;
    if (!gEpisode.open || gEpisode.serial != serial) return;
    if (!healedWindow) return CloseEpisode(@"windowClosed");
    const HoverCheck after = Probe(healedWindow, point, false);
    gLastHoverVerdict = DescribeCheck(after, HoverTrigger::recheck);
    gEpisode.healWorked = Recovered(after, reason) ? 1 : 0;
    if (gEpisode.healWorked == 1) CloseEpisode(@"heal");
  });
}

__weak NSWindow *gInvisibleCover;

bool CoverStillCatchesClicks() {
  NSWindow *cover = gInvisibleCover;
  return cover && cover.isVisible && !cover.ignoresMouseEvents && cover.alphaValue < 0.01;
}

bool EndsEpisode(const HoverCheck &check) {
  if (check.reason != HoverReason::fine) return false;
  switch (gEpisode.first.reason) {
    case HoverReason::coveredByView: return check.overPage;
    case HoverReason::halfActive: return !check.activation.half() && (check.windowKey || check.windowMain);
    case HoverReason::notKeyOrMain: return check.windowKey || (check.windowMain && gEpisode.trigger == HoverTrigger::move);
    case HoverReason::coveredByWindow: return !CoverStillCatchesClicks();
    default: return true;
  }
}

void OpenEpisode(NSWindow *window, const HoverCheck &check, HoverTrigger trigger, ArdiaConsentStamp *stamp) {
  gEpisode = HoverEpisode{};
  gEpisode.open = true;
  gEpisode.owner = window;
  gEpisode.serial = ++gEpisodeCount;
  gEpisode.first = check;
  gEpisode.trigger = trigger;
  gEpisode.startedAt = Uptime();
  gEpisode.stamp = stamp;
  NoteFocusChange([@"hover lost: " stringByAppendingString:ReasonName(check.reason)], window);
}

void NoteHealRefusal(HealRefusal refusal, const MenuWindowInfo &menuWindow) {
  if (gEpisode.firstRefusal == HealRefusal::none) gEpisode.firstRefusal = refusal;
  gEpisode.lastRefusal = refusal;
  if (refusal == HealRefusal::menuShown && !gEpisode.refusedWindow.present) gEpisode.refusedWindow = menuWindow;
}

void HandleHoverCheck(NSWindow *window, NSPoint point, HoverTrigger trigger, ArdiaConsentStamp *stamp) {
  if (gEpisode.open && !gEpisode.owner) CloseEpisode(@"windowClosed");
  if (!window) return;
  if (gEpisode.open && gEpisode.owner != window) {
    if (trigger == HoverTrigger::click) gEpisode.otherWindowClicks++;
    return;
  }
  const HoverCheck check = Probe(window, point, trigger == HoverTrigger::click);
  if (trigger == HoverTrigger::move && !check.overPage) return;
  gLastHoverVerdict = DescribeCheck(check, trigger);
  if (!IsProblem(check, trigger)) {
    gPendingReason = HoverReason::fine;
    if (gEpisode.open && EndsEpisode(check)) CloseEpisode(gEpisode.healed && gEpisode.healWorked != 0 ? @"heal" : @"hover");
    return;
  }
  if (!gEpisode.open) {
    if (trigger == HoverTrigger::move && (gPendingReason != check.reason || gPendingWindow != window)) {
      gPendingReason = check.reason;
      gPendingWindow = window;
      return;
    }
    OpenEpisode(window, check, trigger, stamp);
  }
  if (gEpisode.healed) return;
  HealRefusal refusal = HealRefusal::none;
  MenuWindowInfo menuWindow;
  if (SafeToHeal(window, check, trigger, &refusal, &menuWindow)) Heal(window, point, check.reason);
  else NoteHealRefusal(refusal, menuWindow);
}

void HandleCoveredClick(NSWindow *browser, NSWindow *cover, NSPoint point, ArdiaConsentStamp *stamp) {
  if (gEpisode.open && !gEpisode.owner) CloseEpisode(@"windowClosed");
  if (!browser || !cover || !Invisible(cover) || !cover.isVisible) return;
  if (gEpisode.open) {
    if (gEpisode.owner != browser || gEpisode.first.reason != HoverReason::coveredByWindow || gInvisibleCover != cover) return;
    gEpisode.healed = true;
    NoteFocusChange(@"hover heal coveredByWindow: the invisible window stops taking clicks", browser);
    cover.ignoresMouseEvents = YES;
    gEpisode.healWorked = 1;
    return CloseEpisode(@"heal");
  }
  HoverCheck check = Probe(browser, point, true);
  check.reason = HoverReason::coveredByWindow;
  check.coverWindow = KindOf(cover, true);
  gLastHoverVerdict = DescribeCheck(check, HoverTrigger::click);
  gInvisibleCover = cover;
  OpenEpisode(browser, check, HoverTrigger::click, stamp);
}

NSWindow *BrowserWindowBelow(NSWindow *cover, NSPoint screenPoint) {
  bool below = false;
  for (NSWindow *window in NSApp.orderedWindows) {
    if (window == cover) {
      below = true;
      continue;
    }
    if (below && window.isVisible && NSPointInRect(screenPoint, window.frame) && IsBrowserWindow(window) && !Invisible(window)) return window;
  }
  return nil;
}

NSPoint ScreenPoint(NSEvent *event) {
  return event.window ? [event.window convertPointToScreen:event.locationInWindow] : NSEvent.mouseLocation;
}

NSWindow *InvisibleCoverFor(NSEvent *event) {
  NSWindow *under = [NSApp windowWithWindowNumber:[NSWindow windowNumberAtPoint:ScreenPoint(event) belowWindowWithWindowNumber:0]];
  if (!under && gHoverWatchInBackground) under = event.window;
  if (!under || IsBrowserWindow(under) || !under.isVisible || under.alphaValue >= 0.01 || under.ignoresMouseEvents) return nil;
  return under;
}

NSWindow *BrowserWindowFor(NSEvent *event) {
  NSWindow *under = [NSApp windowWithWindowNumber:[NSWindow windowNumberAtPoint:NSEvent.mouseLocation belowWindowWithWindowNumber:0]];
  if (IsBrowserWindow(under)) return under;
  if (under || !gHoverWatchInBackground) return nil;
  return IsBrowserWindow(event.window) ? event.window : nil;
}

NSPoint PointIn(NSWindow *window, NSEvent *event) {
  if (event.window == window) return event.locationInWindow;
  return [window convertPointFromScreen:NSEvent.mouseLocation];
}

void StopHoverWatch() {
  if (gHoverMonitor) [NSEvent removeMonitor:gHoverMonitor];
  gHoverMonitor = nil;
}

void StartHoverWatch() {
  if (gHoverMonitor || (Background() && !gHoverWatchInBackground)) return;
  gHoverMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskMouseMoved | NSEventMaskLeftMouseDown
                                                        handler:^NSEvent *(NSEvent *event) {
    const bool move = event.type == NSEventTypeMouseMoved;
    if (move && Uptime() - gLastMoveCheck < kMoveCheckEvery) return event;
    if (move) gLastMoveCheck = Uptime();
    if (!move && (event.modifierFlags & NSEventModifierFlagCommand)) return event;
    if (!CurrentActivation().inFront()) return event;
    ArdiaConsentStamp *stamp = [ArdiaConsentStamp begin];
    NSWindow *window = BrowserWindowFor(event);
    if (!window && !move) {
      NSWindow *cover = InvisibleCoverFor(event);
      NSWindow *browser = cover ? BrowserWindowBelow(cover, ScreenPoint(event)) : nil;
      if (!browser) return event;
      const NSPoint point = [browser convertPointFromScreen:ScreenPoint(event)];
      __weak NSWindow *weakBrowser = browser, *weakCover = cover;
      dispatch_async(dispatch_get_main_queue(), ^{ HandleCoveredClick(weakBrowser, weakCover, point, stamp); });
      return event;
    }
    if (!window) return event;
    const NSPoint point = PointIn(window, event);
    __weak NSWindow *weakWindow = window;
    dispatch_async(dispatch_get_main_queue(), ^{ HandleHoverCheck(weakWindow, point, move ? HoverTrigger::move : HoverTrigger::click, stamp); });
    return event;
  }];
}

void EndEpisodeIfInactive() {
  if (!CurrentActivation().inFront()) CloseEpisode(@"appInactive");
}

}

using namespace hover_probe;

NSString *HoverProbeLine() {
  const Activation a = CurrentActivation();
  return [NSString stringWithFormat:@"activation app %d running %d frontmost %d%@\nhover %@, episodes %lu%@", a.appActive, a.runningActive,
                                    a.frontmost, a.half() ? @" (half active)" : @"", gLastHoverVerdict ?: @"not checked",
                                    (unsigned long)gEpisodeCount,
                                    gEpisode.open ? [@", lost now: " stringByAppendingString:ReasonName(gEpisode.first.reason)] : @""];
}

void WatchHover() {
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  [center addObserverForName:NSApplicationDidResignActiveNotification object:nil queue:nil usingBlock:^(NSNotification *) {
    EndEpisodeIfInactive();
  }];
  [center addObserverForName:NSWindowWillCloseNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
    if (gEpisode.open && note.object == gEpisode.owner) CloseEpisode(@"windowClosed");
  }];
  for (NSNotificationName name in @[ NSWindowWillEnterFullScreenNotification, NSWindowWillExitFullScreenNotification ])
    [center addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *note) {
      [FullScreenMoves() setObject:@(NSProcessInfo.processInfo.systemUptime) forKey:note.object];
    }];
  for (NSNotificationName name in @[ NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification ])
    [center addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *note) { [FullScreenMoves() removeObjectForKey:note.object]; }];
  [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceDidActivateApplicationNotification object:nil queue:nil
                                                          usingBlock:^(NSNotification *) { EndEpisodeIfInactive(); }];
  StartHoverWatch();
}

}
