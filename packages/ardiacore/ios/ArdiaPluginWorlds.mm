#import "ArdiaPluginWorlds.h"

#import "ArdiaCore.h"

namespace {
NSString *const kPluginPrefix = @"ardia-plugin:";
NSString *const kStyleWorld = @"ardia-plugin-styles";
NSString *const kTake = @"globalThis.__ardiaWorld ? globalThis.__ardiaWorld.take() : Promise.resolve(null)";
constexpr NSTimeInterval kCallTimeout = 2.0;
constexpr NSTimeInterval kPollTimeout = 25.0;
constexpr NSUInteger kMaxJSON = 64 * 256 * 1024 + 1024;

BOOL IsWorld(NSString *world) {
  if ([world isEqualToString:kStyleWorld]) return YES;
  if (![world hasPrefix:kPluginPrefix] || world.length > kPluginPrefix.length + 123) return NO;
  NSArray<NSString *> *parts = [[world substringFromIndex:kPluginPrefix.length] componentsSeparatedByString:@"~"];
  if (parts.count > 2 || !parts[0].length || parts[0].length > 82 || (parts.count == 2 && (!parts[1].length || parts[1].length > 40))) return NO;
  NSCharacterSet *key = [NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyz0123456789-_"];
  NSCharacterSet *unit = [NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"];
  return [parts[0] rangeOfCharacterFromSet:key.invertedSet].location == NSNotFound && (parts.count == 1 || [parts[1] rangeOfCharacterFromSet:unit.invertedSet].location == NSNotFound);
}

NSString *const kNonce =
    @"(() => { if (!Object.prototype.hasOwnProperty.call(globalThis, '__ardiaDocNonce')) { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); "
    @"Object.defineProperty(globalThis, '__ardiaDocNonce', { value: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''), writable: false, configurable: false }); } "
    @"return globalThis.__ardiaDocNonce; })()";
NSString *const kStale = @"__ardia_stale__";

BOOL IsNonce(id value) {
  if (![value isKindOfClass:NSString.class] || [value length] != 32) return NO;
  NSCharacterSet *hex = [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"];
  return [value rangeOfCharacterFromSet:hex.invertedSet].location == NSNotFound;
}

NSString *Guarded(NSString *nonce, NSString *expression) {
  return [NSString stringWithFormat:@"(() => { if (globalThis.__ardiaDocNonce !== \"%@\") return \"%@\"; return (\n%@\n); })()", nonce, kStale, expression];
}

NSString *ContextKey(NSString *world, NSString *document) { return [NSString stringWithFormat:@"%@|%@", world, document]; }
}

@implementation ArdiaPluginWorlds {
  ArdiaPluginWorldMessages _messages;
  NSMutableDictionary<NSString *, NSNumber *> *_contexts;
  NSMutableDictionary<NSString *, NSString *> *_nonces;
  NSMutableDictionary<NSString *, NSNumber *> *_polls;
}

- (instancetype)initWithMessages:(ArdiaPluginWorldMessages)messages {
  if ((self = [super init])) {
    _messages = [messages copy];
    _contexts = [NSMutableDictionary dictionary];
    _nonces = [NSMutableDictionary dictionary];
    _polls = [NSMutableDictionary dictionary];
  }
  return self;
}

- (void)frameOfTab:(ArdiaCoreTab *)tab completion:(void (^)(NSString *_Nullable frame, NSString *_Nullable document))completion {
  [tab devToolsCall:@"Page.getFrameTree" params:@{} timeout:kCallTimeout completion:^(NSDictionary *tree, NSString *error) {
    NSDictionary *frame = [tree[@"frameTree"][@"frame"] isKindOfClass:NSDictionary.class] ? tree[@"frameTree"][@"frame"] : nil;
    NSString *frameId = [frame[@"id"] isKindOfClass:NSString.class] ? frame[@"id"] : nil;
    NSString *loader = [frame[@"loaderId"] isKindOfClass:NSString.class] ? frame[@"loaderId"] : nil;
    completion(frameId, loader);
  }];
}

- (void)documentOfTab:(ArdiaCoreTab *)tab completion:(void (^)(NSString *_Nullable document))completion {
  if (tab.closed) return completion(nil);
  [self frameOfTab:tab completion:^(NSString *frame, NSString *document) { completion(document); }];
}

- (void)context:(NSString *)world document:(NSString *)document onTab:(ArdiaCoreTab *)tab then:(void (^)(NSNumber *_Nullable context, NSString *_Nullable nonce))then {
  __weak ArdiaPluginWorlds *weakSelf = self;
  [self frameOfTab:tab completion:^(NSString *frame, NSString *current) {
    ArdiaPluginWorlds *strong = weakSelf;
    if (!strong || !frame || ![current isEqualToString:document]) return then(nil, nil);
    NSString *key = ContextKey(world, document);
    if (NSNumber *known = strong->_contexts[key]) return then(known, strong->_nonces[key]);
    NSDictionary *params = @{@"frameId" : frame, @"worldName" : world, @"grantUniveralAccess" : @NO};
    [tab devToolsCall:@"Page.createIsolatedWorld" params:params timeout:kCallTimeout completion:^(NSDictionary *made, NSString *madeError) {
      NSNumber *context = [made[@"executionContextId"] isKindOfClass:NSNumber.class] ? made[@"executionContextId"] : nil;
      if (!weakSelf || !context) return then(nil, nil);
      NSDictionary *stamp = @{@"expression" : kNonce, @"contextId" : context, @"returnByValue" : @YES, @"awaitPromise" : @NO};
      [tab devToolsCall:@"Runtime.evaluate" params:stamp timeout:kCallTimeout completion:^(NSDictionary *stamped, NSString *stampError) {
        id nonce = stamped[@"result"][@"value"];
        if (!weakSelf || stampError || !IsNonce(nonce)) return then(nil, nil);
        [weakSelf frameOfTab:tab completion:^(NSString *madeFrame, NSString *after) {
          ArdiaPluginWorlds *still = weakSelf;
          if (!still || ![after isEqualToString:document] || ![madeFrame isEqualToString:frame]) return then(nil, nil);
          if (NSNumber *raced = still->_contexts[key]) return then(raced, still->_nonces[key]);
          still->_contexts[key] = context;
          still->_nonces[key] = nonce;
          then(context, nonce);
        }];
      }];
    }];
  }];
}

- (void)evaluate:(NSString *)expression in:(NSString *)world document:(NSString *)document onTab:(ArdiaCoreTab *)tab completion:(void (^)(BOOL ran))completion {
  __weak ArdiaPluginWorlds *weakSelf = self;
  [self context:world document:document onTab:tab then:^(NSNumber *context, NSString *nonce) {
    if (!context || !nonce) return completion(NO);
    NSDictionary *params = @{@"expression" : Guarded(nonce, expression), @"contextId" : context, @"returnByValue" : @YES, @"awaitPromise" : @NO};
    [tab devToolsCall:@"Runtime.evaluate" params:params timeout:kCallTimeout completion:^(NSDictionary *result, NSString *error) {
      ArdiaPluginWorlds *strong = weakSelf;
      id value = result[@"result"][@"value"];
      const BOOL stale = [value isEqual:kStale];
      if ((error || stale) && strong) [strong forget:ContextKey(world, document)];
      completion(!error && !stale && !result[@"exceptionDetails"] && ![value isEqual:@NO] && ![value isEqual:@""]);
    }];
  }];
}

- (void)run:(NSString *)world source:(NSString *)source document:(NSString *)document onTab:(ArdiaCoreTab *)tab completion:(void (^)(BOOL ran))completion {
  if (!IsWorld(world) || tab.closed || !document.length) return completion(NO);
  __weak ArdiaPluginWorlds *weakSelf = self;
  [self evaluate:source in:world document:document onTab:tab completion:^(BOOL ran) {
    ArdiaPluginWorlds *strong = weakSelf;
    if (ran && strong && [world hasPrefix:kPluginPrefix]) [strong poll:world document:document onTab:tab];
    completion(ran);
  }];
}

- (void)poll:(NSString *)world document:(NSString *)document onTab:(ArdiaCoreTab *)tab {
  NSString *key = ContextKey(world, document);
  NSNumber *context = _contexts[key];
  if (!context || !_nonces[key] || [_polls[key] isEqual:context]) return;
  _polls[key] = context;
  [self pollOnce:world document:document context:context onTab:tab];
}

- (void)pollOnce:(NSString *)world document:(NSString *)document context:(NSNumber *)context onTab:(ArdiaCoreTab *)tab {
  __weak ArdiaPluginWorlds *weakSelf = self;
  __weak ArdiaCoreTab *weakTab = tab;
  NSString *key = ContextKey(world, document);
  NSString *nonce = _nonces[key];
  if (!nonce) return;
  NSDictionary *params = @{@"expression" : Guarded(nonce, kTake), @"contextId" : context, @"returnByValue" : @YES, @"awaitPromise" : @YES};
  [tab devToolsCall:@"Runtime.evaluate" params:params timeout:kPollTimeout completion:^(NSDictionary *result, NSString *error) {
    ArdiaPluginWorlds *strong = weakSelf;
    ArdiaCoreTab *liveTab = weakTab;
    if (!strong || ![strong->_polls[key] isEqual:context]) return;
    id value = result[@"result"][@"value"];
    if (error || result[@"exceptionDetails"] || !liveTab || liveTab.closed || value == nil || value == NSNull.null || [value isEqual:kStale]) {
      [strong->_polls removeObjectForKey:key];
      if ([strong->_contexts[key] isEqual:context]) [strong forget:key];
      return;
    }
    [strong frameOfTab:liveTab completion:^(NSString *frame, NSString *current) {
      ArdiaPluginWorlds *again = weakSelf;
      ArdiaCoreTab *stillTab = weakTab;
      if (!again || ![again->_polls[key] isEqual:context]) return;
      if (![current isEqualToString:document] || !stillTab || stillTab.closed) {
        [again->_polls removeObjectForKey:key];
        if ([again->_contexts[key] isEqual:context]) [again forget:key];
        return;
      }
      if ([value isKindOfClass:NSString.class] && [value length] > 2 && [value length] <= kMaxJSON) again->_messages(world, document, value);
      [again pollOnce:world document:document context:context onTab:stillTab];
    }];
  }];
}

- (void)post:(NSString *)world expression:(NSString *)expression document:(NSString *)document onTab:(ArdiaCoreTab *)tab {
  if (![world hasPrefix:kPluginPrefix] || !IsWorld(world) || !_contexts[ContextKey(world, document)] || tab.closed) return;
  [self evaluate:expression in:world document:document onTab:tab completion:^(BOOL ran) {}];
}

- (void)remove:(NSString *)world teardown:(NSString *)teardown onTab:(ArdiaCoreTab *)tab {
  if (!IsWorld(world)) return;
  NSString *prefix = [world stringByAppendingString:@"|"];
  NSArray<NSString *> *keys = [_contexts.allKeys filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSString *key, NSDictionary *bindings) { return [key hasPrefix:prefix]; }]];
  for (NSString *key in keys) {
    NSNumber *context = _contexts[key];
    [self forget:key];
    [_polls removeObjectForKey:key];
    if (tab.closed || !context) continue;
    NSDictionary *params = @{@"expression" : teardown, @"contextId" : context, @"returnByValue" : @YES, @"awaitPromise" : @NO};
    [tab devToolsCall:@"Runtime.evaluate" params:params timeout:kCallTimeout completion:^(NSDictionary *result, NSString *error) {}];
  }
}

- (void)forget:(NSString *)key {
  [_contexts removeObjectForKey:key];
  [_nonces removeObjectForKey:key];
}

- (void)forgetAll {
  [_nonces removeAllObjects];
  [_contexts removeAllObjects];
  [_polls removeAllObjects];
}

@end
