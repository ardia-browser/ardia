#import <AppKit/AppKit.h>

#include <os/lock.h>

NS_ASSUME_NONNULL_BEGIN

@interface ArdiaFileArm : NSObject
@property(nonatomic, copy) NSString *armId;
@property(nonatomic, copy) NSString *kind;
@property(nonatomic, copy, nullable) NSString *tabId;
@property(nonatomic, copy, nullable) NSString *windowId;
@property(nonatomic, copy) NSArray<NSString *> *paths;
@property(nonatomic, copy) NSArray<NSString *> *staged;
@property(nonatomic, copy, nullable) NSString *uploadFolder;
@property(nonatomic) BOOL folder;
@property(nonatomic) BOOL once;
@property(nonatomic) NSTimeInterval armedAt;
@property(nonatomic) NSTimeInterval expiresAt;
@property(nonatomic, copy) NSString *state;
@property(nonatomic, copy, nullable) NSString *reason;
@property(nonatomic, copy) NSArray<NSString *> *landed;
@property(nonatomic, strong) NSMutableArray<NSString *> *stagingFolders;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSString *> *claims;
@property(nonatomic) NSInteger answered;
@property(nonatomic) NSTimeInterval lastAnsweredAt;
@property(nonatomic) NSUInteger pendingHandoffs;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSString *> *stagedNames;
@end

NS_ASSUME_NONNULL_END

NS_ASSUME_NONNULL_BEGIN

namespace ardia_host::file_arms {

extern os_unfair_lock gLock;

template <typename Work>
auto Locked(Work work) -> decltype(work()) {
  os_unfair_lock_lock(&gLock);
  struct Unlock {
    ~Unlock() { os_unfair_lock_unlock(&gLock); }
  } unlock;
  return work();
}

NSMutableArray<ArdiaFileArm *> *Arms();
NSTimeInterval Now();
bool Active(ArdiaFileArm *arm);
NSMutableArray<NSString *> *SweepLocked();
void PurgeAll(NSArray<NSString *> *folders);
ArdiaFileArm *_Nullable ArmNamed(NSString *armId);
NSDictionary *Refused(NSString *reason, NSString *_Nullable path);
bool InStagingLocked(ArdiaFileArm *arm, NSString *path);

}

NS_ASSUME_NONNULL_END
