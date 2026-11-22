#import "ArdiaWebViewInternal.h"
#import "ArdiaHost.h"

namespace {

constexpr NSTimeInterval kSiteDataCallTimeout = 1.0;
constexpr NSUInteger kMaxSiteDataOrigins = 16;
constexpr NSUInteger kMaxStorageBytes = 2000000;
constexpr NSUInteger kMaxStorageWrites = 4000;
constexpr NSUInteger kMaxCookieWrites = 2000;

typedef void (^DevToolsDone)(NSDictionary *_Nullable result, NSString *_Nullable error);

NSString *BareDomain(id domain) {
  if (![domain isKindOfClass:NSString.class]) return @"";
  return [[(NSString *)domain lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"."]];
}

BOOL Covered(NSString *domain, NSArray<NSString *> *domains) {
  NSString *bare = BareDomain(domain);
  if (!bare.length) return NO;
  for (NSString *wanted in domains) {
    if ([bare isEqualToString:wanted] || [bare hasSuffix:[@"." stringByAppendingString:wanted]]) return YES;
  }
  return NO;
}

NSArray<NSString *> *Strings(id value, NSUInteger limit) {
  NSMutableArray<NSString *> *out = [NSMutableArray array];
  if (![value isKindOfClass:NSArray.class]) return out;
  for (id item in (NSArray *)value) {
    if ([item isKindOfClass:NSString.class] && [(NSString *)item length]) [out addObject:[(NSString *)item lowercaseString]];
    if (out.count >= limit) break;
  }
  return out;
}

NSString *WebOrigin(NSString *text) {
  NSURL *url = [NSURL URLWithString:text];
  NSString *scheme = url.scheme.lowercaseString;
  if (!url.host.length || !([scheme isEqualToString:@"https"] || [scheme isEqualToString:@"http"])) return nil;
  NSString *host = url.host.lowercaseString;
  return url.port ? [NSString stringWithFormat:@"%@://%@:%@", scheme, host, url.port] : [NSString stringWithFormat:@"%@://%@", scheme, host];
}

NSDictionary *StorageId(NSString *origin) {
  return @{@"storageKey" : [origin stringByAppendingString:@"/"], @"isLocalStorage" : @YES};
}

NSDictionary *CookieWrite(id raw) {
  if (![raw isKindOfClass:NSDictionary.class]) return nil;
  NSDictionary *cookie = raw;
  NSMutableDictionary *param = [NSMutableDictionary dictionary];
  for (NSString *key in @[ @"name", @"value", @"url", @"domain", @"path", @"sameSite" ]) {
    if ([cookie[key] isKindOfClass:NSString.class]) param[key] = cookie[key];
  }
  for (NSString *key in @[ @"secure", @"httpOnly" ]) {
    if ([cookie[key] isKindOfClass:NSNumber.class]) param[key] = cookie[key];
  }
  if ([cookie[@"expires"] isKindOfClass:NSNumber.class] && [cookie[@"expires"] doubleValue] > 0) param[@"expires"] = cookie[@"expires"];
  if (![param[@"name"] length] || !param[@"value"] || !(param[@"url"] || param[@"domain"])) return nil;
  return param;
}

}

@implementation ArdiaWebView (SiteData)

- (void)siteDataCall:(NSString *)method params:(NSDictionary *)params done:(DevToolsDone)done {
  ArdiaCoreTab *tab = _tab;
  if (!tab || tab.closed) return done(nil, @"no tab");
  [tab devToolsCall:method params:params timeout:kSiteDataCallTimeout completion:done];
}

- (void)siteData:(NSDictionary<NSString *, id> *)request completion:(void (^)(NSDictionary<NSString *, id> *))completion {
  if (!_tab || _tab.closed || self.awaitsFirstDocument || !_profile || [ArdiaHost isPrivateProfile:_profile]) return completion(nil);
  NSString *op = [request[@"op"] isKindOfClass:NSString.class] ? request[@"op"] : @"";
  if ([op isEqualToString:@"read"]) return [self readSiteData:request completion:completion];
  if ([op isEqualToString:@"write"]) return [self writeSiteData:request completion:completion];
  completion(nil);
}

