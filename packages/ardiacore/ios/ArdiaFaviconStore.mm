#import "ArdiaFaviconStore.h"

#import "ArdiaEngineBridge.h"
#import "ArdiaFaviconSessions.h"
#import "ArdiaInternal.h"
#import "ArdiaRuntime.h"

using ardia_favicons::Kind;

namespace {

constexpr int kLookupSize = 32;

dispatch_queue_t WorkQueue() {
  static dispatch_queue_t queue = dispatch_queue_create("com.ardia.favicons.work", dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_CONCURRENT, QOS_CLASS_USER_INITIATED, 0));
  return queue;
}

NSString *ProfileOf(NSString *profile) {
  return profile ?: @"";
}

NSString *SessionName(NSString *profile, bool isPrivate) {
  return isPrivate ? profile : profile.precomposedStringWithCanonicalMapping.lowercaseString;
}

NSString *SnapshotPath(NSString *profile) {
  if ([profile containsString:@"/"] || [profile hasPrefix:@"."]) return nil;
  NSString *folder = [ArdiaHost.dataDirectory stringByAppendingPathComponent:ardia_host::ProfileDirectoryName(profile)];
  return [folder stringByAppendingPathComponent:@"Ardia Launch Icons.plist"];
}

NSData *Decoded(id base64) {
  return [base64 isKindOfClass:NSString.class] ? [[NSData alloc] initWithBase64EncodedString:base64 options:0] : nil;
}

NSString *ErrorOf(id reply) {
  if (![reply isKindOfClass:NSDictionary.class]) return @"the engine's reply isn't an object";
  id error = reply[@"error"];
  if (!error) return nil;
  return [error isKindOfClass:NSString.class] ? error : [error description];
}

NSArray<NSString *> *WithIcons(id urls) {
  NSMutableArray *kept = [NSMutableArray array];
  if ([urls isKindOfClass:NSArray.class])
    for (id url in urls)
      if (!ardia_favicons::HasNoIcon(url)) [kept addObject:url];
  return kept;
}

void AskEngine(NSString *call, NSString *profile, NSDictionary *args, bool onlyLoaded, void (^done)(id reply, NSString *error)) {
  NSString *json = ardia_runtime::JSONText(args);
  dispatch_async(dispatch_get_main_queue(), ^{
    if (onlyLoaded && (!ArdiaHost.isStarted || !ardia_host::LoadedProfile(ardia_host::OriginalProfileName(profile))))
      return dispatch_async(WorkQueue(), ^{
        done(nil, @"profile not loaded");
      });
    [ArdiaEngineBridge call:call
                    profile:profile
                       args:json
                 completion:^(NSString *reply) {
                   dispatch_async(WorkQueue(), ^{
                     id parsed = ardia_runtime::JSONObject(reply);
                     done(parsed, ErrorOf(parsed));
                   });
                 }];
  });
}

void EngineIcon(ArdiaFaviconSession *session, Kind kind, NSString *key, ardia_favicons::Resolved done) {
  if (session.isPrivate) return done(nil);
  NSDictionary *args = @{@"pages" : kind == Kind::page ? @[ key ] : @[], @"icons" : kind == Kind::icon ? @[ key ] : @[], @"size" : @(kLookupSize)};
  AskEngine(@"ac_favicons_get", session.profile, args, true, ^(id reply, NSString *error) {
    id found = error ? nil : reply[kind == Kind::page ? @"pages" : @"icons"];
    id entry = [found isKindOfClass:NSDictionary.class] ? found[key] : nil;
    done([entry isKindOfClass:NSDictionary.class] ? Decoded(entry[@"png"]) : nil);
  });
}

