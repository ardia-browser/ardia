#import "ArdiaHoverProbeInternal.h"

namespace ardia_host {

namespace hover_probe {

namespace {

constexpr double kCoverFull = 0.9;
constexpr double kCoverLarge = 0.25;

bool Clear(NSView *view) {
  return view.alphaValue < 0.01 || (view.layer && view.layer.opacity < 0.01);
}

bool IsKind(NSView *view, NSString *className) {
  Class cls = NSClassFromString(className);
  return cls && [view isKindOfClass:cls];
}

NSBundle *ChromiumBundle() {
  Class page = NSClassFromString(@"RenderWidgetHostViewCocoa");
  return page ? [NSBundle bundleForClass:page] : nil;
}

}

PageCover CoverOf(NSView *hit) {
  if (!hit) return PageCover::none;
  NSBundle *chromium = ChromiumBundle();
  for (NSView *v = hit; v; v = v.superview) {
    NSBundle *bundle = [NSBundle bundleForClass:v.class];
    if (bundle == chromium) return PageCover::chromium;
    if (bundle == NSBundle.mainBundle) return PageCover::reactNative;
  }
  return PageCover::other;
}

NSView *SeeThroughView(NSView *hit) {
  for (NSView *v = hit; v; v = v.superview)
    if (Clear(v)) return v;
  return nil;
}

bool SeeThrough(NSView *hit) {
  return SeeThroughView(hit) != nil;
}

CoverView CoverViewOf(NSView *view) {
  if (!view) return CoverView::none;
  NSBundle *chromium = ChromiumBundle();
  if (chromium && [NSBundle bundleForClass:view.class] == chromium) return CoverView::chromium;
  if (IsKind(view, @"ArdiaWebView")) return CoverView::pageHost;
  if (IsKind(view, @"ExpoModulesCore.ExpoClassicView")) return CoverView::expo;
  if (IsKind(view, @"RCTBaseTextInputView")) return CoverView::rnTextInput;
  if (IsKind(view, @"RCTTextView")) return CoverView::rnText;
  if (IsKind(view, @"RCTImageView")) return CoverView::rnImage;
  if (IsKind(view, @"RCTScrollView")) return CoverView::rnScroll;
  NSString *name = NSStringFromClass(view.class);
  if (([view isKindOfClass:NSScrollView.class] || [view isKindOfClass:NSClipView.class]) && [name hasPrefix:@"RCT"]) return CoverView::rnScroll;
  if (IsKind(view, @"RCTView")) return CoverView::rnView;
  if ([name hasPrefix:@"RCT"]) return CoverView::rnOther;
  if ([name containsString:@"Ardia"]) return CoverView::ardia;
  if ([name hasPrefix:@"NS"] || [name hasPrefix:@"_NS"]) return CoverView::appKit;
  return CoverView::other;
}

CoverSize CoverSizeOver(NSView *view, NSView *page) {
  if (!view || !page) return CoverSize::none;
  const NSRect pageRect = [page convertRect:page.bounds toView:nil];
  const NSRect covered = NSIntersectionRect([view convertRect:view.bounds toView:nil], pageRect);
  const double pageArea = NSWidth(pageRect) * NSHeight(pageRect);
  if (pageArea <= 0 || NSIsEmptyRect(covered)) return CoverSize::none;
  const double share = NSWidth(covered) * NSHeight(covered) / pageArea;
  if (share >= kCoverFull) return CoverSize::full;
  if (share >= kCoverLarge) return CoverSize::large;
  return CoverSize::small;
}

NSString *CoverViewName(CoverView view) {
  return @[
    @"none", @"rnView", @"rnText", @"rnImage", @"rnTextInput", @"rnScroll", @"rnOther", @"expo", @"pageHost", @"ardia", @"appKit", @"chromium", @"other"
  ][(NSUInteger)view];
}

NSString *CoverSizeName(CoverSize size) {
  return @[ @"none", @"small", @"large", @"full" ][(NSUInteger)size];
}

}

}
