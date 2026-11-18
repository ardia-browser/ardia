#import "ArdiaProtectedVideoInternal.h"

using namespace ardia_runtime;
using namespace ardia_web_view;
using namespace ardia_protected_video;

@implementation ArdiaPVSession (Keys)

- (void)keyRequest:(NSDictionary *)message session:(NSInteger)session {
  NSString *keySystem = Text(message, @"keySystem", 32);
  NSString *type = Text(message, @"type", 16);
  NSData *data = Base64(message, @"data", kMaxPartChars);
  if (![keySystem hasPrefix:@"com.apple.fps"] || !data.length || data.length > kMaxKeyData) return;
  NSArray<NSData *> *ids = @[];
  NSData *initialization = nil;
  if ([type isEqualToString:@"sinf"]) {
    ids = SinfKeyIDs(data);
    initialization = data;
  } else if ([type isEqualToString:@"cenc"]) {
    NSData *pssh = FairPlayPssh(data);
    ids = pssh ? FairPlayKeyIDs(pssh) : @[];
    initialization = pssh ? [NSJSONSerialization dataWithJSONObject:@{@"pssh" : [pssh base64EncodedStringWithOptions:0]} options:0 error:nil] : nil;
  }
  if (!ids.count || !initialization) {
    Trace(@"no key ids in %@ init data", type);
    return [self deliver:@{@"event" : @"keys", @"session" : @(session), @"ok" : @NO}];
  }
  if (!_keySessions[@(session)] && (NSInteger)_keySessions.count >= kMaxKeySessions) return;
  ArdiaPVKeySession *owner = _keySessions[@(session)] ?: [ArdiaPVKeySession new];
  owner->_keySystem = keySystem;
  owner->_raw = ![keySystem isEqualToString:@"com.apple.fps.3_0"];
  _keySessions[@(session)] = owner;
  _lastKeySession = @(session);
  for (NSData *kid in ids) {
    if (_keyOwners[kid] && _contentKeys[kid]) Trace(@"key %@ already usable, asked again by session %ld", Hex(kid), (long)session);
    _keyOwners[kid] = @(session);
  }
  Trace(@"%@ request for %lu keys from session %ld", type, (unsigned long)ids.count, (long)session);
  [_keys processContentKeyRequestWithIdentifier:nil initializationData:initialization options:@{@"InitializationDataType" : type}];
}

