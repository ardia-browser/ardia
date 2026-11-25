#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

namespace ardia_files {

void NoteDownloadEvent(NSDictionary *_Nullable event, NSTimeInterval now);
bool AwaitingDownloadTarget(NSTimeInterval now, NSString *_Nullable profile);
bool TakeDownloadTarget(NSTimeInterval now, NSString *_Nullable profile, double startedNoEarlierThanMs);
NSInteger TakeDownloadTargetForArms(NSTimeInterval now, NSString *_Nullable profile, NSArray<NSNumber *> *armedAtMsInPriorityOrder);
bool LooksLikeDownloadPicker(bool awaitingTarget, NSString *_Nullable message, bool hasAccessoryView);
void ForgetDownloadPrompts();

}

NS_ASSUME_NONNULL_END
