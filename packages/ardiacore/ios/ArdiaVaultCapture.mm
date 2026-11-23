#import "ArdiaVaultCapture.h"

static const NSTimeInterval kLoginLifetime = 180;
static const NSTimeInterval kGeneratedLifetime = 1800;
static const NSTimeInterval kRepeatWindow = 2;
static const NSTimeInterval kFillTimeout = 4;
static const NSUInteger kMaxFrames = 64;
static const NSUInteger kMaxLogins = 16;
static const NSUInteger kMaxFills = 8;
const NSTimeInterval kArdiaVaultLandingWait = 8;
static const NSTimeInterval kLandingOvertakes = 3;

static NSTimeInterval Now() { return NSProcessInfo.processInfo.systemUptime; }

static NSHashTable<ArdiaVaultCapture *> *LiveCaptures() {
  static NSHashTable<ArdiaVaultCapture *> *captures;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    captures = [NSHashTable weakObjectsHashTable];
  });
  return captures;
}

static void DropOldest(NSMutableDictionary<NSString *, NSDictionary *> *entries) {
  NSString *oldest = nil;
  double oldestAt = 0;
  for (NSString *key in entries) {
    const double at = [entries[key][@"at"] doubleValue];
    if (!oldest || at < oldestAt) {
      oldest = key;
      oldestAt = at;
    }
  }
  if (oldest) [entries removeObjectForKey:oldest];
}

@implementation ArdiaVaultCapture {
  NSString *_mainFrame;
  NSString *_mainOrigin;
  NSMutableDictionary<NSString *, NSString *> *_frameOrigins;
  NSMutableOrderedSet<NSString *> *_frameOrder;
  NSMutableDictionary<NSString *, NSDictionary *> *_logins;
  NSMutableDictionary<NSString *, NSDictionary *> *_fills;
  NSMutableDictionary<NSString *, NSDictionary *> *_generated;
  NSUInteger _autofillGeneration;
  NSString *_autofillFrame;
  NSString *_autofillOrigin;
  NSString *_autofillTop;
  NSDictionary *_leftLogin;
  NSDictionary *_lastDocument;
}

- (instancetype)init {
  if ((self = [super init])) {
    _frameOrigins = [NSMutableDictionary dictionary];
    _frameOrder = [NSMutableOrderedSet orderedSet];
    _logins = [NSMutableDictionary dictionary];
    _fills = [NSMutableDictionary dictionary];
    _generated = [NSMutableDictionary dictionary];
    [LiveCaptures() addObject:self];
  }
  return self;
}

- (void)dealloc {
  NSArray<NSDictionary *> *pending = _fills.allValues;
  [_fills removeAllObjects];
  for (NSDictionary *fill in pending) ((void (^)(NSArray<NSString *> *))fill[@"reply"])(@[]);
}

- (void)noteFieldInFrame:(NSString *)frameId origin:(NSString *)origin main:(BOOL)main {
  if (!origin.length || !frameId) return;
  if (main) {
    if (_mainFrame && ![_mainFrame isEqualToString:frameId]) [self forgetFrame:_mainFrame];
    [self forgetFrame:frameId];
    _mainFrame = [frameId copy];
    _mainOrigin = [origin copy];
    return;
  }
  if ([frameId isEqualToString:_mainFrame ?: @""]) return;
  [_frameOrder removeObject:frameId];
  [_frameOrder addObject:frameId];
  _frameOrigins[frameId] = origin;
  while (_frameOrder.count > kMaxFrames) {
    [_frameOrigins removeObjectForKey:_frameOrder.firstObject];
    [_frameOrder removeObjectAtIndex:0];
  }
}

- (NSString *)originOfFrame:(NSString *)frameId {
  if (frameId && [frameId isEqualToString:_mainFrame ?: @""]) return _mainOrigin;
  return _frameOrigins[frameId];
}

- (void)forgetFrame:(NSString *)frameId {
  if (!frameId) return;
  if ([frameId isEqualToString:_mainFrame ?: @""]) {
    _mainFrame = nil;
    _mainOrigin = nil;
  }
  [_frameOrigins removeObjectForKey:frameId];
  [_frameOrder removeObject:frameId];
}

- (void)dropExpiredLogins {
  const NSTimeInterval now = Now();
  for (NSString *origin in _logins.allKeys) {
    NSNumber *at = _logins[origin][@"at"];
    if (now - at.doubleValue >= kLoginLifetime) [_logins removeObjectForKey:origin];
  }
}

