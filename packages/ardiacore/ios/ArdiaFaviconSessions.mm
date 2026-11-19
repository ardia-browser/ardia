#import "ArdiaFaviconSessions.h"

#import <ImageIO/ImageIO.h>
#import <Security/Security.h>
#import <os/lock.h>

@interface ArdiaFaviconEntry : NSObject {
 @public
  NSData *_png;
  NSString *_revision;
  uint64_t _used;
}
@end

@implementation ArdiaFaviconEntry
@end

@interface ArdiaFaviconSession () {
 @public
  NSString *_name;
  NSString *_profile;
  NSString *_token;
  NSString *_snapshotPath;
  bool _private;
  bool _dead;
  bool _ready;
  uint64_t _epoch;
  uint64_t _clock;
  NSUInteger _bytes;
  NSMutableDictionary<NSString *, ArdiaFaviconEntry *> *_memory;
  NSMutableDictionary<NSString *, NSMutableArray *> *_waiting;
  NSMutableArray<NSArray *> *_early;
  NSHashTable *_tabs;
  NSCache<NSString *, id> *_derived;
}
@end

@implementation ArdiaFaviconSession

- (NSString *)profile {
  return _profile;
}

- (NSString *)token {
  return _token;
}

- (BOOL)isPrivate {
  return _private;
}

@end

@interface ArdiaFaviconDelivery () {
 @public
  ArdiaFaviconSession *_session;
  NSData *_png;
}
@end

