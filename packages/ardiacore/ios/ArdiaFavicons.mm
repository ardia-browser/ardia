#import "ArdiaInternal.h"

#import "ArdiaFaviconAddress.h"
#import "ArdiaFaviconStore.h"

namespace {

constexpr int kFaviconSize = 32;
constexpr NSUInteger kMaxBytes = 2 * 1024 * 1024;

NSDictionary *Sized(NSString *uri, NSData *png) {
  if (!uri || png.length < 24) return nil;
  const uint8_t *bytes = static_cast<const uint8_t *>(png.bytes);
  return @{@"uri" : uri, @"width" : @(ardia_favicons::BigEndian(bytes + 16)), @"height" : @(ardia_favicons::BigEndian(bytes + 20))};
}

NSString *Inline(NSData *png) {
  return png.length ? [@"data:image/png;base64," stringByAppendingString:[png base64EncodedStringWithOptions:0]] : nil;
}

NSData *PNG(NSImage *image, int pixels, int *width, int *height) {
  if (!image || image.size.width <= 0 || image.size.height <= 0) return nil;
  NSImageRep *best = nil;
  NSInteger bestSize = 0;
  for (NSImageRep *rep in image.representations) {
    NSInteger size = MAX(rep.pixelsWide, rep.pixelsHigh);
    if (size <= 0) size = NSIntegerMax;
    const bool better = !best || (bestSize < pixels ? size > bestSize : (size >= pixels && size < bestSize));
    if (better) best = rep, bestSize = size;
  }
  if (!best) return nil;
  const int side = (int)MIN((NSInteger)pixels, bestSize);
  NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:side pixelsHigh:side bitsPerSample:8
                                                                samplesPerPixel:4 hasAlpha:YES isPlanar:NO
                                                                 colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
  NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
  if (!context) return nil;
  [NSGraphicsContext saveGraphicsState];
  NSGraphicsContext.currentContext = context;
  context.imageInterpolation = NSImageInterpolationHigh;
  NSSize size = best.size.width > 0 && best.size.height > 0 ? best.size : image.size;
  CGFloat scale = side / MAX(size.width, size.height);
  NSRect rect = NSMakeRect((side - size.width * scale) / 2, (side - size.height * scale) / 2, size.width * scale, size.height * scale);
  [best drawInRect:rect fromRect:NSZeroRect operation:NSCompositingOperationCopy fraction:1 respectFlipped:YES hints:nil];
  [NSGraphicsContext restoreGraphicsState];
  *width = side;
  *height = side;
  return [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

void Download(NSString *url, NSString *profileName, void (^done)(NSData *_Nullable data)) {
  void (^fetch)(ArdiaCoreProfile *) = ^(ArdiaCoreProfile *profile) {
    if (!profile || profile.destroyed) return done(nil);
    [profile fetchIcon:url maxBytes:kMaxBytes completion:done];
  };
  if (ardia_host::IsPrivateProfile(profileName)) return fetch(ardia_host::LoadedProfile(profileName));
  ardia_host::WithProfile(profileName, fetch);
}

}

@implementation ArdiaFavicons

+ (NSData *)pngOfImage:(NSImage *)image {
  int width = 0, height = 0;
  return PNG(image, kFaviconSize * 2, &width, &height);
}

+ (void)download:(NSString *)url profile:(NSString *)profile completion:(void (^)(NSData *))completion {
  if (!ardia_favicons::IsWebURL(url)) return completion(nil);
  dispatch_async(dispatch_get_main_queue(), ^{
    Download(url, profile, ^(NSData *body) {
      completion(body ? [self pngOfImage:[[NSImage alloc] initWithData:body]] : nil);
    });
  });
}

+ (void)fetch:(NSString *)url
       profile:(NSString *)profile
          page:(NSString *)page
    completion:(void (^)(NSDictionary<NSString *, id> *))completion {
  if ([url hasPrefix:@"data:image/"]) return [self fetchImage:url profile:profile completion:completion];
  if (!ardia_favicons::IsWebURL(url)) return completion(nil);
  [ArdiaFaviconStore fetchIcon:url
                       profile:profile
                          page:page
                    completion:^(NSString *uri, NSData *png) {
                      completion(Sized(uri, png));
                    }];
}

+ (void)fetchImage:(NSString *)url profile:(NSString *)profile completion:(void (^)(NSDictionary<NSString *, id> *))completion {
  if ([url hasPrefix:@"data:image/"]) {
    NSData *data = [NSData dataWithContentsOfURL:[NSURL URLWithString:url]];
    NSData *png = data ? [self pngOfImage:[[NSImage alloc] initWithData:data]] : nil;
    return completion(Sized(Inline(png), png));
  }
  [self download:url
         profile:profile
      completion:^(NSData *png) {
        completion(Sized(Inline(png), png));
      }];
}

@end
