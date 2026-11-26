#import "ArdiaHostInternal.h"
#import "ArdiaLaunchConfig.h"

#import <ScreenCaptureKit/ScreenCaptureKit.h>

static NSString *JPEGOfImage(CGImageRef image, CGSize size);
static NSString *FlatnessOfImage(CGImageRef image);

static NSString *const kBlankPreviews = @"@blank";
static NSString *const kBlackPreviews = @"@black";
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
  NSMutableArray<NSString *> *flat = [NSMutableArray array];
  for (NSString *sourceId in sourceIds) {
    SCContentFilter *filter = content ? [self filterForSource:sourceId content:content] : nil;
    if (!filter) continue;
    CGSize size = CGSizeMake(maxWidth, maxWidth);
    if (CGRectGetWidth(filter.contentRect) > 0)
      size.height = MAX(1, round(maxWidth * CGRectGetHeight(filter.contentRect) / CGRectGetWidth(filter.contentRect)));
    dispatch_group_enter(group);
    [self captureFilter:filter
                   size:size
             completion:^(NSString *jpeg, NSString *flatness) {
               @synchronized(found) {
                 if (jpeg.length) found[sourceId] = jpeg;
                 if (jpeg.length && flatness) [flat addObject:flatness];
               }
               dispatch_group_leave(group);
             }];
  }
  dispatch_group_notify(group, dispatch_get_main_queue(), ^{
    NSUInteger blank = 0, black = 0;
    for (NSString *flatness in flat) {
      blank++;
      if ([flatness isEqualToString:@"black"]) black++;
    }
    if (blank) found[kBlankPreviews] = [NSString stringWithFormat:@"%lu", (unsigned long)blank];
    if (black) found[kBlackPreviews] = [NSString stringWithFormat:@"%lu", (unsigned long)black];
    completion([found copy]);
  });
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

+ (void)captureFilter:(SCContentFilter *)filter size:(CGSize)size completion:(void (^)(NSString *, NSString *))completion {
  SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
  config.width = (size_t)size.width;
  config.height = (size_t)size.height;
  config.scalesToFit = YES;
  config.showsCursor = NO;
  [SCScreenshotManager captureImageWithFilter:filter
                                 configuration:config
                            completionHandler:^(CGImageRef image, NSError *) {
    completion(JPEGOfImage(image, size), FlatnessOfImage(image));
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

static NSString *FlatnessOfImage(CGImageRef image) {
  if (!image) return nil;
  constexpr size_t side = 16;
  uint8_t pixels[side * side * 4] = {};
  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(pixels, side, side, 8, side * 4, space, (CGBitmapInfo)kCGImageAlphaNoneSkipLast);
  CGColorSpaceRelease(space);
  if (!context) return nil;
  CGContextSetInterpolationQuality(context, kCGInterpolationLow);
  CGContextDrawImage(context, CGRectMake(0, 0, side, side), image);
  CGContextRelease(context);
  int low[3] = {255, 255, 255}, high[3] = {0, 0, 0};
  long sum = 0;
  for (size_t i = 0; i < side * side; i++) {
    for (int c = 0; c < 3; c++) {
      const int value = pixels[i * 4 + c];
      low[c] = MIN(low[c], value);
      high[c] = MAX(high[c], value);
      sum += value;
    }
  }
  constexpr int kFlatSpread = 6, kBlackMean = 8;
  for (int c = 0; c < 3; c++)
    if (high[c] - low[c] > kFlatSpread) return nil;
  return sum / (long)(side * side * 3) < kBlackMean ? @"black" : @"flat";
}