- (BOOL)keepLogin:(NSString *)username password:(NSString *)password origin:(NSString *)origin {
  if (!origin.length || !password.length) return NO;
  [self dropExpiredLogins];
  NSDictionary *previous = _logins[origin];
  const NSTimeInterval now = Now();
  if (previous && ![previous[@"generated"] boolValue] && [previous[@"username"] isEqualToString:username] &&
      [previous[@"password"] isEqualToString:password] && now - [previous[@"at"] doubleValue] < kRepeatWindow)
    return NO;
  while (!previous && _logins.count >= kMaxLogins) DropOldest(_logins);
  _logins[origin] = @{@"username" : username ?: @"", @"password" : password, @"at" : @(now)};
  __weak ArdiaVaultCapture *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)((kLoginLifetime + 1) * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    [weakSelf dropExpiredLogins];
  });
  return YES;
}

- (NSDictionary<NSString *, NSString *> *)takeLogin:(NSString *)origin {
  [self dropExpiredLogins];
  NSDictionary *login = origin.length ? _logins[origin] : nil;
  if (!login) return nil;
  [_logins removeObjectForKey:origin];
  return @{@"username" : login[@"username"], @"password" : login[@"password"]};
}

- (void)discardLogin:(NSString *)origin {
  if (!origin.length) return;
  [_logins removeObjectForKey:origin];
  [_generated removeObjectForKey:origin];
}

- (void)keepGeneratedPassword:(NSString *)password origin:(NSString *)origin {
  if (!origin.length || !password.length) return;
  while (!_generated[origin] && _generated.count >= kMaxLogins) DropOldest(_generated);
  _generated[origin] = @{@"password" : [password copy], @"at" : @(Now())};
  __weak ArdiaVaultCapture *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)((kGeneratedLifetime + 1) * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    [weakSelf dropExpiredGenerated];
  });
  if (![self keepLogin:@"" password:password origin:origin]) return;
  NSMutableDictionary *login = [_logins[origin] mutableCopy];
  login[@"generated"] = @YES;
  _logins[origin] = login;
}

- (BOOL)isGeneratedPassword:(NSString *)password origin:(NSString *)origin {
  [self dropExpiredGenerated];
  NSDictionary *generated = origin.length ? _generated[origin] : nil;
  if (!generated) return NO;
  NSString *kept = generated[@"password"];
  return kept.length && password.length && [kept isEqualToString:password];
}

- (void)dropExpiredGenerated {
  const NSTimeInterval now = Now();
  for (NSString *origin in _generated.allKeys)
    if (now - [_generated[origin][@"at"] doubleValue] >= kGeneratedLifetime) [_generated removeObjectForKey:origin];
}

- (NSString *)generatedPasswordFor:(NSString *)origin {
  [self dropExpiredGenerated];
  NSString *kept = origin.length ? _generated[origin][@"password"] : nil;
  return kept.length ? kept : nil;
}

- (NSDictionary<NSString *, NSString *> *)peekLogin:(NSString *)origin {
  [self dropExpiredLogins];
  NSDictionary *login = origin.length ? _logins[origin] : nil;
  if (!login) return nil;
  return @{@"username" : login[@"username"], @"password" : login[@"password"]};
}

- (void)noteAutofillFieldInFrame:(NSString *)frameId origin:(NSString *)origin top:(NSString *)topOrigin focused:(BOOL)focused {
  _autofillGeneration++;
  const BOOL pinned = focused && topOrigin.length;
  _autofillFrame = pinned ? [frameId ?: @"" copy] : nil;
  _autofillOrigin = pinned ? [(origin.length ? origin : topOrigin) copy] : nil;
  _autofillTop = pinned ? [topOrigin copy] : nil;
}

- (NSString *)autofillFieldPinAt:(NSString *)currentTopOrigin {
  if (!_autofillTop || ![_autofillTop isEqualToString:currentTopOrigin ?: @""]) return nil;
  return [NSString stringWithFormat:@"%lu\n%@\n%@\n%@", (unsigned long)_autofillGeneration, _autofillFrame, _autofillOrigin, _autofillTop];
}