void Resolve(ArdiaFaviconSession *session, Kind kind, NSString *key, bool network, ardia_favicons::Resolved done) {
  if (kind == Kind::page) return EngineIcon(session, kind, key, done);
  dispatch_async(dispatch_get_main_queue(), ^{
    NSImage *live = nil;
    for (ArdiaCoreTab *tab in ardia_favicons::Tabs(session))
      if (tab.favicon && [tab.faviconURL isEqualToString:key]) live = tab.favicon;
    dispatch_async(WorkQueue(), ^{
      if (NSData *png = live ? [ArdiaFavicons pngOfImage:live] : nil) return done(png);
      EngineIcon(session, kind, key, ^(NSData *stored) {
        if (stored || !network) return done(stored);
        [ArdiaFavicons download:key profile:session.profile completion:done];
      });
    });
  });
}

void Start() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    ardia_favicons::SetResolver(^(ArdiaFaviconSession *session, Kind kind, NSString *key, ardia_favicons::Resolved done) {
      Resolve(session, kind, key, false, done);
    });
  });
}

ArdiaFaviconSession *SessionFor(NSString *profile) {
  Start();
  profile = ProfileOf(profile);
  const bool isPrivate = ardia_host::IsPrivateProfile(profile);
  if (!isPrivate && ardia_host::IsDeletedProfile(profile)) return nil;
  return ardia_favicons::Open(SessionName(profile, isPrivate), profile, isPrivate, isPrivate ? nil : SnapshotPath(profile));
}

NSDictionary *Kept(id found, ArdiaFaviconSession *session, uint64_t epoch, Kind kind) {
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  if (![found isKindOfClass:NSDictionary.class]) return out;
  for (NSString *key in found) {
    NSDictionary *entry = found[key];
    if (![key isKindOfClass:NSString.class] || ![entry isKindOfClass:NSDictionary.class]) continue;
    NSString *icon = [entry[@"icon"] isKindOfClass:NSString.class] ? entry[@"icon"] : nil;
    const bool shared = kind == Kind::page && ardia_favicons::Addressable(Kind::icon, icon);
    NSString *uri = ardia_favicons::Keep(session, epoch, shared ? Kind::icon : kind, shared ? icon : key, Decoded(entry[@"png"]));
    if (uri) out[key] = icon ? @{@"uri" : uri, @"icon" : icon} : @{@"uri" : uri};
  }
  return out;
}

}

@implementation ArdiaFaviconStore

+ (BOOL)holdsURI:(NSString *)uri {
  return ardia_favicons::ParseAddress(uri).key != nil;
}

+ (NSString *)tokenForProfile:(NSString *)profile {
  return SessionFor(profile).token;
}

+ (void)fetchIcon:(NSString *)url profile:(NSString *)profile page:(NSString *)page completion:(void (^)(NSString *, NSData *))completion {
  ArdiaFaviconSession *session = SessionFor(profile);
  if (!session || !ardia_favicons::Addressable(Kind::icon, url)) return completion(nil, nil);
  const uint64_t epoch = ardia_favicons::EpochOf(session);
  Resolve(session, Kind::icon, url, true, ^(NSData *png) {
    NSString *uri = ardia_favicons::Keep(session, epoch, Kind::icon, url, png);
    if (uri && !session.isPrivate && [page isKindOfClass:NSString.class] && !ardia_favicons::HasNoIcon(page))
      AskEngine(@"ac_favicons_set", session.profile, @{@"page" : page, @"icon" : url, @"png" : [png base64EncodedStringWithOptions:0]}, false, ^(id, NSString *) {
      });
    completion(uri, uri ? png : nil);
  });
}

+ (void)noteTab:(id)tab profile:(NSString *)profile {
  ardia_favicons::NoteTab(SessionFor(profile), tab);
}

+ (void)lookUp:(NSString *)args profile:(NSString *)profile completion:(ArdiaFaviconReply)completion {
  id asked = ardia_runtime::JSONObject(args);
  if (![asked isKindOfClass:NSDictionary.class]) return completion(nil, @"bad arguments");
  NSArray<NSString *> *pages = WithIcons(asked[@"pages"]), *icons = WithIcons(asked[@"icons"]);
  ArdiaFaviconSession *session = SessionFor(profile);
  if (!session) return completion(nil, @"no icons for this profile");
  if (!pages.count && !icons.count) return completion(@{@"pages" : @{}, @"icons" : @{}}, nil);
  const uint64_t epoch = ardia_favicons::EpochOf(session);
  NSMutableDictionary *wanted = [asked mutableCopy];
  wanted[@"pages"] = pages;
  wanted[@"icons"] = icons;
  AskEngine(@"ac_favicons_get", ProfileOf(profile), wanted, false, ^(id reply, NSString *error) {
    NSDictionary *found = error ? nil : @{@"pages" : Kept(reply[@"pages"], session, epoch, Kind::page), @"icons" : Kept(reply[@"icons"], session, epoch, Kind::icon)};
    dispatch_async(dispatch_get_main_queue(), ^{
      completion(found, error);
    });
  });
}

