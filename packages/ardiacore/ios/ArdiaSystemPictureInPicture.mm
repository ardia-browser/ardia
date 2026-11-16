#import "ArdiaInternal.h"
#import "ArdiaPictureInPictureInternal.h"
#import "ArdiaTabRegistry.h"

#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>

namespace {

const CFTimeInterval kUserRestoreWindow = 2;
const double kActivationCheck = 0.25;

void ShowSystemPictureInPictureInstantly() {
  static BOOL installed;
  Class proxy = installed ? nil : NSClassFromString(@"PIPAgentProxy");
  if (!proxy) return;
  installed = YES;
  SEL show = NSSelectorFromString(@"agentShowPIP:fromScreenRect:animating:withFence:completion:");
  Method method = class_getInstanceMethod(proxy, show);
  if (!method || strcmp(method_getTypeEncoding(method), "v72@0:8I16{CGRect={CGPoint=dd}{CGSize=dd}}20B52@56@?64") != 0) return;
  auto original = (void (*)(id, SEL, unsigned, CGRect, BOOL, id, id))method_getImplementation(method);
  method_setImplementation(method, imp_implementationWithBlock(^(id agent, unsigned pip, CGRect from, BOOL, id fence, id completion) {
    original(agent, show, pip, from, NO, fence, completion);
  }));
}

void CloseSystemPictureInPictureInstantly() {
  static BOOL installed;
  Class proxy = installed ? nil : NSClassFromString(@"PIPAgentProxy");
  if (!proxy) return;
  installed = YES;
  SEL restoreSel = NSSelectorFromString(@"agentRestorePIP:toScreenRect:completion:");
  SEL closeSel = NSSelectorFromString(@"agentClosePIP:completion:");
  Method restore = class_getInstanceMethod(proxy, restoreSel);
  Method close = class_getInstanceMethod(proxy, closeSel);
  if (!restore || !close || strcmp(method_getTypeEncoding(restore), "v60@0:8I16{CGRect={CGPoint=dd}{CGSize=dd}}20@?52") != 0 ||
      strcmp(method_getTypeEncoding(close), "v28@0:8I16@?20") != 0)
    return;
  auto closeNow = (void (*)(id, SEL, unsigned, id))method_getImplementation(close);
  method_setImplementation(restore, imp_implementationWithBlock(^(id agent, unsigned pip, CGRect, void (^completion)(NSError *)) {
    closeNow(agent, closeSel, pip, ^{
      if (completion) completion(nil);
    });
  }));
}
CFTimeInterval gUserRestoreAt = -1;

void WatchUserRestore() {
  static BOOL installed;
  Class adapter = installed ? nil : NSClassFromString(@"AVPictureInPicturePlatformAdapter");
  if (!adapter) return;
  installed = YES;
  SEL restore = NSSelectorFromString(@"pipActionRestore:");
  Method method = class_getInstanceMethod(adapter, restore);
  if (!method || strcmp(method_getTypeEncoding(method), "v24@0:8@16") != 0) return;
  auto original = (void (*)(id, SEL, id))method_getImplementation(method);
  method_setImplementation(method, imp_implementationWithBlock(^(id platformAdapter, id sender) {
    gUserRestoreAt = CACurrentMediaTime();
    dispatch_async(dispatch_get_main_queue(), ^{
      ardia_pip::ForceActivate(@"Back to Tab (system PiP button)");
    });
    original(platformAdapter, restore, sender);
  }));
}

void AddCornerCap(CGMutablePathRef path, CGPoint corner, CGPoint alongX, CGPoint alongY, CGFloat radius) {
  CGPathMoveToPoint(path, NULL, alongX.x, alongX.y);
  CGPathAddArcToPoint(path, NULL, corner.x, corner.y, alongY.x, alongY.y, radius);
  CGPathAddLineToPoint(path, NULL, corner.x, corner.y);
  CGPathCloseSubpath(path);
}

}

