#import "ArdiaHLSVideoInternal.h"

using namespace ardia_runtime;
using namespace ardia_web_view;
using namespace ardia_hls_video;

@implementation ArdiaHLSVideoSession (Keys)

- (void)openKeySession:(NSInteger)session data:(NSData *)data {
  NSString *keyURI;
  NSData *contentId, *certificate;
  if (!data.length || data.length > kMaxKeyData || !ParseSessionData(data, &keyURI, &contentId, &certificate)) {
    Trace(@"session %ld: unreadable init data", (long)session);
    return [self deliver:@{@"event" : @"keyerror", @"session" : @(session), @"code" : @(-1)}];
  }
  if (!_keySessions[@(session)] && (NSInteger)_keySessions.count >= kMaxKeySessions) return;
  ArdiaHLSKeySession *owner = [ArdiaHLSKeySession new];
  owner->_keyURI = keyURI;
  owner->_contentId = contentId;
  owner->_certificate = certificate;
  _keySessions[@(session)] = owner;
  _keyOwners[keyURI] = @(session);
  Trace(@"session %ld for %@", (long)session, keyURI);
  if (AVContentKeyRequest *request = _keyRequests[keyURI]) [self askPage:session for:request];
  else [_keys processContentKeyRequestWithIdentifier:keyURI initializationData:nil options:nil];
}

- (void)askPage:(NSInteger)session for:(AVContentKeyRequest *)request {
  ArdiaHLSKeySession *owner = _keySessions[@(session)];
  if (!owner || owner->_awaiting == request) return;
  owner->_awaiting = request;
  __weak ArdiaHLSVideoSession *weakSelf = self;
  [request makeStreamingContentKeyRequestDataForApp:owner->_certificate
                                  contentIdentifier:owner->_contentId
                                            options:@{AVContentKeyRequestProtocolVersionsKey : @[ @1 ]}
                                  completionHandler:^(NSData *spc, NSError *error) {
                                    dispatch_async(dispatch_get_main_queue(), ^{
                                      ArdiaHLSVideoSession *strong = weakSelf;
                                      if (!strong || strong->_keySessions[@(session)] != owner) return;
                                      if (!spc.length) {
                                        Trace(@"spc failed for session %ld: %@", (long)session, error);
                                        owner->_awaiting = nil;
                                        [strong keyFailed:session code:error.code];
                                        return;
                                      }
                                      [strong deliver:@{@"event" : @"keymessage", @"session" : @(session), @"data" : [spc base64EncodedStringWithOptions:0]}];
                                    });
                                  }];
}

- (void)updateKeySession:(NSInteger)session data:(NSData *)data {
  ArdiaHLSKeySession *owner = _keySessions[@(session)];
  if (!owner) return;
  AVContentKeyRequest *request = owner->_awaiting;
  if (!request || !data.length || data.length > kMaxKeyData) return;
  owner->_awaiting = nil;
  Trace(@"ckc for session %ld (%lu bytes)", (long)session, (unsigned long)data.length);
  [request processContentKeyResponse:[AVContentKeyResponse contentKeyResponseWithFairPlayStreamingKeyResponseData:data]];
}

- (void)closeKeySession:(NSInteger)session {
  ArdiaHLSKeySession *owner = _keySessions[@(session)];
  if (!owner) return;
  [_keySessions removeObjectForKey:@(session)];
  if ([_keyOwners[owner->_keyURI] isEqual:@(session)]) [_keyOwners removeObjectForKey:owner->_keyURI];
}

- (void)keyFailed:(NSInteger)session code:(NSInteger)code {
  ArdiaHLSKeySession *owner = _keySessions[@(session)];
  [self deliver:@{@"event" : @"keyerror", @"session" : @(session), @"code" : @(code)}];
  if (!owner || owner->_succeeded || _licenseFailed) return;
  _licenseFailed = YES;
  [self report:@{@"event" : @"failed", @"step" : @"license"}];
}

- (NSString *)keyURIOf:(AVContentKeyRequest *)request {
  NSString *identifier = [request.identifier isKindOfClass:NSString.class] ? request.identifier : nil;
  return [identifier hasPrefix:kKeyScheme] && identifier.length <= kMaxKeyURIChars ? identifier : nil;
}

- (void)contentKeySession:(AVContentKeySession *)session didProvideContentKeyRequest:(AVContentKeyRequest *)keyRequest {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSString *keyURI = [self keyURIOf:keyRequest];
    if (!keyURI) return;
    self->_keyRequests[keyURI] = keyRequest;
    NSNumber *owner = self->_keyOwners[keyURI];
    Trace(@"key request %@ (%@)", keyURI, owner ? @"session open" : @"asking the page");
    if (owner && self->_keySessions[owner]) return [self askPage:owner.integerValue for:keyRequest];
    if (self->_media) [self deliver:@{@"event" : @"needkey", @"media" : @(self->_media), @"data" : [LegacyInitData(keyURI) base64EncodedStringWithOptions:0]}];
  });
}

- (void)contentKeySession:(AVContentKeySession *)session didProvideRenewingContentKeyRequest:(AVContentKeyRequest *)keyRequest {
  [self contentKeySession:session didProvideContentKeyRequest:keyRequest];
}

- (void)contentKeySession:(AVContentKeySession *)session contentKeyRequestDidSucceed:(AVContentKeyRequest *)keyRequest {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSString *keyURI = [self keyURIOf:keyRequest];
    NSNumber *owner = keyURI ? self->_keyOwners[keyURI] : nil;
    ArdiaHLSKeySession *keySession = owner ? self->_keySessions[owner] : nil;
    Trace(@"key %@ usable", keyURI);
    if (!keySession) return;
    keySession->_succeeded = YES;
    [self deliver:@{@"event" : @"keyadded", @"session" : owner}];
  });
}

- (void)contentKeySession:(AVContentKeySession *)session contentKeyRequest:(AVContentKeyRequest *)keyRequest didFailWithError:(NSError *)error {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSString *keyURI = [self keyURIOf:keyRequest];
    NSNumber *owner = keyURI ? self->_keyOwners[keyURI] : nil;
    Trace(@"key %@ failed: %@", keyURI, error);
    if (keyURI && self->_keyRequests[keyURI] == keyRequest) [self->_keyRequests removeObjectForKey:keyURI];
    ArdiaHLSKeySession *keySession = owner ? self->_keySessions[owner] : nil;
    if (!keySession) return;
    if (keySession->_awaiting == keyRequest) keySession->_awaiting = nil;
    [self keyFailed:owner.integerValue code:error.code];
  });
}

@end