+ (void)set:(NSString *)args profile:(NSString *)profile completion:(ArdiaFaviconReply)completion {
  id parsed = ardia_runtime::JSONObject(args);
  if (![parsed isKindOfClass:NSDictionary.class]) return completion(nil, @"bad arguments");
  NSString *page = parsed[@"page"], *icon = parsed[@"icon"];
  NSData *png = Decoded(parsed[@"png"]);
  ArdiaFaviconSession *session = SessionFor(profile);
  if (ardia_favicons::HasNoIcon(page) || !session || session.isPrivate) return completion(@{@"stored" : @NO}, nil);
  if (!ardia_favicons::Decodes(png)) return completion(nil, @"not a PNG");
  const uint64_t epoch = ardia_favicons::EpochOf(session);
  AskEngine(@"ac_favicons_set", ProfileOf(profile), parsed, false, ^(id reply, NSString *error) {
    NSMutableDictionary *out = error ? nil : [reply mutableCopy];
    const bool shared = ardia_favicons::Addressable(Kind::icon, icon);
    NSString *uri = [out[@"stored"] boolValue] ? ardia_favicons::Keep(session, epoch, shared ? Kind::icon : Kind::page, shared ? icon : page, png) : nil;
    if (uri) out[@"uri"] = uri;
    dispatch_async(dispatch_get_main_queue(), ^{
      completion(out, error);
    });
  });
}

+ (void)loadPNGForURI:(NSString *)uri completion:(void (^)(NSData *))completion {
  Start();
  ardia_favicons::Load(uri, ^(ArdiaFaviconDelivery *delivery) {
    __block NSData *png = nil;
    [delivery deliver:^(NSData *bytes) {
      png = bytes;
    }];
    completion(png);
  });
}

+ (NSData *)heldPNGForURI:(NSString *)uri {
  return ardia_favicons::Held(uri);
}

+ (id)derivedForURI:(NSString *)uri kind:(NSString *)kind {
  return ardia_favicons::Derived(uri, kind);
}

+ (void)setDerived:(id)object forURI:(NSString *)uri kind:(NSString *)kind {
  ardia_favicons::SetDerived(uri, kind, object);
}

+ (void)forgetProfile:(NSString *)profile {
  ardia_favicons::Forget(SessionFor(profile));
}

+ (NSArray<NSString *> *)saveLaunchIcons:(NSArray<NSString *> *)uris profile:(NSString *)profile {
  return ardia_host::IsPrivateProfile(ProfileOf(profile)) ? @[] : ardia_favicons::SaveSnapshot(SessionFor(profile), uris);
}

+ (void)retireProfile:(NSString *)profile {
  profile = ProfileOf(profile);
  ardia_favicons::Retire(SessionName(profile, ardia_host::IsPrivateProfile(profile)));
}

+ (void)restoreProfile:(NSString *)profile {
  profile = ProfileOf(profile);
  ardia_favicons::Restore(SessionName(profile, ardia_host::IsPrivateProfile(profile)));
}

+ (NSDictionary<NSString *, NSNumber *> *)takeCounts {
  const ardia_favicons::Counts counts = ardia_favicons::TakeCounts();
  return @{@"memory" : @(counts.memory), @"resolved" : @(counts.resolved), @"missed" : @(counts.missed), @"kept" : @(counts.kept), @"refused" : @(counts.refused), @"snapshot" : @(counts.snapshot)};
}

@end
