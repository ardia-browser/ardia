#ifndef ARDIA_WIN_WEBUI_WEBUI_LAUNCH_STEPS_H_
#define ARDIA_WIN_WEBUI_WEBUI_LAUNCH_STEPS_H_

#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace ardia_win::webui_window {

inline constexpr std::string_view kLaunchSteps[] = {
    "version",      "versionUpdated",      "onboarding",
    "releaseNotes", "defaultBrowserOffer", "telemetry",
};

inline bool ValidLaunchStep(std::string_view step) {
  for (const std::string_view known : kLaunchSteps) {
    if (step == known) {
      return true;
    }
  }
  return false;
}

class LaunchSteps {
 public:
  bool Complete(std::string_view step) {
    return ValidLaunchStep(step) && done_.emplace(step).second;
  }
  bool Done(std::string_view step) const {
    return done_.contains(std::string(step));
  }
  std::vector<std::string> List() const {
    return {done_.begin(), done_.end()};
  }

 private:
  std::set<std::string> done_;
};

}

#endif
