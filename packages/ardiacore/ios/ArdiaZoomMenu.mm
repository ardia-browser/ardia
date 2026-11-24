#import "ArdiaChromeWindowInternal.h"
#import "ArdiaRuntime.h"

#import <objc/message.h>
#import <objc/runtime.h>

using namespace ardia_window;
using namespace ardia_runtime;

namespace {

const void *kZoomMenuStateKey = &kZoomMenuStateKey;

constexpr uint32_t kZoomMenuOpening = 1 << 0;
constexpr uint32_t kZoomMenuRemote = 1 << 1;
constexpr uint32_t kZoomMenuLocal = 1 << 2;
constexpr uint32_t kZoomMenuDev = 1 << 3;
constexpr uint32_t kZoomMenuTransient = kZoomMenuOpening | kZoomMenuRemote | kZoomMenuLocal;
constexpr uint32_t kZoomMenuAll = kZoomMenuTransient | kZoomMenuDev;

NSMapTable<id, NSWindow *> *LatchedWindows() {
  static NSMapTable<id, NSWindow *> *table = [NSMapTable weakToWeakObjectsMapTable];
  return table;
}

NSWindow *ToolbarWindow(NSWindow *window) {
  if (!window) return nil;
  const SEL sel = NSSelectorFromString(@"_windowForToolbar");
  if ([window respondsToSelector:sel])
    if (NSWindow *owner = ((NSWindow * (*)(id, SEL))objc_msgSend)(window, sel); [owner isKindOfClass:NSWindow.class]) return owner;
  return window;
}

NSWindow *ZoomRemoteWindow(NSView *view) {
  if (!view) return nil;
  NSWindow *window = view.window;
  if (!window) {
    const SEL sel = NSSelectorFromString(@"sharedWindow");
    if ([view respondsToSelector:sel])
      if (id shared = ((id (*)(id, SEL))objc_msgSend)(view, sel); [shared isKindOfClass:NSWindow.class]) window = shared;
  }
  return ToolbarWindow(window) ?: [LatchedWindows() objectForKey:view];
}

NSWindow *ZoomCellWindow(NSCell *cell) {
  if (!cell) return nil;
  NSWindow *window = cell.controlView.window;
  if (!window) {
    const SEL sel = NSSelectorFromString(@"trackedWindow");
    if ([cell respondsToSelector:sel])
      if (id tracked = ((id (*)(id, SEL))objc_msgSend)(cell, sel); [tracked isKindOfClass:NSWindow.class]) window = tracked;
  }
  return ToolbarWindow(window) ?: [LatchedWindows() objectForKey:cell];
}

void RecordLatchedWindow(id source, NSWindow *window, BOOL on) {
  if (!source) return;
  if (!NSThread.isMainThread) {
    __weak id weakSource = source;
    __weak NSWindow *weakWindow = window;
    dispatch_async(dispatch_get_main_queue(), ^{ RecordLatchedWindow(weakSource, weakWindow, on); });
    return;
  }
  if (on && window) [LatchedWindows() setObject:window forKey:source];
  else if (!on) [LatchedWindows() removeObjectForKey:source];
}

void SetZoomMenuBits(NSWindow *window, uint32_t mask, BOOL on) {
  if (!window) return;
  if (!NSThread.isMainThread) {
    __weak NSWindow *weakWindow = window;
    dispatch_async(dispatch_get_main_queue(), ^{ SetZoomMenuBits(weakWindow, mask, on); });
    return;
  }
  if (!objc_getAssociatedObject(window, kInsetLightsKey)) return;
  const uint32_t before = [objc_getAssociatedObject(window, kZoomMenuStateKey) unsignedIntValue];
  const uint32_t after = on ? (before | mask) : (before & ~mask);
  if (before == after) return;
  objc_setAssociatedObject(window, kZoomMenuStateKey, after ? @(after) : nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  if ((before != 0) != (after != 0))
    [NSNotificationCenter.defaultCenter postNotificationName:ArdiaZoomMenuDidChange object:window];
}

void ClearRemoteSource(NSView *view) {
  if (!view) return;
  if (!NSThread.isMainThread) {
    __weak NSView *weakView = view;
    dispatch_async(dispatch_get_main_queue(), ^{ ClearRemoteSource(weakView); });
    return;
  }
  NSWindow *window = ZoomRemoteWindow(view);
  RecordLatchedWindow(view, nil, NO);
  SetZoomMenuBits(window, kZoomMenuRemote, NO);
}

void ClearRemoteWindow(NSView *view, NSWindow *captured) {
  if (!NSThread.isMainThread) return ClearRemoteSource(view);
  NSWindow *window = captured ?: ZoomRemoteWindow(view);
  RecordLatchedWindow(view, nil, NO);
  SetZoomMenuBits(window, kZoomMenuRemote, NO);
}

NSWindow *CaptureRemoteWindow(NSView *view) {
  return NSThread.isMainThread ? ZoomRemoteWindow(view) : nil;
}

void OpenRemoteSource(NSView *view) {
  if (!view) return;
  if (!NSThread.isMainThread) {
    __weak NSView *weakView = view;
    dispatch_async(dispatch_get_main_queue(), ^{ OpenRemoteSource(weakView); });
    return;
  }
  NSWindow *window = ZoomRemoteWindow(view);
  RecordLatchedWindow(view, window, YES);
  SetZoomMenuBits(window, kZoomMenuRemote, YES);
}

}

namespace ardia_window {

void InstallZoomMenuWatch() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    if (Class remote = NSClassFromString(@"NSThemeWidgetZoomMenuRemoteView")) {
      const SEL showSel = NSSelectorFromString(@"_showMenu:withCallout:timestamp:");
      ReplaceMethod(remote, showSel, ^id(IMP original) {
        return ^(NSView *self, id items, BOOL callout, double timestamp) {
          NSWindow *window = CaptureRemoteWindow(self);
          RecordLatchedWindow(self, window, YES);
          SetZoomMenuBits(window, kZoomMenuOpening, YES);
          @try {
            ((void (*)(id, SEL, id, BOOL, double))original)(self, showSel, items, callout, timestamp);
          } @finally {
            SetZoomMenuBits(window, kZoomMenuOpening, NO);
          }
        };
      });
      const SEL openSel = NSSelectorFromString(@"menuWillOpen");
      ReplaceMethod(remote, openSel, ^id(IMP original) {
        return ^(NSView *self) {
          ((void (*)(id, SEL))original)(self, openSel);
          OpenRemoteSource(self);
        };
      });
      for (NSString *name in @[ @"_stopMenuTracking", @"menuDidCancel", @"serviceDidInvalidate", @"invalidate" ]) {
        const SEL sel = NSSelectorFromString(name);
        ReplaceMethod(remote, sel, ^id(IMP original) {
          return ^(NSView *self) {
            NSWindow *window = CaptureRemoteWindow(self);
            ((void (*)(id, SEL))original)(self, sel);
            ClearRemoteWindow(self, window);
          };
        });
      }
      const SEL closeSel = NSSelectorFromString(@"menuDidCloseSelectingAnItem:");
      ReplaceMethod(remote, closeSel, ^id(IMP original) {
        return ^(NSView *self, BOOL selected) {
          NSWindow *window = CaptureRemoteWindow(self);
          ((void (*)(id, SEL, BOOL))original)(self, closeSel, selected);
          ClearRemoteWindow(self, window);
        };
      });
      const SEL cancelSel = NSSelectorFromString(@"cancelShowMenuAfterProcessingEventsBeforeTimestamp:");
      ReplaceMethod(remote, cancelSel, ^id(IMP original) {
        return ^(NSView *self, double timestamp) {
          NSWindow *window = CaptureRemoteWindow(self);
          ((void (*)(id, SEL, double))original)(self, cancelSel, timestamp);
          ClearRemoteWindow(self, window);
        };
      });
      const SEL moveSel = @selector(viewWillMoveToWindow:);
      ReplaceMethod(remote, moveSel, ^id(IMP original) {
        return ^(NSView *self, NSWindow *newWindow) {
          if (!newWindow) ClearRemoteSource(self);
          ((void (*)(id, SEL, NSWindow *))original)(self, moveSel, newWindow);
        };
      });
    }
    if (Class cell = NSClassFromString(@"_NSThemeZoomWidgetCell")) {
      const SEL openSel = @selector(menuWillOpen:);
      ReplaceMethod(cell, openSel, ^id(IMP original) {
        return ^(NSCell *self, NSMenu *menu) {
          ((void (*)(id, SEL, NSMenu *))original)(self, openSel, menu);
          NSWindow *window = ZoomCellWindow(self);
          RecordLatchedWindow(self, window, YES);
          SetZoomMenuBits(window, kZoomMenuLocal, YES);
        };
      });
      const SEL closeSel = @selector(menuDidClose:);
      ReplaceMethod(cell, closeSel, ^id(IMP original) {
        return ^(NSCell *self, NSMenu *menu) {
          NSWindow *window = ZoomCellWindow(self);
          ((void (*)(id, SEL, NSMenu *))original)(self, closeSel, menu);
          RecordLatchedWindow(self, nil, NO);
          SetZoomMenuBits(window, kZoomMenuLocal, NO);
        };
      });
    }
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserverForName:@"NSThemeZoomWidgetMenuDidDismissNotification"
                        object:nil
                         queue:NSOperationQueue.mainQueue
                    usingBlock:^(NSNotification *note) {
                      if ([note.object isKindOfClass:NSWindow.class]) SetZoomMenuBits(ToolbarWindow(note.object), kZoomMenuRemote, NO);
                    }];
    for (NSNotificationName name in @[ NSWindowWillCloseNotification, NSWindowWillMiniaturizeNotification, NSWindowWillEnterFullScreenNotification ])
      [center addObserverForName:name
                          object:nil
                           queue:NSOperationQueue.mainQueue
                      usingBlock:^(NSNotification *note) {
                        if ([note.object isKindOfClass:NSWindow.class]) SetZoomMenuBits(note.object, kZoomMenuAll, NO);
                      }];
    [center addObserverForName:NSWindowDidResignMainNotification
                        object:nil
                         queue:NSOperationQueue.mainQueue
                    usingBlock:^(NSNotification *note) {
                      if ([note.object isKindOfClass:NSWindow.class]) SetZoomMenuBits(note.object, kZoomMenuTransient, NO);
                    }];
    [center addObserverForName:NSApplicationDidResignActiveNotification
                        object:nil
                         queue:NSOperationQueue.mainQueue
                    usingBlock:^(NSNotification *) {
                      for (NSWindow *window in NSApp.windows) SetZoomMenuBits(window, kZoomMenuTransient, NO);
                    }];
  });
}

void SetDevZoomMenuOpen(NSWindow *window, BOOL open) {
  SetZoomMenuBits(window, kZoomMenuDev, open);
}

}

NSNotificationName const ArdiaZoomMenuDidChange = @"ArdiaZoomMenuDidChange";

BOOL ArdiaZoomMenuOpen(NSWindow *window) {
  if (!window || !window.isVisible || window.isMiniaturized || IsWindowFullScreen(window)) return NO;
  return [objc_getAssociatedObject(window, kZoomMenuStateKey) unsignedIntValue] != 0;
}
