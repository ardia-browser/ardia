#ifndef ARDIA_LINUX_AC_LINUX_TAB_SLEEP_H_
#define ARDIA_LINUX_AC_LINUX_TAB_SLEEP_H_

#include <optional>

#include "base/values.h"

namespace content {
class WebContents;
}

namespace ardiacore {

inline constexpr int kLinuxSleepUnavailable = -1;
inline constexpr int kLinuxKeptByPostedDocument = 100;
inline constexpr int kLinuxKeptByBeforeUnload = 101;
inline constexpr int kLinuxKeptByDownload = 102;
inline constexpr int kLinuxSleptPastSoftKeeps = 200;
inline constexpr double kLinuxSleepLongestHiddenSeconds = 7 * 24 * 60 * 60;

struct LinuxTabKeptAwake {
  bool posted_document = false;
  bool before_unload = false;
  bool download = false;
};

std::optional<double> ParseLinuxSleepSeconds(const base::ListValue& args);
base::ListValue SleepLinuxTabIfHidden(content::WebContents* contents, double seconds, const LinuxTabKeptAwake& kept_awake = {});
base::ListValue SleepLinuxTabIfUnused(content::WebContents* contents, double seconds, const LinuxTabKeptAwake& kept_awake);

}

#endif
