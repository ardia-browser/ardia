#import "ArdiaWebViewInternal.h"
#import "ArdiaEarlyWindow.h"
#import "ArdiaPaintProbeMath.h"
#import "ArdiaWindowController.h"

#include <vector>

@interface ArdiaWebView (PaintProbe)
- (unsigned)paintProbeReasons;
- (unsigned)paintProbeHeldMs;
@end

@implementation ArdiaWebView (PaintProbe)

- (unsigned)paintProbeReasons {
  NSView *page = _tab.view;
  NSView *lent = _standIn.page;
  ardia_paint_probe::View state;
  state.alphaZero = self.alphaValue <= 0.01;
  state.viewHidden = self.isHiddenOrHasHiddenAncestor;
  state.pageHidden = page && page.isHiddenOrHasHiddenAncestor;
  state.pageDetached = !page || page.superview != self;
  state.awaitingFrame = _frameHold.awaiting;
  state.standInLent = _standIn.lentTo || _standIn.tab || _standIn.page;
  state.standInLeaving = _standIn.leaving;
  ardia_paint_probe::StandInLayer layer;
  layer.attached = lent && lent.superview == self;
  layer.hidden = lent.isHiddenOrHasHiddenAncestor;
  layer.alpha = MIN(lent.alphaValue, lent.layer ? lent.layer.opacity : 1);
  layer.pageShown = page && page != lent && page.superview == self && !page.isHiddenOrHasHiddenAncestor &&
                    !ardia_paint_probe::Invisible(NO, page.alphaValue, page.layer ? page.layer.opacity : 1);
  if (layer.attached && layer.pageShown) {
    NSArray<NSView *> *order = self.subviews;
    layer.abovePage = ardia_paint_probe::DrawnAbove({{lent.layer.zPosition, [order indexOfObjectIdenticalTo:lent]}},
                                                    {{page.layer.zPosition, [order indexOfObjectIdenticalTo:page]}});
  }
  state.standInShowing = ardia_paint_probe::StandInShows(layer);
  state.veilUp = [ArdiaEarlyWindow veils:_tab];
  return ardia_paint_probe::ReasonsOf(state);
}

- (unsigned)paintProbeHeldMs {
  const BOOL holding = _standIn.tab || _standIn.page;
  const BOOL lending = _standIn.lentTo != nil;
  const CFTimeInterval since = ardia_paint_probe::EarliestHold(_frameHold.awaiting ? _frameHold.tookOverAt : 0,
                                                               holding ? _standIn.heldSince : 0, lending ? _standIn.lentSince : 0);
  return ardia_paint_probe::HeldMs(CACurrentMediaTime(), since);
}

@end

@interface ArdiaPaintWatch : NSObject {
 @public
  ardia_paint_probe::Episode _episode;
  ardia_paint_probe::FollowUp _followUp;
  NSUInteger _generation;
  NSDictionary<NSString *, id> *_held;
  ArdiaConsentStamp *_heldStamp;
}
@end

@implementation ArdiaPaintWatch
@end

