#import "ArdiaInternal.h"
#import "ArdiaHostInternal.h"
#import "ArdiaHost.h"

using namespace ardia_host;

static ArdiaCoreWindow *OffscreenWindowFor(ArdiaCoreProfile *profile) {
  NSString *name = ProfileName(profile);
  static NSMutableDictionary<NSString *, ArdiaCoreWindow *> *windows = [NSMutableDictionary dictionary];
  ArdiaCoreWindow *window = windows[name];
  if (window.window) return window;
  window = [[ArdiaCoreWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1280, 800)];
  if (!window.window) return nil;
  window.internal = YES;
  window.automation = YES;
  windows[name] = window;
  return window;
}

static NSDictionary<NSString *, id> *OffscreenRefusal(NSString *reason) {
  return @{@"ok" : @NO, @"reason" : reason};
}

@implementation ArdiaHost (HiddenPage)

static NSMutableDictionary<NSString *, ArdiaCoreTab *> *HiddenPages() {
  static NSMutableDictionary<NSString *, ArdiaCoreTab *> *pages = [NSMutableDictionary dictionary];
  return pages;
}

+ (void)hiddenPageOpen:(NSString *)profileName url:(NSString *)url completion:(void (^)(NSDictionary<NSString *, id> *))completion {
  WithProfile(profileName, ^(ArdiaCoreProfile *profile) {
    if (!profile) return completion(OffscreenRefusal(@"That profile isn't loaded."));
    ArdiaCoreWindow *window = OffscreenWindowFor(profile);
    if (!window) return completion(OffscreenRefusal(@"Ardia couldn't make an off-screen window."));
    ArdiaCoreTab *tab = [window openTab:url profile:profile foreground:NO];
    if (!tab) return completion(OffscreenRefusal(@"Ardia couldn't open the page."));
    [self hiddenPageWaitSettled:tab tries:100 completion:completion];
  });
}

+ (void)hiddenPageWaitSettled:(ArdiaCoreTab *)tab tries:(NSInteger)tries completion:(void (^)(NSDictionary<NSString *, id> *))completion {
  if (tab.closed || tries <= 0) {
    [tab close];
    return completion(OffscreenRefusal(@"The page never finished loading."));
  }
  if (tab.loading || tab.committedInitial) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      [self hiddenPageWaitSettled:tab tries:tries - 1 completion:completion];
    });
    return;
  }
  NSString *pageId = NSUUID.UUID.UUIDString;
  HiddenPages()[pageId] = tab;
  completion(@{@"ok" : @YES, @"pageId" : pageId});
}

+ (void)hiddenPageRun:(NSString *)pageId script:(NSString *)script timeout:(double)timeoutSeconds completion:(void (^)(NSDictionary<NSString *, id> *))completion {
  ArdiaCoreTab *tab = HiddenPages()[pageId];
  if (!tab || tab.closed) return completion(OffscreenRefusal(@"That page is no longer open."));
  __block BOOL answered = NO;
  [tab evaluate:script
      completion:^(NSString *json) {
        if (answered) return;
        answered = YES;
        if (!json.length) return completion(OffscreenRefusal(@"The page had no answer."));
        NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
        id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        if (!parsed) return completion(OffscreenRefusal(@"The page's answer wasn't readable."));
        completion(@{@"ok" : @YES, @"json" : parsed});
      }];
  if (!(timeoutSeconds > 0)) timeoutSeconds = 30;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeoutSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (answered) return;
    answered = YES;
    completion(OffscreenRefusal(@"The page had no answer."));
  });
}

+ (void)hiddenPageClose:(NSString *)pageId {
  ArdiaCoreTab *tab = HiddenPages()[pageId];
  [HiddenPages() removeObjectForKey:pageId];
  [tab close];
}

@end
