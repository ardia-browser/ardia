#import "ArdiaSavedSession.h"
#import "ArdiaSavedDocument.h"

namespace {

template <typename T>
T *Typed(id value) {
  return [value isKindOfClass:[T class]] ? value : nil;
}

NSArray<NSDictionary *> *Dictionaries(id value) {
  NSMutableArray<NSDictionary *> *out = [NSMutableArray array];
  for (id item in Typed<NSArray>(value) ?: @[])
    if ([item isKindOfClass:NSDictionary.class]) [out addObject:item];
  return out;
}

bool AbsentOr(id value, Class kind) {
  return !value || [value isKindOfClass:kind];
}

bool AbsentNullOr(id value, Class kind) {
  return !value || value == NSNull.null || [value isKindOfClass:kind];
}

bool WindowWellTyped(id window) {
  if (![window isKindOfClass:NSDictionary.class]) return false;
  NSDictionary *w = window;
  return [w[@"id"] isKindOfClass:NSString.class] && AbsentOr(w[@"profileId"], NSString.class) && AbsentOr(w[@"incognito"], NSNumber.class) &&
         AbsentOr(w[@"kind"], NSString.class) && AbsentNullOr(w[@"frame"], NSArray.class) && AbsentOr(w[@"tabIds"], NSArray.class) &&
         AbsentNullOr(w[@"display"], NSString.class) && AbsentOr(w[@"activeTabIds"], NSDictionary.class) &&
         AbsentNullOr(w[@"sidebarOpen"], NSNumber.class) && AbsentNullOr(w[@"autoHideTabs"], NSNumber.class) &&
         AbsentNullOr(w[@"tabLayout"], NSString.class);
}

bool EarlyLaunchFieldsWellTyped(NSDictionary *document) {
  id windows = document[@"windows"];
  if (windows && ![windows isKindOfClass:NSArray.class]) return false;
  for (id window in windows ?: @[])
    if (!WindowWellTyped(window)) return false;
  return AbsentNullOr(document[@"settings"], NSDictionary.class) && AbsentNullOr(document[@"launchBackdrop"], NSDictionary.class) &&
         AbsentNullOr(document[@"launchTab"], NSDictionary.class) && AbsentNullOr(document[@"focusedWindowId"], NSString.class) &&
         AbsentNullOr(document[@"linkProfile"], NSString.class) && AbsentOr(document[@"tabs"], NSArray.class) &&
         AbsentOr(document[@"groups"], NSArray.class) && AbsentOr(document[@"splits"], NSArray.class);
}

}

@implementation ArdiaSavedSession

+ (NSInteger)version {
  return 11;
}

+ (instancetype)readFrom:(NSString *)directory {
  NSDictionary *document = [ArdiaSavedDocument read:@"session.json" in:directory oldest:0 newest:self.version];
  return document && EarlyLaunchFieldsWellTyped(document) ? [[self alloc] initWithDocument:document] : nil;
}

+ (instancetype)atLaunch:(NSString *)directory {
  static ArdiaSavedSession *session;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    session = [self readFrom:directory];
  });
  return session;
}

- (instancetype)initWithDocument:(NSDictionary *)document {
  if ((self = [super init])) {
    _fileVersion = [Typed<NSNumber>(document[@"version"]) integerValue];
    _focusedWindowId = Typed<NSString>(document[@"focusedWindowId"]);
    _linkProfile = Typed<NSString>(document[@"linkProfile"]);
    NSDictionary *hint = Typed<NSDictionary>(document[@"launchTab"]);
    NSString *key = Typed<NSString>(hint[@"id"]), *url = Typed<NSString>(hint[@"url"]), *profile = Typed<NSString>(hint[@"profile"]);
    if (key && url && profile) {
      _launchTabId = key;
      _launchTabURL = url;
      _launchTabProfile = profile;
    }
    _launchBackdrop = Typed<NSDictionary>(document[@"launchBackdrop"]);
    _settings = Typed<NSDictionary>(document[@"settings"]) ?: @{};
    _profiles = document[@"profiles"];
    _windows = Dictionaries(document[@"windows"]);
    _tabs = Dictionaries(document[@"tabs"]);
    _groups = Dictionaries(document[@"groups"]);
    _splits = Dictionaries(document[@"splits"]);
  }
  return self;
}

- (id)pinOfTab:(NSDictionary *)tab {
  return _fileVersion < 6 ? tab[@"pinned"] : tab[@"pin"];
}

- (NSArray<NSString *> *)tabIdsOfSplit:(NSDictionary *)split {
  NSMutableArray<NSString *> *ids = [NSMutableArray array];
  if (_fileVersion < 7) {
    for (id tabId in Typed<NSArray>(split[@"tabIds"]) ?: @[])
      if ([tabId isKindOfClass:NSString.class]) [ids addObject:tabId];
    return ids;
  }
  for (NSDictionary *slot in Dictionaries(split[@"slots"])) {
    if (NSString *tabId = Typed<NSString>(slot[@"tabId"])) [ids addObject:tabId];
    for (id tabId in Typed<NSArray>(slot[@"stack"]) ?: @[])
      if ([tabId isKindOfClass:NSString.class]) [ids addObject:tabId];
  }
  return ids;
}

- (NSDictionary *)windowWithId:(NSString *)windowId {
  for (NSDictionary *window in _windows)
    if ([window[@"id"] isEqual:windowId]) return window;
  return nil;
}

@end