- (void)keyUpdate:(NSDictionary *)message session:(NSInteger)session {
  NSData *data = Base64(message, @"data", kMaxPartChars);
  ArdiaPVKeySession *owner = _keySessions[@(session)];
  if (!owner || !data.length || data.length > kMaxKeyData) return;
  if (owner->_raw) {
    NSData *kid = owner->_awaitingKid;
    owner->_awaitingKid = nil;
    AVContentKeyRequest *request = kid ? _keyRequests[kid] : nil;
    if (request) {
      [_keyRequests removeObjectForKey:kid];
      [request processContentKeyResponse:[AVContentKeyResponse contentKeyResponseWithFairPlayStreamingKeyResponseData:data]];
    }
    return [self askPageForNextRawKey:session];
  }
  NSArray *entries = JSONObject([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"");
  if (![entries isKindOfClass:NSArray.class]) return;
  for (NSDictionary *entry in entries) {
    if (![entry isKindOfClass:NSDictionary.class]) continue;
    NSData *kid = Base64(entry, @"keyID", 64);
    NSData *ckc = Base64(entry, @"payload", kMaxPartChars);
    AVContentKeyRequest *request = kid ? _keyRequests[kid] : nil;
    if (!request) continue;
    [_keyRequests removeObjectForKey:kid];
    if (ckc.length) [request processContentKeyResponse:[AVContentKeyResponse contentKeyResponseWithFairPlayStreamingKeyResponseData:ckc]];
    else [request processContentKeyResponseError:[NSError errorWithDomain:@"ArdiaProtectedVideo" code:1 userInfo:nil]];
  }
}

- (void)addRenderersAsKeyRecipients {
  for (id renderer in @[ _display, _audio ]) {
    if ([renderer conformsToProtocol:@protocol(AVContentKeyRecipient)]) [_keys addContentKeyRecipient:renderer];
    else Trace(@"%@ cannot take content keys", NSStringFromClass([renderer class]));
  }
}

- (NSData *)keyIDOf:(AVContentKeyRequest *)request {
  id identifier = request.identifier;
  if ([identifier isKindOfClass:NSData.class] && [identifier length] == 16) return identifier;
  if ([identifier isKindOfClass:NSString.class] && [identifier hasPrefix:@"skd://"]) return Unhex([identifier substringFromIndex:6].lowercaseString);
  NSData *initialization = request.initializationData;
  if (!initialization.length) return nil;
  id parsed = JSONObject([[NSString alloc] initWithData:initialization encoding:NSUTF8StringEncoding] ?: @"");
  if ([parsed isKindOfClass:NSDictionary.class] && [parsed[@"pssh"] isKindOfClass:NSString.class]) {
    NSData *pssh = [[NSData alloc] initWithBase64EncodedString:parsed[@"pssh"] options:0];
    return pssh ? FairPlayKeyIDs(pssh).firstObject : nil;
  }
  return SinfKeyIDs(initialization).firstObject;
}

- (void)contentKeySession:(AVContentKeySession *)session
    didProvideContentKeyRequests:(NSArray<AVContentKeyRequest *> *)keyRequests
           forInitializationData:(NSData *)initializationData {
  for (AVContentKeyRequest *request in keyRequests) [self contentKeySession:session didProvideContentKeyRequest:request];
}

- (void)contentKeySession:(AVContentKeySession *)session didProvideContentKeyRequest:(AVContentKeyRequest *)keyRequest {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSData *kid = [self keyIDOf:keyRequest];
    if (!kid) return Trace(@"key request without a key id: %@", keyRequest.identifier);
    self->_keyRequests[kid] = keyRequest;
    [self->_keyBatch addObject:keyRequest];
    if (self->_flushQueued) return;
    self->_flushQueued = YES;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 150 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      self->_flushQueued = NO;
      [self flushKeyRequests];
    });
  });
}

- (void)contentKeySession:(AVContentKeySession *)session didProvideRenewingContentKeyRequest:(AVContentKeyRequest *)keyRequest {
  [self contentKeySession:session didProvideContentKeyRequest:keyRequest];
}

- (void)flushKeyRequests {
  if (!_certificate || !_keyBatch.count) return;
  NSArray<AVContentKeyRequest *> *batch = [_keyBatch copy];
  [_keyBatch removeAllObjects];
  NSMutableDictionary<NSNumber *, NSMutableArray<AVContentKeyRequest *> *> *byOwner = [NSMutableDictionary dictionary];
  for (AVContentKeyRequest *request in batch) {
    NSData *kid = [self keyIDOf:request];
    NSNumber *owner = (kid ? _keyOwners[kid] : nil) ?: _lastKeySession;
    if (!owner || !_keySessions[owner]) continue;
    if (kid) _keyOwners[kid] = owner;
    if (!byOwner[owner]) byOwner[owner] = [NSMutableArray array];
    [byOwner[owner] addObject:request];
  }
  [byOwner enumerateKeysAndObjectsUsingBlock:^(NSNumber *owner, NSMutableArray<AVContentKeyRequest *> *requests, BOOL *stop) {
    [self askPage:owner.integerValue for:requests];
  }];
}

