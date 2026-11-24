#pragma once

#import <AppKit/AppKit.h>

#import "ArdiaEvents.h"

namespace ardia_host::hover_probe {

enum class HoverReason { fine, halfActive, staleMenu, notKeyOrMain, coveredByView, responderLost, coveredByWindow };
enum class FocusWindowKind { none, hidden, blockerPage, internal, ardiaPanel, popup, browser, other };
enum class PageCover { none, reactNative, chromium, other };
enum class HoverTrigger { move, click, recheck };
enum class FocusHolder { none, window, otherWindow, page, control };

enum class HealRefusal {
  none,
  notVisible,
  notOnActiveSpace,
  notInFront,
  modalWindow,
  attachedSheet,
  savePanel,
  menuActive,
  menuShown,
  fullScreenMoving,
  notClick,
  keyPopup,
  notEligible
};

enum class MenuWindowKind { window, panel, menu, sharing, tooltip, popover, fullScreen, ardia, other };
enum class MenuWindowLevel { normal, floating, raised, popUp };
enum class MenuWindowParent { none, browser, other };

struct MenuWindowInfo {
  bool present = false;
  MenuWindowKind kind = MenuWindowKind::other;
  MenuWindowLevel level = MenuWindowLevel::normal;
  MenuWindowParent parent = MenuWindowParent::none;
};

struct Activation {
  bool appActive = false;
  bool runningActive = false;
  bool frontmost = false;
  bool inFront() const { return appActive || runningActive || frontmost; }
  bool half() const { return appActive != runningActive || runningActive != frontmost; }
};

struct HoverCheck {
  HoverReason reason = HoverReason::fine;
  Activation activation;
  FocusWindowKind key = FocusWindowKind::none;
  FocusWindowKind main = FocusWindowKind::none;
  PageCover cover = PageCover::none;
  FocusWindowKind coverWindow = FocusWindowKind::none;
  FocusHolder holder = FocusHolder::none;
  bool coverClear = false;
  bool preventKey = false;
  bool canKey = false;
  bool menuActive = false;
  bool windowKey = false;
  bool windowMain = false;
  bool overPage = false;
};

struct HoverEpisode {
  bool open = false;
  __weak NSWindow *owner = nil;
  NSUInteger serial = 0;
  HoverCheck first;
  HoverTrigger trigger = HoverTrigger::move;
  double startedAt = 0;
  bool healed = false;
  int healWorked = -1;
  HealRefusal firstRefusal = HealRefusal::none;
  HealRefusal lastRefusal = HealRefusal::none;
  MenuWindowInfo refusedWindow;
  NSUInteger otherWindowClicks = 0;
  ArdiaConsentStamp *stamp = nil;
};

extern bool gDevHalfActive;
extern bool gDevMenuActive;
extern HoverEpisode gEpisode;
extern HoverReason gPendingReason;
extern NSString *gLastHoverVerdict;
extern id gHoverMonitor;
extern bool gHoverWatchInBackground;
extern NSMutableArray<NSDictionary *> *gDevHoverEvents;

NSString *ReasonName(HoverReason reason);
NSString *HolderName(FocusHolder holder);
NSString *HealRefusalName(HealRefusal refusal);
NSString *MenuWindowName(const MenuWindowInfo &info);
bool WindowFlag(NSWindow *window, NSString *name);
bool MenuActive(NSWindow *window);
bool MenuShown(NSWindow *browser, MenuWindowInfo *matched = nullptr);
NSView *PageAt(NSWindow *window, NSPoint point);
NSView *EnclosingPage(NSView *view);
NSView *HitAt(NSWindow *window, NSPoint point);
bool SeeThrough(NSView *hit);
FocusHolder HolderOf(NSWindow *window);
bool ResponderLost(FocusHolder holder, bool clickedPage);
void HandleHoverCheck(NSWindow *window, NSPoint point, HoverTrigger trigger, ArdiaConsentStamp *stamp);
void StartHoverWatch();
void StopHoverWatch();

}
