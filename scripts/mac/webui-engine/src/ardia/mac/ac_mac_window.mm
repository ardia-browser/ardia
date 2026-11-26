#include "ardia/mac/ac_mac_window.h"

#include <algorithm>

#include "ardia/mac/ac_mac_window_policy.h"

#import <AppKit/AppKit.h>
#import <objc/runtime.h>

#include "third_party/skia/include/core/SkColor.h"
#include "ui/compositor/compositor.h"
#include "ui/compositor/layer.h"
#include "ui/views/view.h"
#include "ui/views/widget/widget.h"

@interface ArdiaMacTitlebarMetrics : NSObject
@property(nonatomic) CGFloat minXInset;
@property(nonatomic) CGFloat height;
@end

@implementation ArdiaMacTitlebarMetrics
@synthesize minXInset = _minXInset;
@synthesize height = _height;
@end

namespace ardia_mac {

namespace {

const void* const kMetricsKey = &kMetricsKey;

ArdiaMacTitlebarMetrics* MetricsOf(NSView* frame) {
  return objc_getAssociatedObject(frame.window, kMetricsKey);
}

void Override(Class frame_class, SEL selector, CGFloat (^pick)(ArdiaMacTitlebarMetrics*)) {
  Method method = class_getInstanceMethod(frame_class, selector);
  if (!method) {
    return;
  }
  using Getter = CGFloat (*)(id, SEL);
  const Getter standard = reinterpret_cast<Getter>(method_getImplementation(method));
  const IMP replacement = imp_implementationWithBlock(^CGFloat(NSView* frame) {
    ArdiaMacTitlebarMetrics* metrics = MetricsOf(frame);
    if (!metrics || (frame.window.styleMask & NSWindowStyleMaskFullScreen)) {
      return standard(frame, selector);
    }
    return pick(metrics);
  });
  if (!class_addMethod(frame_class, selector, replacement, method_getTypeEncoding(method))) {
    method_setImplementation(method, replacement);
  }
}

const void* const kObservedKey = &kObservedKey;

void LayOutLights(NSWindow* ns_window) {
  ArdiaMacTitlebarMetrics* metrics = objc_getAssociatedObject(ns_window, kMetricsKey);
  if (!metrics || (ns_window.styleMask & NSWindowStyleMaskFullScreen)) {
    return;
  }
  NSButton* close = [ns_window standardWindowButton:NSWindowCloseButton];
  NSButton* mini = [ns_window standardWindowButton:NSWindowMiniaturizeButton];
  NSButton* zoom = [ns_window standardWindowButton:NSWindowZoomButton];
  NSView* container = close.superview.superview;
  NSView* frame = container.superview;
  if (!close || !mini || !zoom || !container || !frame) {
    return;
  }
  const window::TitlebarLayout layout = window::TitlebarLayoutFor(
      window::TitlebarMetrics{metrics.minXInset, metrics.height},
      window::Size{NSWidth(close.frame), NSHeight(close.frame)},
      NSMinX(mini.frame) - NSMinX(close.frame), NSHeight(frame.bounds));
  NSRect bar = container.frame;
  bar.size.height = layout.container_height;
  bar.origin.y = frame.isFlipped ? 0 : layout.container_y;
  container.frame = bar;
  NSButton* const buttons[] = {close, mini, zoom};
  for (int index = 0; index < 3; ++index) {
    [buttons[index] setFrameOrigin:NSMakePoint(layout.button_x[index], layout.button_y)];
  }
}

void FollowWindowLayout(NSWindow* ns_window) {
  if (objc_getAssociatedObject(ns_window, kObservedKey)) {
    return;
  }
  NSMutableArray* observers = [NSMutableArray array];
  __weak NSWindow* weak_window = ns_window;
  for (NSNotificationName name in @[
         NSWindowDidResizeNotification, NSWindowDidExitFullScreenNotification,
         NSWindowDidBecomeKeyNotification, NSWindowDidResignKeyNotification
       ]) {
    [observers addObject:[NSNotificationCenter.defaultCenter
                             addObserverForName:name
                                         object:ns_window
                                          queue:NSOperationQueue.mainQueue
                                     usingBlock:^(NSNotification*) {
                                       if (NSWindow* strong = weak_window) {
                                         LayOutLights(strong);
                                       }
                                     }]];
  }
  __weak NSMutableArray* weak_observers = observers;
  [observers addObject:[NSNotificationCenter.defaultCenter
                           addObserverForName:NSWindowWillCloseNotification
                                       object:ns_window
                                        queue:NSOperationQueue.mainQueue
                                   usingBlock:^(NSNotification*) {
                                     NSMutableArray* tokens = weak_observers;
                                     for (id token in tokens) {
                                       [NSNotificationCenter.defaultCenter removeObserver:token];
                                     }
                                     if (NSWindow* strong = weak_window) {
                                       objc_setAssociatedObject(strong, kObservedKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
                                     }
                                   }]];
  objc_setAssociatedObject(ns_window, kObservedKey, observers, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

void InstallMetricsOverrides(Class frame_class) {
  static NSMutableSet<Class>* installed = [NSMutableSet set];
  if (!frame_class || [installed containsObject:frame_class]) {
    return;
  }
  [installed addObject:frame_class];
  Override(frame_class, NSSelectorFromString(@"_titlebarHeight"),
           ^CGFloat(ArdiaMacTitlebarMetrics* metrics) {
             return metrics.height;
           });
  Override(frame_class, NSSelectorFromString(@"_minXTitlebarWidgetInset"),
           ^CGFloat(ArdiaMacTitlebarMetrics* metrics) {
             return metrics.minXInset;
           });
}

}

void ApplyShellWindowStyle(views::Widget* widget) {
  NSWindow* ns_window = widget ? widget->GetNativeWindow().GetNativeNSWindow() : nil;
  if (!ns_window) {
    return;
  }
  const window::Translucency style = window::TranslucencyFor(true);
  ns_window.opaque = style.opaque;
  if (style.clear_background) {
    ns_window.backgroundColor = NSColor.clearColor;
  }
  if (style.full_size_content) {
    ns_window.styleMask |= NSWindowStyleMaskFullSizeContentView;
  }
  ns_window.titlebarAppearsTransparent = style.transparent_titlebar;
  if (style.hide_title) {
    ns_window.titleVisibility = NSWindowTitleHidden;
  }
  if (ui::Compositor* compositor = widget->GetCompositor()) {
    compositor->SetBackgroundColor(SK_ColorTRANSPARENT);
  }
  if (ui::Layer* layer = widget->GetLayer()) {
    layer->SetFillsBoundsOpaquely(false);
  }
  if (views::View* root = widget->GetRootView()) {
    root->SetBackground(nullptr);
  }
  NSView* content = ns_window.contentView;
  content.wantsLayer = YES;
  content.layer.backgroundColor = NSColor.clearColor.CGColor;
  content.layer.opaque = NO;
  ns_window.hasShadow = YES;
  [ns_window invalidateShadow];
  KeepMinimumSize(widget);
}

void KeepMinimumSize(views::Widget* widget) {
  NSWindow* ns_window = widget ? widget->GetNativeWindow().GetNativeNSWindow() : nil;
  if (!ns_window) {
    return;
  }
  const NSSize content = ns_window.contentMinSize;
  ns_window.contentMinSize = NSMakeSize(std::max<CGFloat>(content.width, window_policy::kMinWidth),
                                        std::max<CGFloat>(content.height, window_policy::kMinHeight));
  const NSSize frame = ns_window.minSize;
  ns_window.minSize = NSMakeSize(std::max<CGFloat>(frame.width, window_policy::kMinWidth),
                                 std::max<CGFloat>(frame.height, window_policy::kMinHeight));
}

void SetTrafficLights(views::Widget* widget, const window::Lights& lights) {
  NSWindow* ns_window = widget ? widget->GetNativeWindow().GetNativeNSWindow() : nil;
  NSView* frame = ns_window.contentView.superview;
  if (!ns_window || !frame) {
    return;
  }
  InstallMetricsOverrides(frame.class);
  NSButton* close = [ns_window standardWindowButton:NSWindowCloseButton];
  const NSSize size = close ? close.frame.size : NSMakeSize(window::kButtonSide, window::kButtonSide);
  const window::TitlebarMetrics metrics =
      window::TitlebarFor(lights, window::Size{size.width, size.height});
  ArdiaMacTitlebarMetrics* stored = [[ArdiaMacTitlebarMetrics alloc] init];
  stored.minXInset = metrics.min_x_inset;
  stored.height = metrics.height;
  objc_setAssociatedObject(ns_window, kMetricsKey, stored, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  for (NSWindowButton kind : {NSWindowCloseButton, NSWindowMiniaturizeButton, NSWindowZoomButton}) {
    [ns_window standardWindowButton:kind].hidden = lights.hidden;
  }
  frame.needsLayout = YES;
  [frame layoutSubtreeIfNeeded];
  LayOutLights(ns_window);
  FollowWindowLayout(ns_window);
}

void ShowWithoutActivating(views::Widget* widget, views::Widget* behind) {
  if (!widget) {
    return;
  }
  widget->ShowInactive();
  NSWindow* ns_window = widget->GetNativeWindow().GetNativeNSWindow();
  NSWindow* behind_window = behind ? behind->GetNativeWindow().GetNativeNSWindow() : nil;
  if (ns_window && behind_window) {
    [ns_window orderWindow:NSWindowBelow relativeTo:behind_window.windowNumber];
  }
}

}