namespace ardia_favicons {

namespace {

os_unfair_lock gLock = OS_UNFAIR_LOCK_INIT;
Limits gLimits;
Counts gCounts;
Resolver gResolver;

struct Locked {
  Locked() { os_unfair_lock_lock(&gLock); }
  ~Locked() { os_unfair_lock_unlock(&gLock); }
};

NSMutableDictionary<NSString *, ArdiaFaviconSession *> *ByName() {
  static NSMutableDictionary *sessions = [NSMutableDictionary dictionary];
  return sessions;
}

NSMutableDictionary<NSString *, ArdiaFaviconSession *> *ByToken() {
  static NSMutableDictionary *sessions = [NSMutableDictionary dictionary];
  return sessions;
}

NSMutableSet<NSString *> *Retired() {
  static NSMutableSet *retired = [NSMutableSet set];
  return retired;
}

dispatch_queue_t SnapshotQueue() {
  static dispatch_queue_t queue = dispatch_queue_create("com.ardia.favicons.snapshot", dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INITIATED, 0));
  return queue;
}

NSString *NewToken() {
  uint8_t bytes[kTokenLength / 2];
  if (SecRandomCopyBytes(kSecRandomDefault, sizeof bytes, bytes) != errSecSuccess) arc4random_buf(bytes, sizeof bytes);
  return Hex(bytes, sizeof bytes);
}

NSString *SlotOf(Kind kind, NSString *key) {
  return [NSString stringWithFormat:@"%@/%@", KindName(kind), Encoded(key)];
}

ArdiaFaviconSession *LiveLocked(NSString *token) {
  ArdiaFaviconSession *session = token ? ByToken()[token] : nil;
  return session && !session->_dead ? session : nil;
}

void TrimLocked(ArdiaFaviconSession *session) {
  const NSUInteger cap = session->_private ? gLimits.privateBytes : gLimits.regularBytes;
  if (session->_bytes <= cap) return;
  NSArray<NSString *> *oldestFirst = [session->_memory keysSortedByValueUsingComparator:^NSComparisonResult(ArdiaFaviconEntry *a, ArdiaFaviconEntry *b) {
    return a->_used < b->_used ? NSOrderedAscending : a->_used > b->_used ? NSOrderedDescending : NSOrderedSame;
  }];
  for (NSString *slot in oldestFirst) {
    if (session->_bytes <= cap - cap / 10) break;
    session->_bytes -= session->_memory[slot]->_png.length;
    [session->_memory removeObjectForKey:slot];
  }
}

void InsertLocked(ArdiaFaviconSession *session, NSString *slot, NSData *png, NSString *revision) {
  ArdiaFaviconEntry *entry = session->_memory[slot];
  if (entry) session->_bytes -= entry->_png.length;
  else session->_memory[slot] = entry = [ArdiaFaviconEntry new];
  entry->_png = png;
  entry->_revision = revision;
  entry->_used = ++session->_clock;
  session->_bytes += png.length;
  TrimLocked(session);
}

ArdiaFaviconDelivery *DeliveryLocked(ArdiaFaviconSession *session, NSData *png) {
  ArdiaFaviconDelivery *delivery = [ArdiaFaviconDelivery new];
  delivery->_session = session;
  delivery->_png = png;
  return delivery;
}

NSArray *ClearLocked(ArdiaFaviconSession *session) {
  session->_epoch++;
  session->_bytes = 0;
  [session->_memory removeAllObjects];
  [session->_derived removeAllObjects];
  NSMutableArray *waiters = [NSMutableArray array];
  for (NSArray *waiting in session->_waiting.allValues) [waiters addObjectsFromArray:waiting];
  [session->_waiting removeAllObjects];
  for (NSArray *early in session->_early) [waiters addObject:early[1]];
  [session->_early removeAllObjects];
  return waiters;
}

void Fail(NSArray *waiters) {
  for (void (^waiter)(ArdiaFaviconDelivery *) in waiters) waiter(nil);
}

void RemoveSnapshot(NSString *path) {
  if (path) dispatch_async(SnapshotQueue(), ^{
    [NSFileManager.defaultManager removeItemAtPath:path error:nil];
  });
}

NSArray<NSDictionary *> *ReadSnapshot(NSString *path) {
  NSData *data = [NSData dataWithContentsOfFile:path];
  id list = data ? [NSPropertyListSerialization propertyListWithData:data options:NSPropertyListImmutable format:nullptr error:nil] : nil;
  NSMutableArray *entries = [NSMutableArray array];
  if (![list isKindOfClass:NSArray.class]) return entries;
  for (NSDictionary *entry in list) {
    if (entries.count >= gLimits.snapshotIcons) break;
    if (![entry isKindOfClass:NSDictionary.class] || ![entry[@"a"] isKindOfClass:NSString.class] || !LooksLikePNG(entry[@"d"])) continue;
    [entries addObject:entry];
  }
  return entries;
}

void LoadSnapshot(ArdiaFaviconSession *session) {
  NSString *path = session->_snapshotPath;
  const uint64_t epoch = EpochOf(session);
  dispatch_async(SnapshotQueue(), ^{
    NSArray<NSDictionary *> *entries = path ? ReadSnapshot(path) : @[];
    NSMutableArray *parsed = [NSMutableArray arrayWithCapacity:entries.count];
    for (NSDictionary *entry in entries) {
      NSString *revision = RevisionOf(entry[@"d"]);
      const Address address = ParseAddress([NSString stringWithFormat:@"%@%@/%@?v=%@", Prefix(), session->_token, entry[@"a"], revision]);
      if (address.key) [parsed addObject:@[ SlotOf(address.kind, address.key), entry[@"d"], revision ]];
    }
    NSArray<NSArray *> *early;
    {
      Locked lock;
      session->_ready = true;
      early = [session->_early copy];
      [session->_early removeAllObjects];
      if (session->_dead || session->_epoch != epoch) parsed = nil;
      for (NSArray *entry in parsed) InsertLocked(session, entry[0], entry[1], entry[2]);
      gCounts.snapshot += parsed.count;
    }
    for (NSArray *waiting in early) Load(waiting[0], waiting[1]);
  });
}

}

void SetLimits(const Limits &limits) {
  Locked lock;
  gLimits = limits;
}

void SetResolver(Resolver resolver) {
  Locked lock;
  gResolver = [resolver copy];
}

ArdiaFaviconSession *Open(NSString *name, NSString *profile, bool isPrivate, NSString *snapshotPath) {
  ArdiaFaviconSession *session;
  {
    Locked lock;
    if ([Retired() containsObject:name]) return nil;
    if (ArdiaFaviconSession *open = ByName()[name]) return open;
    session = [ArdiaFaviconSession new];
    session->_name = [name copy];
    session->_profile = [profile copy];
    session->_token = NewToken();
    session->_private = isPrivate;
    session->_snapshotPath = isPrivate ? nil : [snapshotPath copy];
    session->_ready = !session->_snapshotPath;
    session->_memory = [NSMutableDictionary dictionary];
    session->_waiting = [NSMutableDictionary dictionary];
    session->_early = [NSMutableArray array];
    session->_tabs = [NSHashTable weakObjectsHashTable];
    session->_derived = [NSCache new];
    session->_derived.countLimit = 512;
    ByName()[name] = session;
    ByToken()[session->_token] = session;
  }
  if (!session->_ready) LoadSnapshot(session);
  return session;
}

