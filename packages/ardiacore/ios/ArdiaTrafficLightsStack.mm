#import "ArdiaChromeWindowHost.h"
#import "ArdiaChromeWindowInternal.h"
#import "ArdiaRuntime.h"

#import <QuartzCore/QuartzCore.h>
#import <objc/message.h>
#import <objc/runtime.h>

using namespace ardia_runtime;

namespace {

const void *kLightsStackKey = &kLightsStackKey;

CGFloat StackOf(NSWindow *window) {
  if (!window || (window.styleMask & NSWindowStyleMaskFullScreen)) return 0;
  return MAX(0, MIN(1, [objc_getAssociatedObject(window, kLightsStackKey) doubleValue]));
}

CGFloat PitchOf(NSView *frameView) {
  const SEL sel = NSSelectorFromString(@"_windowTitlebarButtonSpacingWidth");
  const CGFloat spacing = [frameView respondsToSelector:sel] ? ((CGFloat (*)(id, SEL))objc_msgSend)(frameView, sel) : 6;
  NSButton *close = [frameView.window standardWindowButton:NSWindowCloseButton];
  return (close ? NSWidth(close.frame) : 14) + spacing;
}

CGFloat Down(NSView *view, CGFloat by) {
  return view.isFlipped ? by : -by;
}

void StackButtonOrigin(Class frameClass, NSString *name, CGFloat index) {
  const SEL sel = NSSelectorFromString(name);
  ReplaceMethod(frameClass, sel, ^id(IMP standard) {
    return ^NSPoint(NSView *frameView) {
      const NSPoint origin = ((NSPoint (*)(id, SEL))standard)(frameView, sel);
      const CGFloat stack = StackOf(frameView.window);
      if (stack <= 0) return origin;
      const NSPoint close = ((NSPoint (*)(id, SEL))objc_msgSend)(frameView, NSSelectorFromString(@"_closeButtonOrigin"));
      const CGFloat reach = PitchOf(frameView) * index;
      return NSMakePoint(close.x + reach * (1 - stack), close.y + Down(frameView, reach * stack));
    };
  });
}

void StackButtonGroup(Class frameClass, NSString *name, NSView * (^space)(NSView *frameView)) {
  const SEL sel = NSSelectorFromString(name);
  ReplaceMethod(frameClass, sel, ^id(IMP standard) {
    return ^NSRect(NSView *frameView) {
      NSRect group = ((NSRect (*)(id, SEL))standard)(frameView, sel);
      const CGFloat drop = 2 * PitchOf(frameView) * StackOf(frameView.window);
      if (drop <= 0) return group;
      group.size.width = MAX(NSHeight(group), NSWidth(group) - drop);
      group.size.height += drop;
      if (!space(frameView).isFlipped) group.origin.y -= drop;
      return group;
    };
  });
}

}

namespace ardia_window {

void InstallTrafficLightsStack(Class frameClass) {
  static NSMutableSet<Class> *installed = [NSMutableSet set];
  if (!frameClass || [installed containsObject:frameClass]) return;
  [installed addObject:frameClass];
  StackButtonOrigin(frameClass, @"_collapseButtonOrigin", 1);
  StackButtonOrigin(frameClass, @"_zoomButtonOrigin", 2);
  StackButtonGroup(frameClass, @"leftButtonGroupInteractionFrame", ^NSView *(NSView *frameView) { return frameView; });
  StackButtonGroup(frameClass, @"leftButtonGroupFrameInTitlebarView", ^NSView *(NSView *frameView) {
    return [frameView.window standardWindowButton:NSWindowCloseButton].superview ?: frameView;
  });
}

CGFloat TrafficLightsStackDrop(NSWindow *window) {
  NSView *frameView = window.contentView.superview;
  return frameView ? 2 * PitchOf(frameView) * StackOf(window) : 0;
}

}

CGFloat ArdiaTrafficLightsStack(NSWindow *window) {
  return StackOf(window);
}

@implementation ArdiaChromeWindowHost (TrafficLightsStack)

+ (void)setTrafficLightsStack:(CGFloat)stack inWindow:(NSWindow *)window {
  if (!window) return;
  const CGFloat clamped = MAX(0, MIN(1, stack));
  if (clamped == [objc_getAssociatedObject(window, kLightsStackKey) doubleValue]) return;
  objc_setAssociatedObject(window, kLightsStackKey, clamped > 0 ? @(clamped) : nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  ardia_window::InstallTrafficLightsStack([window.contentView.superview class]);
  WithoutActions(^{
    ardia_window::RetileTrafficLights(window);
  });
}

@end
