#ifndef ARDIA_LINUX_AC_LINUX_IDLE_PROFILE_ENGINE_H_
#define ARDIA_LINUX_AC_LINUX_IDLE_PROFILE_ENGINE_H_

#include <optional>
#include <string>

class Profile;

namespace content {
class WebContents;
}

namespace ardiacore {

bool LinuxTabSleepsOrCanSleep(content::WebContents* contents, bool sleep);
std::optional<std::string> LinuxProfileHeldOpenBy(Profile* profile);
std::string ReleaseLinuxIdleProfile(Profile* profile);

}

#endif