namespace ardia_host {

namespace {

constexpr NSTimeInterval kPaintCheckAfter = 0.5;
constexpr NSTimeInterval kPaintCheckAfterProfileSwitch = 1.5;
constexpr NSTimeInterval kPaintFollowUpAfter = 2.0;

NSString *gLastPaintCheck;
NSString *gLastPaintRecord;
NSUInteger gPaintEpisodeCount = 0;

NSMapTable<NSWindow *, ArdiaPaintWatch *> *PaintWatches() {
  static NSMapTable *watches = [NSMapTable weakToStrongObjectsMapTable];
  return watches;
}

NSString *ReasonNames(unsigned reasons) {
  if (!reasons) return @"none";
  NSArray<NSString *> *names = @[
    @"alpha 0", @"view hidden", @"page hidden", @"page detached", @"frame hold", @"stand-in lent", @"stand-in leaving", @"veil",
    @"stand-in showing"
  ];
  NSMutableArray<NSString *> *found = [NSMutableArray array];
  for (unsigned bit = 0; bit < ardia_paint_probe::kReasonCount; bit++)
    if (reasons & (1u << bit)) [found addObject:names[bit]];
  return [found componentsJoinedByString:@", "];
}

NSString *DescribePaint(NSDictionary *record) {
  NSString *line = [NSString stringWithFormat:@"%@ window of %@, trigger %@, seen %d, occlusion %@, overruled %d, app active %d, views %@, unpainted %@ (%@), held %@ ms",
                                              record[@"window"], record[@"windows"], record[@"trigger"], [record[@"seen"] boolValue], record[@"occlusion"],
                                              [record[@"overruled"] boolValue], [record[@"appActive"] boolValue], record[@"views"], record[@"unpainted"],
                                              ReasonNames([record[@"reasons"] unsignedIntValue]), record[@"heldMs"]];
  if (record[@"webkitViews"])
    line = [line stringByAppendingFormat:@", webkit views %@ on top %d", record[@"webkitViews"], [record[@"webkitOnTop"] boolValue]];
  if (record[@"stillUnpainted"])
    line = [line stringByAppendingFormat:@", still unpainted %@ (%@)", record[@"stillUnpainted"], ReasonNames([record[@"stillReasons"] unsignedIntValue])];
  return line;
}

NSUInteger OpenWindowCount() {
  NSUInteger open = 0;
  for (ArdiaWindowController *controller in [ArdiaWindowController all])
    if (controller.coreWindow.window.isVisible) open++;
  return open;
}

ardia_paint_probe::Tally TallyWindow(NSWindow *window) {
  ardia_paint_probe::Tally tally;
  for (ArdiaWebView *view in ardia_web_view::LiveViews().allObjects)
    if (view.window == window && view.visible) tally.Add([view paintProbeReasons], [view paintProbeHeldMs]);
  return tally;
}

struct PlacedTab {
  NSView *view;
  ardia_paint_probe::StackPath path;
};

void CollectShownTabs(NSView *parent, const ardia_paint_probe::StackPath &above, Class webKitTab, std::vector<PlacedTab> &webKit,
                      std::vector<PlacedTab> &chromium) {
  unsigned long index = 0;
  for (NSView *child in parent.subviews) {
    ardia_paint_probe::StackPath path = above;
    path.push_back({child.layer.zPosition, index++});
    if (ardia_paint_probe::Invisible(child.hidden, child.alphaValue, child.layer ? child.layer.opacity : 1)) continue;
    if (webKitTab && [child isKindOfClass:webKitTab]) webKit.push_back({child, path});
    else if ([child isKindOfClass:ArdiaWebView.class]) {
      if (((ArdiaWebView *)child).visible) chromium.push_back({child, path});
    } else CollectShownTabs(child, path, webKitTab, webKit, chromium);
  }
}

void CountWebKitTabs(NSWindow *window, NSUInteger *shown, bool *onTop) {
  *shown = 0;
  *onTop = false;
  Class webKitTab = NSClassFromString(@"ArdiaCore.WebKitTab") ?: NSClassFromString(@"WebKitTab");
  if (!webKitTab || !window.contentView) return;
  std::vector<PlacedTab> webKit, chromium;
  CollectShownTabs(window.contentView, {}, webKitTab, webKit, chromium);
  *shown = webKit.size();
  for (const PlacedTab &tab : webKit)
    for (const PlacedTab &view : chromium)
      if (ardia_paint_probe::DrawnAbove(tab.path, view.path) &&
          NSIntersectsRect([tab.view convertRect:tab.view.bounds toView:nil], [view.view convertRect:view.view.bounds toView:nil]))
        *onTop = true;
}

void SendHeldPaintRecord(ArdiaPaintWatch *watch, NSDictionary<NSString *, id> *followUp) {
  NSDictionary<NSString *, id> *held = watch->_held;
  ArdiaConsentStamp *stamp = watch->_heldStamp;
  watch->_held = nil;
  watch->_heldStamp = nil;
  watch->_followUp.Drop();
  if (!held || !stamp) return;
  NSMutableDictionary<NSString *, id> *record = [held mutableCopy];
  if (followUp) [record addEntriesFromDictionary:followUp];
  gLastPaintRecord = DescribePaint(record);
  [ArdiaEvents emit:@"engine.windowUnpainted" data:[stamp onto:record]];
}

void CheckStillUnpainted(NSWindow *window) {
  ArdiaPaintWatch *watch = [PaintWatches() objectForKey:window];
  if (!watch || !watch->_held) return;
  ArdiaWindowController *owner = [ArdiaWindowController forNSWindow:window];
  if (!owner || owner.coreWindow.window != window) return SendHeldPaintRecord(watch, nil);
  const ardia_paint_probe::Tally still = TallyWindow(window);
  watch->_episode.Settle(still);
  SendHeldPaintRecord(watch, @{@"stillUnpainted" : @(still.unpainted), @"stillReasons" : @(still.reasons)});
}

void CheckPainting(NSWindow *window, NSString *trigger, ArdiaConsentStamp *stamp) {
  ArdiaWindowController *owner = [ArdiaWindowController forNSWindow:window];
  ArdiaPaintWatch *watch = [PaintWatches() objectForKey:window];
  if (!owner || owner.coreWindow.window != window || !watch) return;
  const ardia_paint_probe::Tally tally = TallyWindow(window);
  const bool appKitShows = (window.occlusionState & NSWindowOcclusionStateVisible) != 0;
  NSMutableDictionary<NSString *, id> *record = [@{
    @"window" : owner.coreWindow.activeProfile.offTheRecord ? @"private" : @"regular",
    @"trigger" : trigger,
    @"seen" : @([ArdiaWindowController userSees:window]),
    @"occlusion" : appKitShows ? @"visible" : @"occluded",
    @"overruled" : @([ArdiaWindowController userSeesOnlyThroughWindowServer:window]),
    @"appActive" : @(NSApp.isActive),
    @"windows" : @(OpenWindowCount()),
    @"views" : @(tally.views),
    @"unpainted" : @(tally.unpainted),
    @"reasons" : @(tally.reasons),
    @"heldMs" : @(tally.heldMs),
  } mutableCopy];
  gLastPaintCheck = DescribePaint(record);
  if (!watch->_episode.ShouldSend(tally)) return;
  gPaintEpisodeCount++;
  NSUInteger webKitShown = 0;
  bool webKitOnTop = false;
  CountWebKitTabs(window, &webKitShown, &webKitOnTop);
  record[@"webkitViews"] = @(webKitShown);
  record[@"webkitOnTop"] = @(webKitOnTop);
  gLastPaintRecord = DescribePaint(record);
  SendHeldPaintRecord(watch, nil);
  watch->_held = record;
  watch->_heldStamp = stamp;
  const unsigned long due = watch->_followUp.Hold();
  __weak NSWindow *weakWindow = window;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kPaintFollowUpAfter * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    NSWindow *checked = weakWindow;
    ArdiaPaintWatch *current = checked ? [PaintWatches() objectForKey:checked] : nil;
    if (current && current->_followUp.Take(due)) CheckStillUnpainted(checked);
  });
}

