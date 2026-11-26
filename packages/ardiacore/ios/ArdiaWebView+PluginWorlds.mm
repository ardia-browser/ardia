#import <objc/runtime.h>

#import "ArdiaEvents.h"
#import "ArdiaPluginWorlds.h"
#import "ArdiaWebViewInternal.h"

namespace {
const void *const kPluginWorldsKey = &kPluginWorldsKey;
}

@implementation ArdiaWebView (PluginWorlds)

- (ArdiaPluginWorlds *)pluginWorlds {
  ArdiaPluginWorlds *worlds = objc_getAssociatedObject(self, kPluginWorldsKey);
  if (worlds) return worlds;
  __weak ArdiaWebView *weakSelf = self;
  worlds = [[ArdiaPluginWorlds alloc] initWithMessages:^(NSString *world, NSString *document, NSString *json) {
    ArdiaWebView *strong = weakSelf;
    NSString *tabId = strong ? strong->_transferKey : nil;
    if (!tabId) return;
    [ArdiaEvents emit:@"webView.pluginWorld" data:[[ArdiaConsentStamp begin] onto:@{@"tabId" : tabId, @"world" : world, @"document" : document, @"json" : json}]];
  }];
  objc_setAssociatedObject(self, kPluginWorldsKey, worlds, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  return worlds;
}

- (void)pluginDocument:(void (^)(NSString *_Nullable document))completion {
  if (!_tab || _tab.closed || self.awaitsFirstDocument) return completion(nil);
  [self.pluginWorlds documentOfTab:_tab completion:completion];
}

- (void)runPluginWorld:(NSString *)world source:(NSString *)source document:(NSString *)document completion:(void (^)(BOOL ran))completion {
  if (!_tab || _tab.closed || self.awaitsFirstDocument) return completion(NO);
  [self.pluginWorlds run:world source:source document:document onTab:_tab completion:completion];
}

- (void)postPluginWorld:(NSString *)world expression:(NSString *)expression document:(NSString *)document {
  if (!_tab || _tab.closed) return;
  [self.pluginWorlds post:world expression:expression document:document onTab:_tab];
}

- (void)removePluginWorld:(NSString *)world teardown:(NSString *)teardown {
  if (!_tab) return [self.pluginWorlds forgetAll];
  [self.pluginWorlds remove:world teardown:teardown onTab:_tab];
}

@end
