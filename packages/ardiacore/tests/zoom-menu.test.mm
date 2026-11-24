#import "../ios/ArdiaChromeWindowInternal.h"

#import <objc/message.h>
#import <objc/runtime.h>

#include <cstdio>

namespace ardia_window {

const void *kInsetLightsKey = &kInsetLightsKey;
static BOOL gFullScreen = NO;

BOOL IsWindowFullScreen(NSWindow *) {
  return gFullScreen;
}

}

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

int main() {
  @autoreleasepool {
    NSApplication *app = NSApplication.sharedApplication;
    [app setActivationPolicy:NSApplicationActivationPolicyProhibited];

    NSWindow *window = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(100, 100, 500, 400)
                  styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable |
                            NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView
                    backing:NSBackingStoreBuffered
                      defer:NO];
    window.level = kCGDesktopWindowLevel;
    window.alphaValue = 0;
    [window orderBack:nil];
    objc_setAssociatedObject(window, ardia_window::kInsetLightsKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    ardia_window::InstallZoomMenuWatch();

    __block int changes = 0;
    id observer = [NSNotificationCenter.defaultCenter addObserverForName:ArdiaZoomMenuDidChange
                                                                  object:window
                                                                   queue:nil
                                                              usingBlock:^(NSNotification *) { changes++; }];

    CHECK(!ArdiaZoomMenuOpen(window));
    CHECK(changes == 0);

    NSButton *zoom = [window standardWindowButton:NSWindowZoomButton];
    CHECK(zoom != nil);

    const SEL phSel = NSSelectorFromString(@"_sidecarButtonPlaceholder");
    NSView *remote = [zoom respondsToSelector:phSel] ? ((id (*)(id, SEL))objc_msgSend)(zoom, phSel) : nil;
    if (remote) {
      const SEL openSel = NSSelectorFromString(@"menuWillOpen");
      const SEL cancelSel = NSSelectorFromString(@"menuDidCancel");
      const SEL closeSel = NSSelectorFromString(@"menuDidCloseSelectingAnItem:");

      ((void (*)(id, SEL))objc_msgSend)(remote, openSel);
      CHECK(ArdiaZoomMenuOpen(window));
      CHECK(changes == 1);

      ((void (*)(id, SEL))objc_msgSend)(remote, openSel);
      CHECK(changes == 1);

      ((void (*)(id, SEL))objc_msgSend)(remote, cancelSel);
      CHECK(!ArdiaZoomMenuOpen(window));
      CHECK(changes == 2);

      ((void (*)(id, SEL))objc_msgSend)(remote, openSel);
      CHECK(ArdiaZoomMenuOpen(window));
      CHECK(changes == 3);

      ((void (*)(id, SEL, BOOL))objc_msgSend)(remote, closeSel, YES);
      CHECK(!ArdiaZoomMenuOpen(window));
      CHECK(changes == 4);

      ((void (*)(id, SEL))objc_msgSend)(remote, openSel);
      CHECK(ArdiaZoomMenuOpen(window));
      [NSNotificationCenter.defaultCenter postNotificationName:@"NSThemeZoomWidgetMenuDidDismissNotification" object:window];
      CHECK(!ArdiaZoomMenuOpen(window));
      CHECK(changes == 6);

      ((void (*)(id, SEL))objc_msgSend)(remote, openSel);
      CHECK(ArdiaZoomMenuOpen(window));
      [NSNotificationCenter.defaultCenter postNotificationName:NSApplicationDidResignActiveNotification object:app];
      CHECK(!ArdiaZoomMenuOpen(window));
      CHECK(changes == 8);

      ((void (*)(id, SEL))objc_msgSend)(remote, openSel);
      CHECK(ArdiaZoomMenuOpen(window));
      [NSNotificationCenter.defaultCenter postNotificationName:NSWindowWillEnterFullScreenNotification object:window];
      CHECK(!ArdiaZoomMenuOpen(window));
      CHECK(changes == 10);

      ((void (*)(id, SEL))objc_msgSend)(remote, openSel);
      CHECK(ArdiaZoomMenuOpen(window));
      [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidResignMainNotification object:window];
      CHECK(!ArdiaZoomMenuOpen(window));
      CHECK(changes == 12);

      ((void (*)(id, SEL))objc_msgSend)(remote, openSel);
      CHECK(ArdiaZoomMenuOpen(window));
      [remote viewWillMoveToWindow:nil];
      CHECK(!ArdiaZoomMenuOpen(window));
      CHECK(changes == 14);
    }

    const int beforeLocal = changes;
    if (zoom.cell && [zoom.cell respondsToSelector:@selector(menuWillOpen:)]) {
      NSMenu *menu = [[NSMenu alloc] init];
      ((void (*)(id, SEL, NSMenu *))objc_msgSend)(zoom.cell, @selector(menuWillOpen:), menu);
      CHECK(ArdiaZoomMenuOpen(window));
      CHECK(changes == beforeLocal + 1);
      ((void (*)(id, SEL, NSMenu *))objc_msgSend)(zoom.cell, @selector(menuDidClose:), menu);
      CHECK(!ArdiaZoomMenuOpen(window));
      CHECK(changes == beforeLocal + 2);
    }

    ardia_window::SetDevZoomMenuOpen(window, YES);
    CHECK(ArdiaZoomMenuOpen(window));
    ardia_window::gFullScreen = YES;
    CHECK(!ArdiaZoomMenuOpen(window));
    ardia_window::gFullScreen = NO;
    CHECK(ArdiaZoomMenuOpen(window));
    ardia_window::SetDevZoomMenuOpen(window, NO);
    CHECK(!ArdiaZoomMenuOpen(window));

    [NSNotificationCenter.defaultCenter removeObserver:observer];
    [window orderOut:nil];
  }
  if (failures) return 1;
  std::printf("zoom-menu: ok\n");
  return 0;
}
