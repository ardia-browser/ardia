#import "ArdiaWebViewInternal.h"
#import "ArdiaEarlyWindow.h"
#import "ArdiaPaintProbeMath.h"
#import "ArdiaWindowController.h"

@interface ArdiaWebView (PaintProbe)
- (unsigned)paintProbeReasons;
@end

@implementation ArdiaWebView (PaintProbe)

- (unsigned)paintProbeReasons {
  NSView *page = _tab.view;
  ardia_paint_probe::View state;
  state.alphaZero = self.alphaValue <= 0.01;
  state.viewHidden = self.isHiddenOrHasHiddenAncestor;
  state.pageHidden = page && page.isHiddenOrHasHiddenAncestor;
  state.pageDetached = !page || page.superview != self;
  state.awaitingFrame = _frameHold.awaiting;
  state.standInLent = _standIn.lentTo || _standIn.tab || _standIn.page;
  state.standInLeaving = _standIn.leaving;
  state.veilUp = [ArdiaEarlyWindow veils:_tab];
  return ardia_paint_probe::ReasonsOf(state);
}

@end

@interface ArdiaPaintWatch : NSObject {
 @public
  ardia_paint_probe::Episode _episode;
  NSUInteger _generation;
}
@end

@implementation ArdiaPaintWatch
@end

namespace ardia_host {

namespace {

constexpr NSTimeInterval kPaintCheckAfter = 0.5;

NSString *gLastPaintCheck;
NSString *gLastPaintRecord;
NSUInteger gPaintEpisodeCount = 0;

NSMapTable<NSWindow *, ArdiaPaintWatch *> *PaintWatches() {
  static NSMapTable *watches = [NSMapTable weakToStrongObjectsMapTable];
  return watches;
}

NSString *ReasonNames(unsigned reasons) {
  if (!reasons) return @"none";
  NSArray<NSString *> *names =
      @[ @"alpha 0", @"view hidden", @"page hidden", @"page detached", @"frame hold", @"stand-in lent", @"stand-in leaving", @"veil" ];
  NSMutableArray<NSString *> *found = [NSMutableArray array];
  for (unsigned bit = 0; bit < ardia_paint_probe::kReasonCount; bit++)
    if (reasons & (1u << bit)) [found addObject:names[bit]];
  return [found componentsJoinedByString:@", "];
}

NSString *DescribePaint(NSDictionary *record) {
  return [NSString stringWithFormat:@"%@ window of %@, trigger %@, seen %d, occlusion %@, overruled %d, app active %d, views %@, unpainted %@ (%@)",
                                    record[@"window"], record[@"windows"], record[@"trigger"], [record[@"seen"] boolValue], record[@"occlusion"],
                                    [record[@"overruled"] boolValue], [record[@"appActive"] boolValue], record[@"views"], record[@"unpainted"],
                                    ReasonNames([record[@"reasons"] unsignedIntValue])];
}

NSUInteger OpenWindowCount() {
  NSUInteger open = 0;
  for (ArdiaWindowController *controller in [ArdiaWindowController all])
    if (controller.coreWindow.window.isVisible) open++;
  return open;
}

void CheckPainting(NSWindow *window, NSString *trigger, ArdiaConsentStamp *stamp) {
  ArdiaWindowController *owner = [ArdiaWindowController forNSWindow:window];
  ArdiaPaintWatch *watch = [PaintWatches() objectForKey:window];
  if (!owner || owner.coreWindow.window != window || !watch) return;
  ardia_paint_probe::Tally tally;
  for (ArdiaWebView *view in ardia_web_view::LiveViews().allObjects)
    if (view.window == window && view.visible) tally.Add([view paintProbeReasons]);
  const bool appKitShows = (window.occlusionState & NSWindowOcclusionStateVisible) != 0;
  NSDictionary *record = @{
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
  };
  gLastPaintCheck = DescribePaint(record);
  if (!watch->_episode.ShouldSend(tally)) return;
  gPaintEpisodeCount++;
  gLastPaintRecord = gLastPaintCheck;
  [ArdiaEvents emit:@"engine.windowUnpainted" data:[stamp onto:record]];
}

void SchedulePaintCheck(NSWindow *window, NSString *trigger) {
  if (![window isKindOfClass:NSWindow.class] || ![ArdiaWindowController forNSWindow:window]) return;
  ArdiaPaintWatch *watch = [PaintWatches() objectForKey:window];
  if (!watch) {
    watch = [[ArdiaPaintWatch alloc] init];
    [PaintWatches() setObject:watch forKey:window];
  }
  const NSUInteger generation = ++watch->_generation;
  ArdiaConsentStamp *stamp = ArdiaConsentStamp.begin;
  __weak NSWindow *weakWindow = window;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kPaintCheckAfter * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    NSWindow *checked = weakWindow;
    ArdiaPaintWatch *current = checked ? [PaintWatches() objectForKey:checked] : nil;
    if (current && current->_generation == generation) CheckPainting(checked, trigger, stamp);
  });
}

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
    if ([note.object isKindOfClass:NSWindow.class]) [PaintWatches() removeObjectForKey:note.object];
  }];
}

}
