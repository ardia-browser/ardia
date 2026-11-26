#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

namespace ardia_files {

constexpr NSTimeInterval kKeepEndedArmSeconds = 600;
constexpr NSTimeInterval kKeepHandoffSeconds = 3600;

struct ArmLife {
  bool active;
  bool hasCopies;
  NSUInteger claims;
  NSUInteger stagingFolders;
  NSUInteger pendingHandoffs;
  NSTimeInterval endedAt;
  NSTimeInterval lastAnsweredAt;
};

bool MayForgetArm(const ArmLife &life, bool forRoom, NSTimeInterval now);

void KeepCopiesUntil(NSString *folder, NSTimeInterval deadline);
void ForgetCopies(NSString *folder);
NSUInteger SweepExpiredCopies(NSTimeInterval now);

}

NS_ASSUME_NONNULL_END