uint64_t EpochOf(ArdiaFaviconSession *session) {
  Locked lock;
  return session ? session->_epoch : 0;
}

bool Decodes(NSData *png) {
  if (!LooksLikePNG(png)) return false;
  CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)png, nullptr);
  if (!source) return false;
  bool ok = CGImageSourceGetStatus(source) == kCGImageStatusComplete && CGImageSourceGetCount(source) >= 1;
  if (ok) {
    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, nullptr);
    ok = image && CGImageGetWidth(image) >= 1 && CGImageGetHeight(image) >= 1;
    if (image) CGImageRelease(image);
  }
  CFRelease(source);
  return ok;
}

NSString *Keep(ArdiaFaviconSession *session, uint64_t epoch, Kind kind, NSString *key, NSData *png) {
  if (!session || !Addressable(kind, key) || !Decodes(png)) return nil;
  NSString *revision = RevisionOf(png);
  Locked lock;
  if (session->_dead || session->_epoch != epoch) {
    gCounts.refused++;
    return nil;
  }
  gCounts.kept++;
  InsertLocked(session, SlotOf(kind, key), png, revision);
  return AddressOf(session->_token, kind, key, revision);
}

bool Owns(ArdiaFaviconSession *session, NSString *address) {
  const Address parsed = ParseAddress(address);
  Locked lock;
  return session && parsed.key && !session->_dead && [parsed.token isEqualToString:session->_token];
}

void Load(NSString *address, void (^done)(ArdiaFaviconDelivery *)) {
  const Address parsed = ParseAddress(address);
  NSString *slot = parsed.key ? SlotOf(parsed.kind, parsed.key) : nil;
  ArdiaFaviconSession *session;
  ArdiaFaviconDelivery *ready = nil;
  Resolver resolver;
  uint64_t epoch = 0;
  {
    Locked lock;
    session = LiveLocked(parsed.token);
    if (session && !session->_ready) return (void)[session->_early addObject:@[ address, [done copy] ]];
    ArdiaFaviconEntry *entry = session ? session->_memory[slot] : nil;
    if (entry) {
      entry->_used = ++session->_clock;
      gCounts.memory++;
      ready = DeliveryLocked(session, entry->_png);
    } else if (session && gResolver) {
      if (NSMutableArray *waiting = session->_waiting[slot]) return (void)[waiting addObject:[done copy]];
      session->_waiting[slot] = [NSMutableArray arrayWithObject:[done copy]];
      resolver = gResolver;
      epoch = session->_epoch;
    } else {
      gCounts.missed++;
    }
  }
  if (!resolver) return done(ready);
  resolver(session, parsed.kind, parsed.key, ^(NSData *png) {
    const bool valid = Decodes(png);
    NSString *revision = valid ? RevisionOf(png) : nil;
    NSArray *waiters;
    ArdiaFaviconDelivery *delivery = nil;
    {
      Locked lock;
      waiters = [session->_waiting[slot] copy];
      [session->_waiting removeObjectForKey:slot];
      if (valid && !session->_dead) {
        if (session->_epoch == epoch) InsertLocked(session, slot, png, revision);
        delivery = DeliveryLocked(session, png);
        gCounts.resolved++;
      } else {
        gCounts.missed++;
      }
    }
    for (void (^waiter)(ArdiaFaviconDelivery *) in waiters) waiter(delivery);
  });
}

NSData *Held(NSString *address) {
  const Address parsed = ParseAddress(address);
  Locked lock;
  ArdiaFaviconSession *session = LiveLocked(parsed.token);
  ArdiaFaviconEntry *entry = session && parsed.key ? session->_memory[SlotOf(parsed.kind, parsed.key)] : nil;
  if (!entry) return nil;
  entry->_used = ++session->_clock;
  return entry->_png;
}

