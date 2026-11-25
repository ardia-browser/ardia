#import <Foundation/Foundation.h>

#include <sys/types.h>

NS_ASSUME_NONNULL_BEGIN

namespace ardia_files {

constexpr NSUInteger kMaxPathBytes = 1024;
constexpr NSUInteger kMaxNameBytes = 255;

NSString *AppDataRoot(NSString *_Nullable custom, NSString *_Nullable bundleId);
NSString *_Nullable ChosenPath(id _Nullable path, NSString *_Nullable *_Nonnull reason);
NSString *_Nullable DownloadTarget(id _Nullable path, BOOL *folder, NSString *_Nullable *_Nonnull reason);
NSString *_Nullable FreePathIn(NSString *folder, NSString *_Nullable name, NSString *_Nullable *_Nonnull reason);
NSString *SafeFileName(NSString *_Nullable name);
bool StillFree(NSString *target, NSString *_Nullable *_Nonnull reason);
NSString *_Nullable StageUpload(NSString *canonical, NSString *dir, NSString *_Nullable *_Nonnull reason);
NSString *_Nullable MakeStagingFolder(NSString *folder, NSString *tag, NSString *_Nullable *_Nonnull reason);
NSString *_Nullable PlanStaging(NSString *folder, NSString *tag, NSString *name, NSString *_Nullable fallbackRoot, NSString *_Nullable *_Nonnull stagedName,
                                NSString *_Nullable *_Nonnull reason);
bool RemoveIfSame(NSString *path, dev_t device, ino_t inode, NSString *_Nullable *_Nullable recoveryPath, void (^_Nullable beforeRestore)(void) = nil);
NSDictionary<NSString *, id> *PlaceFile(NSString *source, NSString *target);

}

NS_ASSUME_NONNULL_END
