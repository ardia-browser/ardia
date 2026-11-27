#include "ardia/mac/ac_mac_window_events.h"

#import <AppKit/AppKit.h>
#import <objc/runtime.h>

#include <utility>

#include "base/strings/sys_string_conversions.h"
#include "ui/views/widget/widget.h"

@interface ArdiaMacCloseButtonTarget : NSObject
@property(nonatomic, copy) void (^pressed)(void);
- (void)closePressed:(id)sender;
@end

@implementation ArdiaMacCloseButtonTarget
@synthesize pressed = _pressed;
- (void)closePressed:(id)sender {
  if (self.pressed) {
    self.pressed();
  }
}
@end

@interface ArdiaMacPointerExitTracker : NSObject
@property(nonatomic, copy) void (^exited)(void);
- (void)mouseExited:(NSEvent*)event;
@end

@implementation ArdiaMacPointerExitTracker
@synthesize exited = _exited;
- (void)mouseExited:(NSEvent*)event {
  if (self.exited) {
    self.exited();
  }
}
@end

namespace ardia_mac {

namespace {

const void* const kCloseTargetKey = &kCloseTargetKey;
constexpr NSTimeInterval kPointerPollSeconds = 0.1;

bool CoveredByAnotherWindow(NSWindow* target, NSPoint screen) {
  const NSInteger under = [NSWindow windowNumberAtPoint:screen belowWindowWithWindowNumber:0];
  if (under == 0 || under == target.windowNumber) {
    return false;
  }
  NSWindow* own = [NSApp windowWithWindowNumber:under];
  return !own || own.parentWindow != target;
}

WindowEvents::Pointer PointerIn(NSWindow* target) {
  const NSPoint screen = NSEvent.mouseLocation;
  const NSPoint local = [target convertPointFromScreen:screen];
  const NSRect content = [target contentRectForFrameRect:target.frame];
  WindowEvents::Pointer pointer;
  pointer.width = NSWidth(content);
  pointer.height = NSHeight(content);
  pointer.x = local.x;
  pointer.y = NSHeight(content) - local.y;
  pointer.pressed = (NSEvent.pressedMouseButtons & 1) != 0;
  pointer.covered = !NSApp.isActive || CoveredByAnotherWindow(target, screen);
  return pointer;
}

NSWindow* WindowOf(views::Widget* widget) {
  return widget ? widget->GetNativeWindow().GetNativeNSWindow() : nil;
}

}

struct WindowEvents::Native {
  NSWindow* __weak window = nil;
  Changed changed;
  Moved moved;
  NSMutableArray* observers = [NSMutableArray array];
  id pointer_monitor = nil;
  id pointer_resign = nil;
  NSTimer* pointer_poll = nil;
  NSTrackingArea* pointer_area = nil;
  ArdiaMacPointerExitTracker* pointer_tracker = nil;
  BOOL accepted_mouse_moves = NO;
  ArdiaMacCloseButtonTarget* close_target = nil;
};

WindowEvents::WindowEvents(views::Widget* widget, Changed changed, Moved moved)
    : state_(std::make_unique<Native>()) {
  NSWindow* window = WindowOf(widget);
  state_->window = window;
  state_->changed = std::move(changed);
  state_->moved = std::move(moved);
  if (!window) {
    return;
  }
  Native* state = state_.get();
  const std::pair<NSNotificationName, Kind> watched[] = {
      {NSWindowDidBecomeKeyNotification, Kind::kFocus},
      {NSWindowDidResignKeyNotification, Kind::kBlur},
      {NSWindowDidResizeNotification, Kind::kFrame},
      {NSWindowDidMoveNotification, Kind::kFrame},
      {NSWindowDidEnterFullScreenNotification, Kind::kFullScreen},
      {NSWindowDidExitFullScreenNotification, Kind::kFullScreen},
      {NSWindowDidMiniaturizeNotification, Kind::kMiniaturize},
      {NSWindowDidDeminiaturizeNotification, Kind::kDeminiaturize},
      {NSWindowWillCloseNotification, Kind::kClose},
  };
  for (const auto& [name, kind] : watched) {
    const Kind reported = kind;
    [state->observers addObject:[NSNotificationCenter.defaultCenter addObserverForName:name
                                                                                object:window
                                                                                 queue:nil
                                                                            usingBlock:^(NSNotification*) {
                                                                              state->changed.Run(reported);
                                                                            }]];
  }
  state->close_target = [[ArdiaMacCloseButtonTarget alloc] init];
  state->close_target.pressed = ^{
    state->changed.Run(Kind::kCloseButton);
  };
  objc_setAssociatedObject(window, kCloseTargetKey, state->close_target, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  RouteCloseButton();
}

WindowEvents::~WindowEvents() {
  WatchPointer(false);
  for (id observer in state_->observers) {
    [NSNotificationCenter.defaultCenter removeObserver:observer];
  }
  [state_->observers removeAllObjects];
  NSWindow* window = state_->window;
  if (state_->close_target) {
    state_->close_target.pressed = nil;
  }
  if (window) {
    NSButton* close = [window standardWindowButton:NSWindowCloseButton];
    if (close.target == state_->close_target) {
      close.target = window;
      close.action = @selector(performClose:);
    }
    objc_setAssociatedObject(window, kCloseTargetKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
}

void WindowEvents::RouteCloseButton() {
  NSWindow* window = state_->window;
  NSButton* close = window ? [window standardWindowButton:NSWindowCloseButton] : nil;
  if (!close || !state_->close_target) {
    return;
  }
  close.target = state_->close_target;
  close.action = @selector(closePressed:);
}

void WindowEvents::WatchPointer(bool on) {
  NSWindow* window = state_->window;
  if (!on) {
    PollPointer(false);
    if (state_->pointer_monitor) {
      [NSEvent removeMonitor:state_->pointer_monitor];
      state_->pointer_monitor = nil;
      if (window) {
        window.acceptsMouseMovedEvents = state_->accepted_mouse_moves;
      }
    }
    if (state_->pointer_resign) {
      [NSNotificationCenter.defaultCenter removeObserver:state_->pointer_resign];
      state_->pointer_resign = nil;
    }
    if (state_->pointer_area) {
      [window.contentView removeTrackingArea:state_->pointer_area];
      state_->pointer_area = nil;
    }
    state_->pointer_tracker.exited = nil;
    state_->pointer_tracker = nil;
    return;
  }
  if (state_->pointer_monitor || !window) {
    return;
  }
  state_->accepted_mouse_moves = window.acceptsMouseMovedEvents;
  window.acceptsMouseMovedEvents = YES;
  Native* state = state_.get();
  NSWindow* __weak watched = window;
  state_->pointer_monitor = [NSEvent
      addLocalMonitorForEventsMatchingMask:NSEventMaskMouseMoved | NSEventMaskLeftMouseDragged |
                                           NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp
                                   handler:^NSEvent*(NSEvent* event) {
                                     NSWindow* target = watched;
                                     if (target && target.isKeyWindow) {
                                       state->moved.Run(PointerIn(target));
                                     }
                                     return event;
                                   }];
  const auto report_covered = ^{
    NSWindow* target = watched;
    if (!target) {
      return;
    }
    Pointer pointer = PointerIn(target);
    if (!target.isKeyWindow) {
      pointer.covered = true;
    }
    state->moved.Run(pointer);
  };
  state_->pointer_tracker = [[ArdiaMacPointerExitTracker alloc] init];
  state_->pointer_tracker.exited = report_covered;
  state_->pointer_area = [[NSTrackingArea alloc]
      initWithRect:NSZeroRect
           options:NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways | NSTrackingInVisibleRect
             owner:state_->pointer_tracker
          userInfo:nil];
  [window.contentView addTrackingArea:state_->pointer_area];
  state_->pointer_resign = [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidResignActiveNotification
                                                                           object:NSApp
                                                                            queue:nil
                                                                       usingBlock:^(NSNotification*) {
                                                                         report_covered();
                                                                       }];
}

void WindowEvents::PollPointer(bool on) {
  if (!on || !state_->pointer_monitor) {
    [state_->pointer_poll invalidate];
    state_->pointer_poll = nil;
    return;
  }
  if (state_->pointer_poll) {
    return;
  }
  Native* state = state_.get();
  NSWindow* __weak watched = state_->window;
  state_->pointer_poll = [NSTimer scheduledTimerWithTimeInterval:kPointerPollSeconds
                                                         repeats:YES
                                                           block:^(NSTimer*) {
                                                             NSWindow* target = watched;
                                                             if (!target) {
                                                               return;
                                                             }
                                                             Pointer pointer = PointerIn(target);
                                                             if (!target.isKeyWindow) {
                                                               pointer.covered = true;
                                                             }
                                                             state->moved.Run(pointer);
                                                           }];
}

std::optional<WindowEvents::Pointer> WindowEvents::LivePointer() const {
  NSWindow* target = state_->window;
  if (!target) {
    return std::nullopt;
  }
  Pointer pointer = PointerIn(target);
  if (!target.isKeyWindow) {
    pointer.covered = true;
  }
  return pointer;
}

bool WindowEvents::Focused() const {
  NSWindow* window = state_->window;
  return window && window.isKeyWindow;
}

window_policy::WindowState WindowEvents::State() const {
  NSWindow* window = state_->window;
  if (!window) {
    return {};
  }
  return window_policy::StateOf(window.isZoomed, FullScreen(), window.isMiniaturized);
}

std::vector<window_policy::Frame> WindowEvents::Screens() const {
  std::vector<window_policy::Frame> screens;
  NSArray<NSScreen*>* all = NSScreen.screens;
  if (all.count == 0) {
    return screens;
  }
  const CGFloat primary = NSMaxY(all[0].frame);
  for (NSScreen* screen in all) {
    const NSRect frame = screen.frame;
    screens.push_back(window_policy::Frame{NSMinX(frame), primary - NSMaxY(frame), NSWidth(frame), NSHeight(frame)});
  }
  return screens;
}

bool WindowEvents::FullScreen() const {
  NSWindow* window = state_->window;
  return window && (window.styleMask & NSWindowStyleMaskFullScreen) != 0;
}

bool WindowEvents::ToggleFullScreen() {
  NSWindow* window = state_->window;
  if (!window) {
    return false;
  }
  const bool next = !FullScreen();
  [window toggleFullScreen:nil];
  return next;
}

void WindowEvents::EnterFullScreen() {
  if (!FullScreen()) {
    ToggleFullScreen();
  }
}

void WindowEvents::Minimize() {
  [state_->window miniaturize:nil];
}

void WindowEvents::ToggleZoom() {
  NSWindow* window = state_->window;
  if (window && !FullScreen()) {
    [window zoom:nil];
  }
}

void WindowEvents::SetTitle(const std::string& title) {
  state_->window.title = base::SysUTF8ToNSString(title) ?: @"";
}

void WindowEvents::PerformClose() {
  NSWindow* window = state_->window;
  NSButton* close = window ? [window standardWindowButton:NSWindowCloseButton] : nil;
  [window performClose:close];
}

void SetAppAppearance(window_policy::Appearance appearance) {
  switch (appearance) {
    case window_policy::Appearance::kAuto:
      NSApp.appearance = nil;
      return;
    case window_policy::Appearance::kLight:
      NSApp.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
      return;
    case window_policy::Appearance::kDark:
      NSApp.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
      return;
  }
}

bool AppIsDark() {
  NSAppearanceName name = [NSApp.effectiveAppearance
      bestMatchFromAppearancesWithNames:@[ NSAppearanceNameAqua, NSAppearanceNameDarkAqua ]];
  return [name isEqualToString:NSAppearanceNameDarkAqua];
}

}