id Derived(NSString *address, NSString *kind) {
  const Address parsed = ParseAddress(address);
  Locked lock;
  ArdiaFaviconSession *session = LiveLocked(parsed.token);
  return session && parsed.key ? [session->_derived objectForKey:[kind stringByAppendingString:address]] : nil;
}

void SetDerived(NSString *address, NSString *kind, id object) {
  const Address parsed = ParseAddress(address);
  Locked lock;
  ArdiaFaviconSession *session = LiveLocked(parsed.token);
  if (session && parsed.key && object) [session->_derived setObject:object forKey:[kind stringByAppendingString:address]];
}

void NoteTab(ArdiaFaviconSession *session, id tab) {
  Locked lock;
  if (session && tab && !session->_dead) [session->_tabs addObject:tab];
}

NSArray *Tabs(ArdiaFaviconSession *session) {
  Locked lock;
  return session && !session->_dead ? session->_tabs.allObjects : @[];
}

void Forget(ArdiaFaviconSession *session) {
  if (!session) return;
  NSArray *waiters;
  {
    Locked lock;
    if (session->_dead) return;
    waiters = ClearLocked(session);
  }
  Fail(waiters);
  RemoveSnapshot(session->_snapshotPath);
}

void Retire(NSString *name) {
  NSArray *waiters;
  ArdiaFaviconSession *session;
  {
    Locked lock;
    [Retired() addObject:name];
    session = ByName()[name];
    if (!session) return;
    waiters = ClearLocked(session);
    session->_dead = true;
    [session->_tabs removeAllObjects];
    [ByName() removeObjectForKey:name];
    [ByToken() removeObjectForKey:session->_token];
  }
  Fail(waiters);
}

void Restore(NSString *name) {
  Locked lock;
  [Retired() removeObject:name];
}

NSArray<NSString *> *SaveSnapshot(ArdiaFaviconSession *session, NSArray<NSString *> *addresses) {
  NSString *path = session ? session->_snapshotPath : nil;
  if (!path) return @[];
  NSMutableArray<NSDictionary *> *entries = [NSMutableArray array];
  NSMutableArray<NSString *> *saved = [NSMutableArray array];
  {
    Locked lock;
    if (session->_dead) return @[];
    NSUInteger bytes = 0;
    NSMutableSet<NSString *> *taken = [NSMutableSet set];
    for (NSString *address in addresses) {
      const Address parsed = ParseAddress(address);
      if (!parsed.key || ![parsed.token isEqualToString:session->_token]) continue;
      NSString *slot = SlotOf(parsed.kind, parsed.key);
      ArdiaFaviconEntry *entry = session->_memory[slot];
      if ([taken containsObject:slot]) [saved addObject:address];
      if (!entry || [taken containsObject:slot] || entries.count >= gLimits.snapshotIcons || bytes + entry->_png.length > gLimits.snapshotBytes) continue;
      bytes += entry->_png.length;
      [saved addObject:address];
      [taken addObject:slot];
      [entries addObject:@{@"a" : slot, @"d" : entry->_png}];
    }
  }
  __block bool written = false;
  dispatch_sync(SnapshotQueue(), ^{
    NSFileManager *files = NSFileManager.defaultManager;
    BOOL folder = NO;
    if (![files fileExistsAtPath:path.stringByDeletingLastPathComponent isDirectory:&folder] || !folder) return;
    if (!entries.count) return (void)[files removeItemAtPath:path error:nil];
    NSData *data = [NSPropertyListSerialization dataWithPropertyList:entries format:NSPropertyListBinaryFormat_v1_0 options:0 error:nil];
    written = data && [data writeToFile:path options:NSDataWritingAtomic error:nil];
    if (written) [files setAttributes:@{NSFilePosixPermissions : @0600} ofItemAtPath:path error:nil];
  });
  return written ? saved : @[];
}

void WaitForSnapshot() {
  dispatch_sync(SnapshotQueue(), ^{
                });
}

Counts TakeCounts() {
  Locked lock;
  const Counts counts = gCounts;
  gCounts = {};
  return counts;
}

}

@implementation ArdiaFaviconDelivery

- (BOOL)deliver:(void (NS_NOESCAPE ^)(NSData *))hand {
  ardia_favicons::Locked lock;
  if (_session->_dead) return NO;
  hand(_png);
  return YES;
}

@end