void SchedulePaintCheck(NSWindow *window, NSString *trigger, NSTimeInterval after = kPaintCheckAfter) {
  if (![window isKindOfClass:NSWindow.class] || ![ArdiaWindowController forNSWindow:window]) return;
  ArdiaPaintWatch *watch = [PaintWatches() objectForKey:window];
  if (!watch) {
    watch = [[ArdiaPaintWatch alloc] init];
    [PaintWatches() setObject:watch forKey:window];
  }
  const NSUInteger generation = ++watch->_generation;
  ArdiaConsentStamp *stamp = ArdiaConsentStamp.begin;
  __weak NSWindow *weakWindow = window;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(after * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    NSWindow *checked = weakWindow;
    ArdiaPaintWatch *current = checked ? [PaintWatches() objectForKey:checked] : nil;
    if (current && current->_generation == generation) CheckPainting(checked, trigger, stamp);
  });
}

}

void CheckPaintingAfterProfileSwitch(NSWindow *window) {
  if (window) SchedulePaintCheck(window, @"profileSwitch", kPaintCheckAfterProfileSwitch);
}

NSString *PaintProbeLine() {
  return [NSString stringWithFormat:@"paint last check %@\npaint unpainted episodes %lu%@", gLastPaintCheck ?: @"not checked",
                                    (unsigned long)gPaintEpisodeCount,
                                    gLastPaintRecord ? [@", latest: " stringByAppendingString:gLastPaintRecord] : @""];
}

void WatchPainting() {
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  [center addObserverForName:ArdiaWindowSeenDidChange object:nil queue:nil usingBlock:^(NSNotification *note) {
    SchedulePaintCheck(note.object, @"seen");
  }];
  for (NSNotificationName name in @[ NSWindowDidBecomeKeyNotification, NSWindowDidResignKeyNotification ])
    [center addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *note) { SchedulePaintCheck(note.object, @"key"); }];
  [center addObserverForName:NSWindowWillCloseNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
    if (![note.object isKindOfClass:NSWindow.class]) return;
    ArdiaPaintWatch *watch = [PaintWatches() objectForKey:note.object];
    if (watch) SendHeldPaintRecord(watch, nil);
    [PaintWatches() removeObjectForKey:note.object];
  }];
}

}