- (void)askPage:(NSInteger)session for:(NSArray<AVContentKeyRequest *> *)requests {
  dispatch_group_t group = dispatch_group_create();
  NSMutableArray<NSDictionary *> *entries = [NSMutableArray array];
  NSData *certificate = _certificate;
  for (AVContentKeyRequest *request in requests) {
    NSData *kid = [self keyIDOf:request];
    dispatch_group_enter(group);
    [request makeStreamingContentKeyRequestDataForApp:certificate
                                    contentIdentifier:kid
                                              options:nil
                                    completionHandler:^(NSData *spc, NSError *error) {
                                      @synchronized(entries) {
                                        if (spc) [entries addObject:@{@"keyID" : kid, @"payload" : spc}];
                                      }
                                      if (error) Trace(@"spc failed for %@: %@", Hex(kid), error);
                                      dispatch_group_leave(group);
                                    }];
  }
  __weak ArdiaPVSession *weakSelf = self;
  dispatch_group_notify(group, dispatch_get_main_queue(), ^{
    ArdiaPVSession *strong = weakSelf;
    ArdiaPVKeySession *owner = strong ? strong->_keySessions[@(session)] : nil;
    if (!owner || !entries.count) return;
    if (owner->_raw) {
      if (!owner->_rawQueue) owner->_rawQueue = [NSMutableArray array];
      [owner->_rawQueue addObjectsFromArray:entries];
      return [strong askPageForNextRawKey:session];
    }
    NSMutableArray *json = [NSMutableArray array];
    for (NSDictionary *entry in entries)
      [json addObject:@{@"keyID" : [entry[@"keyID"] base64EncodedStringWithOptions:0], @"payload" : [entry[@"payload"] base64EncodedStringWithOptions:0]}];
    NSData *message = [NSJSONSerialization dataWithJSONObject:json options:0 error:nil];
    Trace(@"%lu key requests to session %ld", (unsigned long)entries.count, (long)session);
    if (message) [strong deliver:@{@"event" : @"message", @"session" : @(session), @"data" : [message base64EncodedStringWithOptions:0]}];
  });
}

- (void)askPageForNextRawKey:(NSInteger)session {
  ArdiaPVKeySession *owner = _keySessions[@(session)];
  while (owner && !owner->_awaitingKid && owner->_rawQueue.count) {
    NSDictionary *entry = owner->_rawQueue.firstObject;
    [owner->_rawQueue removeObjectAtIndex:0];
    if (!_keyRequests[entry[@"keyID"]]) continue;
    owner->_awaitingKid = entry[@"keyID"];
    [self deliver:@{@"event" : @"message", @"session" : @(session), @"data" : [entry[@"payload"] base64EncodedStringWithOptions:0]}];
  }
}

- (void)contentKeySession:(AVContentKeySession *)session contentKeyRequestDidSucceed:(AVContentKeyRequest *)keyRequest {
  AVContentKey *contentKey = keyRequest.contentKey;
  dispatch_async(dispatch_get_main_queue(), ^{
    NSData *kid = [self keyIDOf:keyRequest];
    NSNumber *owner = kid ? self->_keyOwners[kid] : nil;
    ArdiaPVKeySession *keySession = owner ? self->_keySessions[owner] : nil;
    Trace(@"key %@ usable", kid ? Hex(kid) : @"?");
    if (kid) {
      self->_contentKeys[kid] = contentKey ?: (id)NSNull.null;
      [self keysChanged];
    }
    if (!keySession) return;
    keySession->_succeeded = YES;
    [self deliver:@{@"event" : @"keys", @"session" : owner, @"ok" : @YES, @"keyIDs" : @[ [kid base64EncodedStringWithOptions:0] ]}];
  });
}

- (void)contentKeySession:(AVContentKeySession *)session contentKeyRequest:(AVContentKeyRequest *)keyRequest didFailWithError:(NSError *)error {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSData *kid = [self keyIDOf:keyRequest];
    NSNumber *owner = kid ? self->_keyOwners[kid] : nil;
    ArdiaPVKeySession *keySession = owner ? self->_keySessions[owner] : nil;
    if (kid) [self->_keyRequests removeObjectForKey:kid];
    Trace(@"key %@ failed: %@", kid ? Hex(kid) : @"?", error);
    if (keySession && keySession->_raw && [keySession->_awaitingKid isEqualToData:kid]) {
      keySession->_awaitingKid = nil;
      [self askPageForNextRawKey:owner.integerValue];
    }
    if (!keySession || error.code == kContentKeyTimedOut) return;
    [self deliver:@{@"event" : @"keys", @"session" : owner, @"ok" : @NO}];
    if (keySession->_succeeded || self->_licenseFailed) return;
    self->_licenseFailed = YES;
    [self report:@{@"event" : @"failed", @"step" : @"license", @"video" : @YES}];
  });
}

@end
