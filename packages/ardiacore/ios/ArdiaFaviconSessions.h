#import <Foundation/Foundation.h>

#import "ArdiaFaviconAddress.h"

NS_ASSUME_NONNULL_BEGIN

@interface ArdiaFaviconSession : NSObject
@property(nonatomic, readonly) NSString *profile;
@property(nonatomic, readonly) NSString *token;
@property(nonatomic, readonly) BOOL isPrivate;
@end

@interface ArdiaFaviconDelivery : NSObject
- (BOOL)deliver:(void (NS_NOESCAPE ^)(NSData *png))hand;
@end

namespace ardia_favicons {

struct Limits {
  NSUInteger regularBytes = 8 * 1024 * 1024;
  NSUInteger privateBytes = 2 * 1024 * 1024;
  NSUInteger snapshotIcons = 400;
  NSUInteger snapshotBytes = 4 * 1024 * 1024;
};

struct Counts {
  long memory = 0;
  long resolved = 0;
  long missed = 0;
  long kept = 0;
  long refused = 0;
  long snapshot = 0;
};

typedef void (^Resolved)(NSData *_Nullable png);
typedef void (^Resolver)(ArdiaFaviconSession *session, Kind kind, NSString *key, Resolved done);

void SetLimits(const Limits &limits);
void SetResolver(Resolver _Nullable resolver);

ArdiaFaviconSession *_Nullable Open(NSString *name, NSString *profile, bool isPrivate, NSString *_Nullable snapshotPath);
uint64_t EpochOf(ArdiaFaviconSession *_Nullable session);
bool Decodes(NSData *_Nullable png);
NSString *_Nullable Keep(ArdiaFaviconSession *_Nullable session, uint64_t epoch, Kind kind, NSString *key, NSData *_Nullable png);
bool Owns(ArdiaFaviconSession *_Nullable session, NSString *_Nullable address);
void Load(NSString *_Nullable address, void (^done)(ArdiaFaviconDelivery *_Nullable delivery));
NSData *_Nullable Held(NSString *_Nullable address);
id _Nullable Derived(NSString *_Nullable address, NSString *kind);
void SetDerived(NSString *_Nullable address, NSString *kind, id object);
void NoteTab(ArdiaFaviconSession *_Nullable session, id tab);
NSArray *Tabs(ArdiaFaviconSession *_Nullable session);
void Forget(ArdiaFaviconSession *_Nullable session);
void Retire(NSString *name);
void Restore(NSString *name);
NSArray<NSString *> *SaveSnapshot(ArdiaFaviconSession *_Nullable session, NSArray<NSString *> *addresses);
void WaitForSnapshot();
Counts TakeCounts();

}

NS_ASSUME_NONNULL_END
