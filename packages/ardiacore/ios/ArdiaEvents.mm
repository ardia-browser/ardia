#import "ArdiaEvents.h"
#import "ArdiaDownloadMover.h"

#import <os/lock.h>

namespace {

os_unfair_lock gConsentEpochLock = OS_UNFAIR_LOCK_INIT;
NSString *gConsentEpoch = @"";

NSMutableDictionary<NSString *, void (^)(NSString *, NSDictionary *)> *Senders() {
  static NSMutableDictionary *senders = [NSMutableDictionary dictionary];
  return senders;
}

NSString *DomainOf(NSString *name) {
  const NSRange dot = [name rangeOfString:@"."];
  return dot.location == NSNotFound ? name : [name substringToIndex:dot.location];
}

}

@implementation ArdiaEvents

+ (void)setSender:(void (^)(NSString *, NSDictionary *))sender forDomain:(NSString *)domain {
  Senders()[domain] = [sender copy];
}

+ (BOOL)listens:(NSString *)domain {
  return Senders()[domain] != nil;
}

+ (void)emit:(NSString *)name data:(NSDictionary *)data {
  if ([name isEqualToString:@"downloads.changed"] && data) data = [ArdiaDownloadMover.shared noteDownloadEvent:data];
  if (void (^sender)(NSString *, NSDictionary *) = Senders()[DomainOf(name)]) sender(name, data ?: @{});
}

+ (NSString *)consentEpoch {
  os_unfair_lock_lock(&gConsentEpochLock);
  NSString *epoch = gConsentEpoch;
  os_unfair_lock_unlock(&gConsentEpochLock);
  return epoch;
}

+ (void)setConsentEpoch:(NSString *)epoch {
  NSString *copied = [epoch copy] ?: @"";
  os_unfair_lock_lock(&gConsentEpochLock);
  gConsentEpoch = copied;
  os_unfair_lock_unlock(&gConsentEpochLock);
}

@end

@implementation ArdiaConsentStamp

+ (instancetype)begin {
  return [[self alloc] initWithEpoch:ArdiaEvents.consentEpoch];
}

- (instancetype)initWithEpoch:(NSString *)epoch {
  if ((self = [super init])) _epoch = [epoch copy] ?: @"";
  return self;
}

- (NSDictionary<NSString *, id> *)onto:(NSDictionary<NSString *, id> *)payload {
  NSMutableDictionary *stamped = [payload mutableCopy] ?: [NSMutableDictionary dictionary];
  stamped[@"epoch"] = _epoch;
  return stamped;
}

@end