namespace ardia_pip {

BOOL UserAskedToRestore() {
  return gUserRestoreAt >= 0 && CACurrentMediaTime() - gUserRestoreAt < kUserRestoreWindow;
}

void PrepareSystemPictureInPicture() {
  ShowSystemPictureInPictureInstantly();
  WatchUserRestore();
  CloseSystemPictureInPictureInstantly();
}

void ForceActivate(NSString *why) {
  ActivateApp(why);
  if (ardia_host::Background() || NSApp.isActive) return;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  [NSApp activateIgnoringOtherApps:YES];
#pragma clang diagnostic pop
}

void RoundVideoCorners(CALayer *layer, CAShapeLayer *caps, CGFloat radius, NSColor *backdrop, NSRect full, NSRect visible, BOOL hostFlipped,
                       BOOL layerFlipped) {
  const BOOL minYKept = NSMinY(visible) <= NSMinY(full) + 0.5;
  const BOOL maxYKept = NSMaxY(visible) >= NSMaxY(full) - 0.5;
  const BOOL topKept = hostFlipped ? minYKept : maxYKept;
  const BOOL bottomKept = hostFlipped ? maxYKept : minYKept;
  const BOOL layerMinYKept = layerFlipped ? topKept : bottomKept;
  const BOOL layerMaxYKept = layerFlipped ? bottomKept : topKept;
  CACornerMask corners = 0;
  if (layerMinYKept) corners |= kCALayerMinXMinYCorner | kCALayerMaxXMinYCorner;
  if (layerMaxYKept) corners |= kCALayerMinXMaxYCorner | kCALayerMaxXMaxYCorner;
  const CGFloat rounded = corners ? MIN(radius, MIN(NSWidth(visible), NSHeight(visible)) / 2) : 0;
  if (layer.cornerRadius != rounded) layer.cornerRadius = rounded;
  if (layer.maskedCorners != corners && corners) layer.maskedCorners = corners;
  const CGRect bounds = layer.bounds;
  if (!CGRectEqualToRect(caps.frame, bounds)) caps.frame = bounds;
  const BOOL capped = rounded > 0 && backdrop;
  caps.hidden = !capped;
  if (!capped) return;
  caps.fillColor = backdrop.CGColor;
  const CGFloat x0 = CGRectGetMinX(bounds), x1 = CGRectGetMaxX(bounds), y0 = CGRectGetMinY(bounds), y1 = CGRectGetMaxY(bounds);
  CGMutablePathRef path = CGPathCreateMutable();
  if (layerMinYKept) {
    AddCornerCap(path, CGPointMake(x0, y0), CGPointMake(x0 + rounded, y0), CGPointMake(x0, y0 + rounded), rounded);
    AddCornerCap(path, CGPointMake(x1, y0), CGPointMake(x1 - rounded, y0), CGPointMake(x1, y0 + rounded), rounded);
  }
  if (layerMaxYKept) {
    AddCornerCap(path, CGPointMake(x0, y1), CGPointMake(x0 + rounded, y1), CGPointMake(x0, y1 - rounded), rounded);
    AddCornerCap(path, CGPointMake(x1, y1), CGPointMake(x1 - rounded, y1), CGPointMake(x1, y1 - rounded), rounded);
  }
  caps.path = path;
  CGPathRelease(path);
}

void BackToTab(ArdiaCoreTab *tab, NSString *why) {
  ArdiaWebView *view = tab ? [ArdiaTabRegistry viewForTab:tab] : nil;
  if (!view) return;
  ForceActivate(why);
  [view emit:@"activateRequest" payload:@{@"reason" : @"pictureInPicture"}];
  if (ardia_host::Background()) return;
  __weak ArdiaWebView *weakView = view;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kActivationCheck * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (NSApp.isActive) return ardia_host::LogActivation([why stringByAppendingString:@": active"]);
    NSWindow *window = weakView.window;
    [window orderFrontRegardless];
    ardia_host::LogActivation([why stringByAppendingFormat:@": not activated, window %@ ordered front", window ? @"was" : @"not"]);
  });
}

}