- (void)readSiteData:(NSDictionary *)request completion:(void (^)(NSDictionary *))completion {
  NSArray<NSString *> *domains = Strings(request[@"domains"], 64);
  NSMutableOrderedSet<NSString *> *origins = [NSMutableOrderedSet orderedSet];
  for (NSString *text in Strings(request[@"origins"], kMaxSiteDataOrigins)) {
    if (NSString *origin = WebOrigin(text)) [origins addObject:origin];
  }
  __block NSArray *cookies = nil;
  NSMutableDictionary *storage = [NSMutableDictionary dictionary];
  dispatch_group_t group = dispatch_group_create();
  dispatch_group_enter(group);
  __weak ArdiaWebView *weakSelf = self;
  [self siteDataCall:@"Network.getAllCookies" params:nil done:^(NSDictionary *result, NSString *error) {
    void (^take)(NSDictionary *) = ^(NSDictionary *reply) {
      NSArray *all = [reply[@"cookies"] isKindOfClass:NSArray.class] ? reply[@"cookies"] : nil;
      if (all) {
        NSMutableArray *kept = [NSMutableArray array];
        for (id cookie in all) {
          if (![cookie isKindOfClass:NSDictionary.class] || cookie[@"partitionKey"] || [cookie[@"partitionKeyOpaque"] boolValue]) continue;
          if (Covered(cookie[@"domain"], domains)) [kept addObject:cookie];
        }
        cookies = kept;
      }
      dispatch_group_leave(group);
    };
    if (result) return take(result);
    ArdiaWebView *strongSelf = weakSelf;
    if (!strongSelf) return take(nil);
    [strongSelf siteDataCall:@"Storage.getCookies" params:nil done:^(NSDictionary *fallback, NSString *fallbackError) { take(fallback); }];
  }];
  for (NSString *origin in origins) {
    dispatch_group_enter(group);
    [self siteDataCall:@"DOMStorage.getDOMStorageItems" params:@{@"storageId" : StorageId(origin)} done:^(NSDictionary *result, NSString *error) {
      NSArray *entries = [result[@"entries"] isKindOfClass:NSArray.class] ? result[@"entries"] : nil;
      NSMutableArray *items = entries ? [NSMutableArray array] : nil;
      NSUInteger bytes = 0;
      for (id entry in entries) {
        if (![entry isKindOfClass:NSArray.class] || [entry count] != 2 || ![entry[0] isKindOfClass:NSString.class] || ![entry[1] isKindOfClass:NSString.class]) continue;
        bytes += [entry[0] length] + [entry[1] length];
        if (bytes > kMaxStorageBytes) {
          items = nil;
          break;
        }
        [items addObject:entry];
      }
      storage[origin] = items ?: (id)NSNull.null;
      dispatch_group_leave(group);
    }];
  }
  dispatch_group_notify(group, dispatch_get_main_queue(), ^{
    if (!cookies) return completion(nil);
    completion(@{@"cookies" : cookies, @"storage" : storage});
  });
}

- (void)writeSiteData:(NSDictionary *)request completion:(void (^)(NSDictionary *))completion {
  NSMutableArray *writes = [NSMutableArray array];
  if ([request[@"cookies"] isKindOfClass:NSArray.class]) {
    for (id raw in request[@"cookies"]) {
      if (NSDictionary *param = CookieWrite(raw)) [writes addObject:param];
      if (writes.count >= kMaxCookieWrites) break;
    }
  }
  NSArray *removals = [request[@"remove"] isKindOfClass:NSArray.class] ? request[@"remove"] : @[];
  NSDictionary *storage = [request[@"storage"] isKindOfClass:NSDictionary.class] ? request[@"storage"] : @{};
  __block NSInteger cookiesWritten = 0, removed = 0, storageWritten = 0;
  __block NSUInteger storageOps = 0;
  dispatch_group_t group = dispatch_group_create();
  for (NSDictionary *param in writes) {
    dispatch_group_enter(group);
    [self siteDataCall:@"Network.setCookie" params:param done:^(NSDictionary *result, NSString *error) {
      if ([result[@"success"] boolValue]) cookiesWritten++;
      dispatch_group_leave(group);
    }];
  }
  for (id raw in removals) {
    if (![raw isKindOfClass:NSDictionary.class] || ![raw[@"name"] isKindOfClass:NSString.class] || ![raw[@"domain"] isKindOfClass:NSString.class]) continue;
    NSMutableDictionary *params = [@{@"name" : raw[@"name"], @"domain" : raw[@"domain"]} mutableCopy];
    if ([raw[@"path"] isKindOfClass:NSString.class]) params[@"path"] = raw[@"path"];
    dispatch_group_enter(group);
    [self siteDataCall:@"Network.deleteCookies" params:params done:^(NSDictionary *result, NSString *error) {
      if (result) removed++;
      dispatch_group_leave(group);
    }];
  }
  for (NSString *key in storage) {
    NSString *origin = [key isKindOfClass:NSString.class] ? WebOrigin(key) : nil;
    NSDictionary *change = [storage[key] isKindOfClass:NSDictionary.class] ? storage[key] : nil;
    if (!origin || !change) continue;
    NSDictionary *storageId = StorageId(origin);
    NSArray *set = [change[@"set"] isKindOfClass:NSArray.class] ? change[@"set"] : @[];
    NSArray *remove = [change[@"remove"] isKindOfClass:NSArray.class] ? change[@"remove"] : @[];
    for (id pair in set) {
      if (![pair isKindOfClass:NSArray.class] || [pair count] != 2 || ![pair[0] isKindOfClass:NSString.class] || ![pair[1] isKindOfClass:NSString.class]) continue;
      if (++storageOps > kMaxStorageWrites) break;
      dispatch_group_enter(group);
      [self siteDataCall:@"DOMStorage.setDOMStorageItem" params:@{@"storageId" : storageId, @"key" : pair[0], @"value" : pair[1]} done:^(NSDictionary *result, NSString *error) {
        if (result) storageWritten++;
        dispatch_group_leave(group);
      }];
    }
    for (id name in remove) {
      if (![name isKindOfClass:NSString.class] || ++storageOps > kMaxStorageWrites) continue;
      dispatch_group_enter(group);
      [self siteDataCall:@"DOMStorage.removeDOMStorageItem" params:@{@"storageId" : storageId, @"key" : name} done:^(NSDictionary *result, NSString *error) {
        if (result) storageWritten++;
        dispatch_group_leave(group);
      }];
    }
  }
  dispatch_group_notify(group, dispatch_get_main_queue(), ^{
    completion(@{@"cookiesWritten" : @(cookiesWritten), @"removed" : @(removed), @"storageWritten" : @(storageWritten)});
  });
}

@end