- (NSDictionary<NSString *, id> *)noteLoginLeftFrame:(NSString *)frameId
                      main:(BOOL)main
                    origin:(NSString *)origin
                  username:(NSString *)username
                   expired:(void (^)(NSDictionary<NSString *, id> *outcome))expired {
  if (!frameId || !origin.length) return nil;
  NSString *token = NSUUID.UUID.UUIDString;
  NSDictionary *left = @{@"frameId" : frameId, @"main" : @(main), @"origin" : origin, @"username" : username ?: @"", @"token" : token};
  _leftLogin = left;
  __weak ArdiaVaultCapture *weakSelf = self;
  void (^report)(NSDictionary<NSString *, id> *) = [expired copy];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kArdiaVaultLandingWait * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    ArdiaVaultCapture *capture = weakSelf;
    if (!capture || ![capture->_leftLogin[@"token"] isEqualToString:token]) return;
    capture->_leftLogin = nil;
    report([ArdiaVaultCapture outcomeOf:left ok:YES]);
  });
  NSDictionary *earlier = _lastDocument;
  const BOOL arrivedFirst = main && earlier && ![earlier[@"frameId"] isEqualToString:frameId] && Now() - [earlier[@"at"] doubleValue] < kLandingOvertakes;
  return arrivedFirst ? [self landingOf:earlier[@"frameId"] origin:earlier[@"origin"]] : nil;
}

+ (NSDictionary<NSString *, id> *)outcomeOf:(NSDictionary *)left ok:(BOOL)ok {
  return @{@"frameId" : left[@"frameId"], @"origin" : left[@"origin"], @"ok" : @(ok)};
}

- (NSDictionary<NSString *, id> *)noteDocumentInFrame:(NSString *)frameId main:(BOOL)main origin:(NSString *)origin {
  if (frameId && main) _lastDocument = @{@"frameId" : frameId, @"origin" : origin ?: @"", @"at" : @(Now())};
  NSDictionary *left = _leftLogin;
  if (!left || left[@"checking"]) return nil;
  const BOOL sameFrame = [left[@"main"] boolValue] ? main : [left[@"frameId"] isEqualToString:frameId ?: @""];
  if (!sameFrame) return nil;
  return [self landingOf:frameId origin:origin];
}

- (NSDictionary<NSString *, id> *)landingOf:(NSString *)frameId origin:(NSString *)origin {
  NSDictionary *left = _leftLogin;
  if (![left[@"origin"] isEqualToString:origin ?: @""]) {
    _leftLogin = nil;
    return @{@"outcome" : [ArdiaVaultCapture outcomeOf:left ok:YES]};
  }
  NSMutableDictionary *checking = [left mutableCopy];
  checking[@"checking"] = frameId;
  _leftLogin = checking;
  return @{@"check" : left[@"username"], @"frame" : frameId};
}

- (NSDictionary<NSString *, id> *)landingCheckedInFrame:(NSString *)frameId ok:(BOOL)ok {
  NSDictionary *left = _leftLogin;
  if (!left || ![left[@"checking"] isEqualToString:frameId ?: @""]) return nil;
  _leftLogin = nil;
  return [ArdiaVaultCapture outcomeOf:left ok:ok];
}

- (NSString *)awaitFillInFrame:(NSString *)frameId reply:(void (^)(NSArray<NSString *> *filled))reply {
  if (_fills.count >= kMaxFills)
    for (NSString *stale in _fills.allKeys) [self finishFill:stale frame:_fills[stale][@"frame"] filled:@[]];
  NSString *fillId = NSUUID.UUID.UUIDString;
  _fills[fillId] = @{@"frame" : frameId, @"reply" : [reply copy]};
  __weak ArdiaVaultCapture *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kFillTimeout * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    [weakSelf finishFill:fillId frame:frameId filled:@[]];
  });
  return fillId;
}

- (void)finishFill:(NSString *)fillId frame:(NSString *)frameId filled:(NSArray<NSString *> *)filled {
  NSDictionary *fill = fillId.length ? _fills[fillId] : nil;
  if (!fill || ![fill[@"frame"] isEqualToString:frameId]) return;
  [_fills removeObjectForKey:fillId];
  void (^reply)(NSArray<NSString *> *) = (void (^)(NSArray<NSString *> *))fill[@"reply"];
  if (reply) reply(filled);
}

- (void)wipe {
  [_logins removeAllObjects];
  [_generated removeAllObjects];
  [_frameOrigins removeAllObjects];
  [_frameOrder removeAllObjects];
  _mainFrame = nil;
  _mainOrigin = nil;
  _autofillGeneration++;
  _autofillFrame = nil;
  _autofillOrigin = nil;
  _autofillTop = nil;
  _leftLogin = nil;
  for (NSString *fillId in _fills.allKeys) [self finishFill:fillId frame:_fills[fillId][@"frame"] filled:@[]];
}

+ (void)wipeAll {
  for (ArdiaVaultCapture *capture in LiveCaptures().allObjects) [capture wipe];
}

@end
