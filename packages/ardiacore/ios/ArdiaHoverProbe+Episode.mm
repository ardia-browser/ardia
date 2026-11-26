#import "ArdiaHoverProbeInternal.h"
#import "ArdiaInternal.h"

namespace ardia_host {

namespace hover_probe {

namespace {

constexpr NSUInteger kDevHoverEventsKept = 16;
NSUInteger gReportedAtQuit = 0;
bool gQuitWindowClosed = false;

}

void ClearQuitReport() {
  gReportedAtQuit = 0;
  gQuitWindowClosed = false;
}

bool DeferWindowCloseForQuit() {
  if (!HoverEpisodeReportedAtQuitOpen()) return false;
  gQuitWindowClosed = true;
  return true;
}

bool QuitWindowClosedPending() {
  return gQuitWindowClosed && HoverEpisodeReportedAtQuitOpen();
}

NSDictionary *EpisodePayload(NSString *endedBy) {
  const HoverCheck &first = gEpisode.first;
  return @{
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
    @"coverView" : CoverViewName(first.coverView),
    @"coverClearView" : CoverViewName(first.coverClearView),
    @"coverSize" : CoverSizeName(first.coverSize),
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
    @"serial" : @(gEpisode.serial),
  };
}

void EmitEpisode(NSDictionary *payload, ArdiaConsentStamp *stamp) {
  if (!gDevHoverEvents) gDevHoverEvents = [NSMutableArray array];
  [gDevHoverEvents addObject:payload];
  if (gDevHoverEvents.count > kDevHoverEventsKept) [gDevHoverEvents removeObjectAtIndex:0];
  [ArdiaEvents emit:@"engine.hoverLost" data:[stamp onto:payload]];
}

}

using namespace hover_probe;

void ReportHoverEpisodeAtQuit() {
  if (!gEpisode.open) return;
  NoteFocusChange(@"hover episode reported for quit", nil);
  gReportedAtQuit = gEpisode.serial;
  gQuitWindowClosed = false;
  EmitEpisode(EpisodePayload(@"quit"), gEpisode.stamp);
}

bool HoverEpisodeReportedAtQuitOpen() {
  return gReportedAtQuit != 0 && gEpisode.open && gEpisode.serial == gReportedAtQuit;
}

NSInteger HoverEpisodeReportedAtQuitSeconds() {
  if (!HoverEpisodeReportedAtQuitOpen()) return -1;
  return MIN(86400, lround(MAX(0, Uptime() - gEpisode.startedAt)));
}

void MarkHoverEpisodeCommittedAtQuit() {
  if (!HoverEpisodeReportedAtQuitOpen()) return;
  gEpisode = HoverEpisode{};
  gPendingReason = HoverReason::fine;
  ClearQuitReport();
}

void CancelHoverEpisodeAtQuit() {
  const bool windowClosed = QuitWindowClosedPending();
  ClearQuitReport();
  if (windowClosed) CloseEpisode(@"windowClosed");
}

}
