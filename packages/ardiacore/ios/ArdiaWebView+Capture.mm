#import "ArdiaWebViewInternal.h"
#import <objc/runtime.h>

static const NSTimeInterval kCapturePictureTimeout = 1.0;
static const NSTimeInterval kFullPageMetricsTimeout = 2.0;
static const NSTimeInterval kFullPagePictureTimeout = 20.0;
static const double kFullPageMostPixels = 16384;
static const NSTimeInterval kCaptureLookupTimeout = 1.0;
static NSString *const kCaptureWorldName = @"ardia-capture";
static char kCaptureWorldKey;

static id CaptureField(id object, NSString *key, Class kind) {
  id value = [object isKindOfClass:NSDictionary.class] ? ((NSDictionary *)object)[key] : nil;
  return [value isKindOfClass:kind] ? value : nil;
}

@implementation ArdiaWebView (Capture)

- (void)copyPictureForCapture:(void (^)(CGImageRef, NSRect))completion {
  NSView *page = _tab.view;
  if (!_tab || !self.window || self.isHiddenOrHasHiddenAncestor || !page || page.superview != self || page.hidden) {
    return completion(NULL, NSZeroRect);
  }
  const NSRect frame = page.frame;
  [_tab copyPicture:kCapturePictureTimeout
         completion:^(CGImageRef picture) {
           completion(picture, frame);
         }];
}

- (NSView *)pageViewForCapture {
  NSView *page = _tab.view;
  return page.superview == self ? page : nil;
}

- (void)evaluateInCaptureWorld:(NSString *)code completion:(void (^)(NSString *))completion {
  if (!_tab) return completion(nil);
  NSDictionary *world = objc_getAssociatedObject(self, &kCaptureWorldKey);
  NSNumber *context = [CaptureField(world, @"documents", NSNumber.class) intValue] == _tab.committedDocumentCount
                          ? CaptureField(world, @"context", NSNumber.class)
                          : nil;
  if (context) return [self evaluate:code inCaptureWorld:context retry:YES completion:completion];
  __weak ArdiaWebView *weakSelf = self;
  [self makeCaptureWorld:^(NSNumber *made) {
    ArdiaWebView *strongSelf = weakSelf;
    if (!strongSelf) return completion(nil);
    if (made) [strongSelf evaluate:code inCaptureWorld:made retry:NO completion:completion];
    else [strongSelf evaluate:code completion:completion];
  }];
}

- (void)makeCaptureWorld:(void (^)(NSNumber *context))done {
  objc_setAssociatedObject(self, &kCaptureWorldKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  const int documents = _tab.committedDocumentCount;
  __weak ArdiaWebView *weakSelf = self;
  [_tab devToolsCall:@"Page.getFrameTree"
              params:nil
             timeout:kCaptureLookupTimeout
          completion:^(NSDictionary *tree, NSString *error) {
            ArdiaWebView *strongSelf = weakSelf;
            NSString *frameId = CaptureField(CaptureField(CaptureField(tree, @"frameTree", NSDictionary.class), @"frame", NSDictionary.class), @"id",
                                             NSString.class);
            if (!strongSelf || !strongSelf->_tab || !frameId) return done(nil);
            [strongSelf->_tab devToolsCall:@"Page.createIsolatedWorld"
                                    params:@{@"frameId" : frameId, @"worldName" : kCaptureWorldName}
                                   timeout:kCaptureLookupTimeout
                                completion:^(NSDictionary *made, NSString *madeError) {
                                  NSNumber *context = CaptureField(made, @"executionContextId", NSNumber.class);
                                  ArdiaWebView *keeper = weakSelf;
                                  if (keeper && context) {
                                    objc_setAssociatedObject(keeper, &kCaptureWorldKey, @{@"documents" : @(documents), @"context" : context},
                                                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
                                  }
                                  done(context);
                                }];
          }];
}

- (void)evaluate:(NSString *)code inCaptureWorld:(NSNumber *)context retry:(BOOL)retry completion:(void (^)(NSString *))completion {
  NSString *expression = [NSString stringWithFormat:@"(() => { let result = null; const post = (kind, json) => { if (kind === 'result') result = json; };\n%@\n; return result; })()", code];
  NSDictionary *params = @{@"expression" : expression, @"contextId" : context, @"returnByValue" : @YES, @"silent" : @YES};
  __weak ArdiaWebView *weakSelf = self;
  [_tab devToolsCall:@"Runtime.evaluate"
              params:params
             timeout:kCaptureLookupTimeout
          completion:^(NSDictionary *reply, NSString *error) {
            ArdiaWebView *strongSelf = weakSelf;
            if (reply) {
              if (CaptureField(reply, @"exceptionDetails", NSDictionary.class)) return completion(nil);
              return completion(CaptureField(CaptureField(reply, @"result", NSDictionary.class), @"value", NSString.class));
            }
            if (!strongSelf || !retry || [error isEqualToString:@"timed out"]) return completion(nil);
            objc_setAssociatedObject(strongSelf, &kCaptureWorldKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            [strongSelf evaluateInCaptureWorld:code completion:completion];
          }];
}

- (void)copyFullPagePicture:(void (^)(NSData *))completion {
  ArdiaCoreTab *tab = _tab;
  if (!tab) return completion(nil);
  const double backing = self.window.backingScaleFactor ?: 2;
  [tab devToolsCall:@"Page.getLayoutMetrics"
             params:@{}
            timeout:kFullPageMetricsTimeout
         completion:^(NSDictionary *metrics, NSString *error) {
           NSDictionary *css = CaptureField(metrics, @"cssContentSize", NSDictionary.class);
           NSDictionary *device = CaptureField(metrics, @"contentSize", NSDictionary.class);
           const double width = [CaptureField(css, @"width", NSNumber.class) doubleValue], height = [CaptureField(css, @"height", NSNumber.class) doubleValue];
           if (!(width > 0 && height > 0)) return completion(nil);
           const double devicePixels = [CaptureField(device, @"width", NSNumber.class) doubleValue];
           const double pixelsPerCSS = devicePixels > 0 ? devicePixels / width : backing;
           const double scale = MAX(1 / pixelsPerCSS, MIN(1, kFullPageMostPixels / (height * pixelsPerCSS)));
           const double shown = MIN(height, floor(kFullPageMostPixels / (pixelsPerCSS * scale)));
           NSDictionary *params = @{
             @"format" : @"png",
             @"captureBeyondViewport" : @YES,
             @"fromSurface" : @YES,
             @"clip" : @{@"x" : @0, @"y" : @0, @"width" : @(width), @"height" : @(shown), @"scale" : @(scale)},
           };
           [tab devToolsCall:@"Page.captureScreenshot"
                      params:params
                     timeout:kFullPagePictureTimeout
                  completion:^(NSDictionary *shot, NSString *failure) {
                    NSString *data = CaptureField(shot, @"data", NSString.class);
                    if (!data) return completion(nil);
                    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                      completion([[NSData alloc] initWithBase64EncodedString:data options:0]);
                    });
                  }];
         }];
}

@end
