#import <AppKit/AppKit.h>

static NSArray *rect(NSRect value) {
  return @[@(value.origin.x), @(value.origin.y), @(value.size.width), @(value.size.height)];
}

static void collect(NSView *view, NSMutableArray *frames) {
  if ([NSStringFromClass(view.class) hasSuffix:@".SymbolView"]) {
    for (NSView *child in view.subviews) {
      if (![child isKindOfClass:NSImageView.class]) continue;
      NSImageView *imageView = (NSImageView *)child;
      [frames addObject:@{@"frame": rect(child.frame), @"bounds": rect(view.bounds),
        @"windowRect": rect([child convertRect:child.bounds toView:nil]),
        @"hidden": @(child.hidden), @"image": imageView.image.description ?: @""}];
    }
  }
  for (NSView *child in view.subviews) collect(child, frames);
}

__attribute__((constructor)) static void start(void) {
  const char *path = getenv("ARDIA_SYMBOL_GEOMETRY");
  if (!path) return;
  NSString *file = [NSString stringWithUTF8String:path];
  dispatch_async(dispatch_get_main_queue(), ^{
    [NSTimer scheduledTimerWithTimeInterval:0.05 repeats:YES block:^(NSTimer *timer) {
      NSMutableArray *frames = [NSMutableArray array];
      for (NSWindow *window in NSApp.windows) if (window.contentView) collect(window.contentView, frames);
      NSDictionary *result = @{@"at": @([[NSDate date] timeIntervalSince1970] * 1000), @"frames": frames};
      [[NSJSONSerialization dataWithJSONObject:result options:0 error:nil] writeToFile:file atomically:YES];
    }];
  });
}
