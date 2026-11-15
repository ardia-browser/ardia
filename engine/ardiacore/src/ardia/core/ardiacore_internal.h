#ifndef ARDIA_CORE_ARDIACORE_INTERNAL_H_
#define ARDIA_CORE_ARDIACORE_INTERNAL_H_

#import "ardia/core/public/ArdiaCore.h"

class Profile;

namespace base {
class FilePath;
}

namespace content {
class WebContents;
}

namespace ardiacore {
class WindowHost;

void NoteProfileDying(Profile* profile);
bool IsProfileDying(const Profile* profile);
Profile* DyingProfileAt(const base::FilePath& path);
void NoteProfileDeleting(Profile* profile);
bool IsProfileDeleting(const Profile* profile);
}

@interface ArdiaCoreProfile ()
+ (ArdiaCoreProfile*)wrapperFor:(Profile*)profile;
@property(readonly) Profile* chromeProfile;
@end

@interface ArdiaCoreTab ()
- (instancetype)initWithContents:(content::WebContents*)contents;
@property(readonly) content::WebContents* contents;
- (void)contentsDestroyed;
- (void)notify:(SEL)selector;
@end

@interface ArdiaCoreWindow ()
@property(readonly) ardiacore::WindowHost* host;
@end

#endif
