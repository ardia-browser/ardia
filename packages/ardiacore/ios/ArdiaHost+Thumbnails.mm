#import "ArdiaHostInternal.h"
#import "ArdiaLaunchConfig.h"

#import <ScreenCaptureKit/ScreenCaptureKit.h>

static NSString *JPEGOfImage(CGImageRef image, CGSize size);

@implementation ArdiaHost (Thumbnails)

+ (void)displayMediaThumbnails:(NSArray<NSString *> *)sourceIds
                     maxWidth:(double)maxWidth
                    completion:(void (^)(NSDictionary<NSString *, NSString *> *))completion {
  void (^answer)(NSDictionary<NSString *, NSString *> *) = ^(NSDictionary<NSString *, NSString *> *found) {
    completion(found ?: @{});
  };
  if (ArdiaLaunchConfig.shared.background) return answer(@{});
  if (@available(macOS 14.0, *)) {
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES
                                                   onScreenWindowsOnly:YES
                                                  completionHandler:^(SCShareableContent *content, NSError *) {
      [self captureThumbnails:sourceIds maxWidth:maxWidth content:content completion:answer];
    }];
    return;
  }
  answer(@{});
}

+ (void)captureThumbnails:(NSArray<NSString *> *)sourceIds
                maxWidth:(double)maxWidth
                 content:(SCShareableContent *)content
               completion:(void (^)(NSDictionary<NSString *, NSString *> *))completion {
  if (@available(macOS 14.0, *)) {
    dispatch_group_t group = dispatch_group_create();
    NSMutableDictionary<NSString *, NSString *> *found = [NSMutableDictionary dictionary];
    for (NSString *sourceId in sourceIds) {
      SCContentFilter *filter = [self filterForSource:sourceId content:content];
      if (!filter) continue;
      CGSize size = CGSizeMake(maxWidth, maxWidth);
      if (CGRectGetWidth(filter.contentRect) > 0)
        size.height = maxWidth * CGRectGetHeight(filter.contentRect) / CGRectGetWidth(filter.contentRect);
      dispatch_group_enter(group);
      [self captureFilter:filter size:size
               completion:^(NSString *jpeg) {
                 if (jpeg.length) @synchronized(found) { found[sourceId] = jpeg; }
                 dispatch_group_leave(group);
               }];
    }
    dispatch_group_notify(group, dispatch_get_main_queue(), ^{ completion(found); });
  }
}

+ (SCContentFilter *)filterForSource:(NSString *)sourceId content:(SCShareableContent *)content {
  if (@available(macOS 14.0, *)) {
    NSArray *parts = [sourceId componentsSeparatedByString:@":"];
    if (parts.count < 2) return nil;
    const uint32_t number = [parts[1] unsignedIntValue];
    if ([parts[0] isEqualToString:@"window"]) {
      for (SCWindow *window in content.windows)
        if (window.windowID == number) return [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
      return nil;
    }
    if ([parts[0] isEqualToString:@"screen"]) {
      for (SCDisplay *display in content.displays)
        if (display.displayID == number) return [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
    }
  }
  return nil;
}

+ (void)captureFilter:(SCContentFilter *)filter
                 size:(CGSize)size
           completion:(void (^)(NSString *))completion {
  if (@available(macOS 14.0, *)) {
    SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
    config.width = (size_t)size.width;
    config.height = (size_t)round(size.height);
    config.scalesToFit = YES;
    config.showsCursor = NO;
    [SCScreenshotManager captureImageWithFilter:filter
                                   configuration:config
                              completionHandler:^(CGImageRef image, NSError *) {
      completion(JPEGOfImage(image, size));
    }];
    return;
  }
  completion(nil);
}

@end

static NSString *JPEGOfImage(CGImageRef image, CGSize size) {
  if (!image) return nil;
  NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:image];
  bitmap.size = size;
  NSData *jpeg = [bitmap representationUsingType:NSBitmapImageFileTypeJPEG properties:@{NSImageCompressionFactor : @(0.6)}];
  return [jpeg base64EncodedStringWithOptions:0];
}
