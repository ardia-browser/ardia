#import "ArdiaHostInternal.h"
#import "ArdiaLaunchConfig.h"

#import <ScreenCaptureKit/ScreenCaptureKit.h>

static NSString *JPEGOfImage(CGImageRef image, CGSize size);
static BOOL ParseSourceNumber(NSString *text, uint32_t *number);

@implementation ArdiaHost (Thumbnails)

+ (void)displayMediaThumbnails:(NSArray<NSString *> *)sourceIds
                     maxWidth:(double)maxWidth
                    completion:(void (^)(NSDictionary<NSString *, NSString *> *))completion {
  if (ArdiaLaunchConfig.shared.background || !sourceIds.count || maxWidth < 1) return completion(@{});
  [SCShareableContent getShareableContentExcludingDesktopWindows:YES
                                                 onScreenWindowsOnly:YES
                                                completionHandler:^(SCShareableContent *content, NSError *) {
    [self captureThumbnails:sourceIds maxWidth:maxWidth content:content completion:completion];
  }];
}

+ (void)captureThumbnails:(NSArray<NSString *> *)sourceIds
                maxWidth:(double)maxWidth
                 content:(SCShareableContent *)content
               completion:(void (^)(NSDictionary<NSString *, NSString *> *))completion {
  dispatch_group_t group = dispatch_group_create();
  NSMutableDictionary<NSString *, NSString *> *found = [NSMutableDictionary dictionary];
  for (NSString *sourceId in sourceIds) {
    SCContentFilter *filter = content ? [self filterForSource:sourceId content:content] : nil;
    if (!filter) continue;
    CGSize size = CGSizeMake(maxWidth, maxWidth);
    if (CGRectGetWidth(filter.contentRect) > 0)
      size.height = MAX(1, round(maxWidth * CGRectGetHeight(filter.contentRect) / CGRectGetWidth(filter.contentRect)));
    dispatch_group_enter(group);
    [self captureFilter:filter
                   size:size
             completion:^(NSString *jpeg) {
               if (jpeg.length) @synchronized(found) { found[sourceId] = jpeg; }
               dispatch_group_leave(group);
             }];
  }
  dispatch_group_notify(group, dispatch_get_main_queue(), ^{ completion([found copy]); });
}

+ (SCContentFilter *)filterForSource:(NSString *)sourceId content:(SCShareableContent *)content {
  NSArray<NSString *> *parts = [sourceId componentsSeparatedByString:@":"];
  uint32_t number = 0;
  if (parts.count < 2 || !ParseSourceNumber(parts[1], &number)) return nil;
  if ([parts[0] isEqualToString:@"window"]) {
    for (SCWindow *window in content.windows)
      if (window.windowID == number) return [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
    return nil;
  }
  if ([parts[0] isEqualToString:@"screen"]) {
    for (SCDisplay *display in content.displays)
      if (display.displayID == number) return [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
  }
  return nil;
}

+ (void)captureFilter:(SCContentFilter *)filter size:(CGSize)size completion:(void (^)(NSString *))completion {
  SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
  config.width = (size_t)size.width;
  config.height = (size_t)size.height;
  config.scalesToFit = YES;
  config.showsCursor = NO;
  [SCScreenshotManager captureImageWithFilter:filter
                                 configuration:config
                            completionHandler:^(CGImageRef image, NSError *) {
    completion(JPEGOfImage(image, size));
  }];
}

@end

static BOOL ParseSourceNumber(NSString *text, uint32_t *number) {
  const NSInteger value = text.integerValue;
  if (value <= 0 || value > UINT32_MAX) return NO;
  *number = (uint32_t)value;
  return YES;
}

static NSString *JPEGOfImage(CGImageRef image, CGSize size) {
  if (!image) return nil;
  NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:image];
  bitmap.size = size;
  NSData *jpeg = [bitmap representationUsingType:NSBitmapImageFileTypeJPEG properties:@{NSImageCompressionFactor : @(0.6)}];
  return [jpeg base64EncodedStringWithOptions:0];
}
