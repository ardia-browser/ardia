#import "ArdiaChromeWindowHost.h"

#import <objc/runtime.h>

@interface NSTitlebarAccessoryViewController ()
- (void)setRevealAmount:(double)revealAmount;
@end

@interface ArdiaMenuBarWatch : NSTitlebarAccessoryViewController
@property(nonatomic, weak) NSWindow *watchedWindow;
@property(nonatomic, copy) void (^menuBarChanged)(BOOL shown);
@property(nonatomic) double menuBarReveal;
@property(nonatomic) BOOL menuBarReported;
@property(nonatomic) BOOL menuBarShown;
@end

@implementation ArdiaMenuBarWatch

- (void)loadView {
  self.view = [[NSView alloc] initWithFrame:NSZeroRect];
}

- (void)setRevealAmount:(double)revealAmount {
  [super setRevealAmount:revealAmount];
  self.menuBarReveal = revealAmount;
  [self reportMenuBar];
}

- (BOOL)menuBarStaysShown {
  NSScreen *screen = self.watchedWindow.screen;
  if (!screen) return NO;
  const CGFloat coveredTop = NSMaxY(screen.frame) - NSMaxY(screen.visibleFrame);
  return coveredTop > screen.safeAreaInsets.top + 0.5;
}

- (void)reportMenuBar {
  const BOOL shown = self.menuBarReveal > 0 || self.menuBarStaysShown;
  if (self.menuBarReported && shown == self.menuBarShown) return;
  self.menuBarReported = YES;
  self.menuBarShown = shown;
  if (self.menuBarChanged) self.menuBarChanged(shown);
}

@end

static const void *kMenuBarWatchKey = &kMenuBarWatchKey;

@implementation ArdiaChromeWindowHost (FullScreenMenuBar)

+ (void)watchMenuBarOfWindow:(NSWindow *)window changed:(void (^)(BOOL shown))changed {
  ArdiaMenuBarWatch *watch = objc_getAssociatedObject(window, kMenuBarWatchKey);
  const BOOL fresh = watch == nil;
  if (fresh) {
    watch = [[ArdiaMenuBarWatch alloc] init];
    watch.layoutAttribute = NSLayoutAttributeBottom;
    watch.watchedWindow = window;
    objc_setAssociatedObject(window, kMenuBarWatchKey, watch, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  watch.menuBarChanged = changed;
  if (fresh && (window.styleMask & NSWindowStyleMaskTitled)) [window addTitlebarAccessoryViewController:watch];
  [watch reportMenuBar];
}

+ (void)stopWatchingMenuBarOfWindow:(NSWindow *)window {
  ArdiaMenuBarWatch *watch = objc_getAssociatedObject(window, kMenuBarWatchKey);
  if (!watch) return;
  objc_setAssociatedObject(window, kMenuBarWatchKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  watch.menuBarChanged = nil;
  const NSUInteger index = [window.titlebarAccessoryViewControllers indexOfObjectIdenticalTo:watch];
  if (index != NSNotFound) [window removeTitlebarAccessoryViewControllerAtIndex:index];
}

@end
